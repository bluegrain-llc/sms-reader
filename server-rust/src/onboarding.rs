//! Version 3 uses the same collections, fields and JWE profile as the TypeScript runtime.
use crate::{
    error::{Error, Result, ensure},
    model::*,
    relay::Relay,
    store::{Query, Tx},
};
use josekit::{
    jwe::{self, ECDH_ES, JweHeader},
    jwk::Jwk,
};
use serde_json::{Value, json};
use uuid::Uuid;
pub const FOREVER: i64 = 8_640_000_000_000_000;
pub fn capability(g: &Value, cap: &str) -> bool {
    if let Some(a) = g.get("capabilities").and_then(Value::as_array) {
        a.iter().any(|v| v == cap)
    } else {
        cap == "sms" || flag(g, "formsApproved")
    }
}
pub(crate) fn caps(v: &Value) -> Result<()> {
    let a = v.as_array().ok_or(Error::Api(400, "invalid_input"))?;
    ensure(
        !a.is_empty()
            && a.len() <= 2
            && a.iter().all(|c| c == "forms" || c == "sms")
            && (a.len() != 2 || a[0] != a[1]),
        400,
        "invalid_input",
    )
}
fn days(v: &Value) -> Result<()> {
    ensure(
        v.is_null() || v.as_i64().is_some_and(|n| (1..=365).contains(&n)),
        400,
        "invalid_input",
    )
}
fn key(v: &Value) -> Result<Jwk> {
    strict(v, &["kty", "crv", "x", "y"])?;
    ensure(
        v["kty"] == "EC" && v["crv"] == "P-256",
        400,
        "invalid_input",
    )?;
    for p in ["x", "y"] {
        ensure(
            regex(r"^[A-Za-z0-9_-]{43}$", text(v, p)),
            400,
            "invalid_input",
        )?;
    }
    let jwk =
        Jwk::from_bytes(v.to_string()).map_err(|_| Error::Api(400, "invalid_delivery_key"))?;
    ECDH_ES
        .encrypter_from_jwk(&jwk)
        .map_err(|_| Error::Api(400, "invalid_delivery_key"))?;
    Ok(jwk)
}
pub fn key_id(v: &Value) -> String {
    hash(&json!({"kty":v["kty"],"crv":v["crv"],"x":v["x"],"y":v["y"]}).to_string())
}
fn select(
    requested: &Value,
    selected: &Value,
    requested_days: &Value,
    selected_days: &Value,
) -> Result<()> {
    caps(selected)?;
    days(selected_days)?;
    ensure(
        selected
            .as_array()
            .unwrap()
            .iter()
            .all(|c| requested.as_array().unwrap().contains(c)),
        400,
        "capability_not_requested",
    )?;
    ensure(
        requested_days.is_null()
            || (!selected_days.is_null() && selected_days.as_i64() <= requested_days.as_i64()),
        400,
        "duration_not_requested",
    )
}
fn service_view(s: &Value) -> Value {
    json!({"serviceId":s["id"],"name":s["name"],"purpose":s["purpose"],"capabilities":s["capabilities"],"active":flag(s,"active")&&!flag(s,"deleted"),"deliveryKeyId":s["deliveryKeyId"],"nameIsOperatorSupplied":true,"servicePath":format!("/services/{}",text(s,"id"))})
}
fn status(p: &Value, now: i64) -> Value {
    if p["status"] == "pending" && num(p, "expiresAt") <= now {
        json!("expired")
    } else {
        p["status"].clone()
    }
}
fn registration_view(p: &Value, now: i64) -> Value {
    json!({"sessionId":p["id"],"serviceId":p["serviceId"],"name":p["name"],"purpose":p["purpose"],"capabilities":p["capabilities"],"status":status(p,now),"expiresAt":p["expiresAt"],"connectionId":p["connectionId"],"registrationPath":format!("/register/{}",text(p,"id")),"servicePath":format!("/services/{}",text(p,"serviceId")),"interval":5})
}
fn session_view(p: &Value, s: &Value, now: i64) -> Value {
    json!({"sessionId":p["id"],"serviceId":s["id"],"name":s["name"],"purpose":s["purpose"],"nameIsOperatorSupplied":true,"capabilities":p["capabilities"],"expiresInDays":p["expiresInDays"],"expiresAt":p["expiresAt"],"comparisonCode":p["comparisonCode"],"status":status(p,now),"connectionId":p["connectionId"],"connectionPath":format!("/pair/{}",text(p,"id")),"interval":5})
}
impl Relay {
    pub async fn active_service(&self, tx: &Tx, id: &str) -> Result<Value> {
        let s = tx.get("services", id).await?;
        ensure(
            !s.is_null() && flag(&s, "active") && !flag(&s, "deleted"),
            404,
            "service_unavailable",
        )?;
        self.account(tx, text(&s, "ownerId")).await?;
        Ok(s)
    }
    pub async fn service_auth(&self, tx: &Tx, token: &str) -> Result<Value> {
        ensure(
            regex(r"^smss_[A-Za-z0-9_-]{43}$", token),
            401,
            "invalid_service_credential",
        )?;
        let credential = hash(token);
        let c = tx.get("serviceCredentials", &credential).await?;
        ensure(!c.is_null(), 401, "invalid_service_credential")?;
        let s = self.active_service(tx, text(&c, "serviceId")).await?;
        ensure(
            s["credentialHash"] == credential,
            401,
            "invalid_service_credential",
        )?;
        Ok(s)
    }
    pub(crate) async fn onboarding_rate(
        &self,
        tx: &Tx,
        scope: &str,
        max: i64,
    ) -> Result<(String, Value)> {
        let window = self.now() / (10 * MINUTE);
        let id = hash_js(&format!("{scope}:{window}"));
        let old = tx.get("onboardingRates", &id).await?;
        let mut value = bump(
            &if old.is_null() {
                json!({"start":self.now(),"count":0})
            } else {
                old
            },
            self.now(),
            max,
        )?;
        value["purgeAt"] = json!((window + 1) * 10 * MINUTE);
        Ok((id, value))
    }
    async fn prepare_connection(
        &self,
        tx: &Tx,
        uid: &str,
        s: &Value,
        public_key: &Value,
        capabilities: &Value,
        duration_and_binding: (&Value, &Value),
    ) -> Result<(String, Vec<(&'static str, String, Value)>)> {
        let (days, external) = duration_and_binding;
        let binding_id = hash(&js_json(&json!([uid, s["id"], external]), false));
        let binding = tx.get("connectionBindings", &binding_id).await?;
        let mut old = if binding.is_null() {
            Value::Null
        } else {
            tx.get("grants", text(&binding, "grantId")).await?
        };
        let expiry = if days.is_null() {
            FOREVER
        } else {
            self.now() + days.as_i64().unwrap() * DAY
        };
        if self.valid_grant(tx, &old).await? {
            old["capabilities"] = capabilities.clone();
            old["formsApproved"] =
                json!(capabilities.as_array().unwrap().contains(&json!("forms")));
            old["expiresAt"] = json!(expiry);
            return Ok((
                text(&old, "connectionId").into(),
                vec![("grants", text(&old, "id").into(), old)],
            ));
        }
        let token = secret();
        let grant_id = hash(&token);
        let connection_id = Uuid::new_v4().to_string();
        let delivery_id = Uuid::new_v4().to_string();
        let payload = json!({"version":1,"serviceId":s["id"],"connectionId":connection_id,"deliveryId":delivery_id,"token":token,"externalAccountRef":external});
        let mut header = JweHeader::new();
        header.set_algorithm("ECDH-ES");
        header.set_content_encryption("A256GCM");
        header.set_key_id(text(s, "deliveryKeyId"));
        for (k, v) in [
            ("serviceId", s["id"].clone()),
            ("connectionId", json!(connection_id)),
            ("deliveryId", json!(delivery_id)),
        ] {
            header
                .set_claim(k, Some(v))
                .map_err(|_| Error::Api(500, "encryption_failed"))?;
        }
        let encrypter = ECDH_ES
            .encrypter_from_jwk(&key(public_key)?)
            .map_err(|_| Error::Api(400, "invalid_delivery_key"))?;
        let envelope = jwe::serialize_compact(payload.to_string().as_bytes(), &header, &encrypter)
            .map_err(|_| Error::Api(500, "encryption_failed"))?;
        let grant = json!({"id":grant_id,"connectionId":connection_id,"serviceId":s["id"],"ownerId":uid,"deviceId":"","callerId":s["id"],"callerName":s["name"],"capabilities":capabilities,"formsApproved":capabilities.as_array().unwrap().contains(&json!("forms")),"revoked":false,"createdAt":self.now(),"expiresAt":expiry,"deliveryId":delivery_id,"deliveryAcknowledged":false,"deliveryExpiresAt":self.now()+HISTORY,"deliveryKeyId":s["deliveryKeyId"],"rate":{"start":self.now(),"count":0}});
        let delivery = json!({"id":delivery_id,"ownerId":uid,"serviceId":s["id"],"connectionId":connection_id,"grantId":grant_id,"keyId":s["deliveryKeyId"],"envelope":envelope,"expiresAt":self.now()+HISTORY,"acknowledged":false,"purgeAt":self.now()+HISTORY});
        Ok((
            connection_id.clone(),
            vec![
                ("grants", grant_id.clone(), grant),
                ("credentialDeliveries", delivery_id, delivery),
                (
                    "connectionBindings",
                    binding_id,
                    json!({"ownerId":uid,"serviceId":s["id"],"grantId":grant_id,"connectionId":connection_id}),
                ),
                (
                    "serviceConnections",
                    connection_id.clone(),
                    json!({"ownerId":uid,"serviceId":s["id"],"grantId":grant_id,"connectionId":connection_id}),
                ),
            ],
        ))
    }
    pub async fn onboarding(
        &self,
        method: String,
        auth: String,
        id: String,
        mut input: Value,
    ) -> Result<Value> {
        // Validate at the boundary; defaults and decoded Unicode code-point lengths match the TS input schemas.
        match method.as_str() {
            "register" | "provision" => {
                strict(
                    &input,
                    &[
                        "name",
                        "purpose",
                        "capabilities",
                        "deliveryPublicKey",
                        "credentialHash",
                    ],
                )?;
                input["name"] = json!(string(&input, "name", 1, 80, true)?);
                input["purpose"] = json!(string(&input, "purpose", 1, 240, true)?);
                if input.get("capabilities").is_none() {
                    input["capabilities"] = json!(["forms"]);
                }
                caps(&input["capabilities"])?;
                key(&input["deliveryPublicKey"])?;
                ensure(
                    regex(r"^[a-f0-9]{64}$", text(&input, "credentialHash")),
                    400,
                    "invalid_input",
                )?;
                ensure(
                    method == "provision" || regex(r"^smsreg_[A-Za-z0-9_-]{43}$", &auth),
                    401,
                    "invalid_registration_credential",
                )?;
            }
            "pairing" | "permanent" => {
                strict(
                    &input,
                    &[
                        "capabilities",
                        "expiresInDays",
                        "externalAccountRef",
                        "idempotencyKey",
                    ],
                )?;
                caps(&input["capabilities"])?;
                if input.get("expiresInDays").is_none() {
                    input["expiresInDays"] = Value::Null;
                }
                days(&input["expiresInDays"])?;
                string(&input, "idempotencyKey", 16, 128, false)?;
                if input.get("externalAccountRef").is_some() {
                    ensure(
                        regex(
                            r"^[A-Za-z0-9_-]{16,128}$",
                            text(&input, "externalAccountRef"),
                        ),
                        400,
                        "invalid_input",
                    )?;
                }
            }
            "registrationDecide" | "pairingDecide" => {
                let mut fields = vec!["decision", "capabilities", "expiresInDays"];
                if method == "registrationDecide" {
                    fields.push("selfAccess");
                    ensure(
                        input.get("selfAccess").is_none() || input["selfAccess"] == false,
                        400,
                        "invalid_input",
                    )?;
                }
                strict(&input, &fields)?;
                ensure(
                    input["decision"] == "approved" || input["decision"] == "denied",
                    400,
                    "invalid_input",
                )?;
                caps(&input["capabilities"])?;
                ensure(input.get("expiresInDays").is_some(), 400, "invalid_input")?;
                days(&input["expiresInDays"])?;
            }
            "manageService" | "rotate" => {
                strict(
                    &input,
                    &[
                        "credentialHash",
                        "deliveryPublicKey",
                        "retireKeyId",
                        "active",
                        "delete",
                    ],
                )?;
                for p in ["credentialHash", "retireKeyId"] {
                    if input.get(p).is_some() {
                        ensure(
                            regex(r"^[a-f0-9]{64}$", text(&input, p)),
                            400,
                            "invalid_input",
                        )?;
                    }
                }
                if input.get("deliveryPublicKey").is_some() {
                    key(&input["deliveryPublicKey"])?;
                }
                if input.get("active").is_some() {
                    ensure(input["active"].is_boolean(), 400, "invalid_input")?;
                }
                if input.get("delete").is_some() {
                    ensure(input["delete"] == true, 400, "invalid_input")?;
                }
            }
            "manageConnection" => {
                strict(&input, &["capabilities", "expiresAt"])?;
                caps(&input["capabilities"])?;
                ensure(
                    input.get("expiresAt").is_some()
                        && (input["expiresAt"].is_null()
                            || input["expiresAt"]
                                .as_i64()
                                .is_some_and(|n| n > 0 && n <= FOREVER)),
                    400,
                    "invalid_input",
                )?;
            }
            _ => {}
        }
        if method == "manageService" || method == "rotate" {
            let (s, a, i, m) = (self.clone(), auth.clone(), id.clone(), method.clone());
            let service = self
                .store
                .tx(move |tx| {
                    let (s, a, i, m) = (s.clone(), a.clone(), i.clone(), m.clone());
                    Box::pin(async move {
                        let v = if m == "rotate" {
                            s.service_auth(tx, &a).await?
                        } else {
                            s.account(tx, &a).await?;
                            tx.get("services", &i).await?
                        };
                        ensure(
                            !v.is_null()
                                && (m == "rotate" || text(&v, "ownerId") == a)
                                && !flag(&v, "deleted"),
                            404,
                            "service_not_found",
                        )?;
                        Ok(v)
                    })
                })
                .await?;
            ensure(
                method != "rotate"
                    || (input.get("active").is_none() && input.get("delete").is_none()),
                403,
                "owner_required",
            )?;
            if input["active"] == false
                || flag(&input, "delete")
                || input.get("retireKeyId").is_some()
                || input.get("credentialHash").is_some()
            {
                self.delivery.security(json!({"ownerId":service["ownerId"],"kind":"service.invalidate","target":service["id"]})).await?;
            }
        }
        if method == "disconnect" || method == "manageConnection" {
            let link = self.store.get("serviceConnections", &id).await?;
            ensure(
                !link.is_null() && text(&link, "ownerId") == auth,
                404,
                "connection_not_found",
            )?;
            if method == "disconnect" {
                self.revoke(auth, text(&link, "grantId").into()).await?;
                return Ok(json!({"ok":true}));
            }
            self.delivery
                .security(json!({"ownerId":auth,"kind":"grant.restrict","target":link["grantId"]}))
                .await?;
        }
        let s = self.clone();
        let random_service_id = Uuid::new_v4().to_string();
        self.store.tx(move|tx|{let(s,method,auth,id,input,random_service_id)=(s.clone(),method.clone(),auth.clone(),id.clone(),input.clone(),random_service_id.clone());Box::pin(async move{
            let now=s.now();
            match method.as_str() {
                "ticketService"=>Ok(service_view(&s.service_auth(tx,&auth).await?)),
                "provision"=>{
                    s.account(tx,&auth).await?;
                    let receipt=tx.get("serviceCredentials",text(&input,"credentialHash")).await?;
                    if !receipt.is_null(){
                        let service=tx.get("services",text(&receipt,"serviceId")).await?;
                        ensure(!service.is_null()&&text(&service,"ownerId")==auth&&!flag(&service,"deleted")&&service["credentialHash"]==input["credentialHash"]&&service["name"]==input["name"]&&service["purpose"]==input["purpose"]&&text(&service,"deliveryKeyId")==key_id(&input["deliveryPublicKey"])&&same_caps(&service["capabilities"],&input["capabilities"]),409,"idempotency_conflict")?;
                        return Ok(service_view(&service));
                    }
                    let owned=tx.query(Query::new("services").eq("ownerId",auth.clone()).eq("deleted",false).limit(100)).await?;ensure(owned.len()<100,409,"service_limit_reached")?;
                    let service=json!({"id":random_service_id,"ownerId":auth,"name":input["name"],"purpose":input["purpose"],"capabilities":input["capabilities"],"active":true,"deleted":false,"credentialHash":input["credentialHash"],"deliveryKeyId":key_id(&input["deliveryPublicKey"]),"createdAt":now});
                    tx.create("services",text(&service,"id"),service.clone())?;
                    tx.create("serviceCredentials",text(&service,"credentialHash"),json!({"ownerId":auth,"serviceId":service["id"]}))?;
                    tx.create("serviceDeliveryKeys",&format!("{}_{}",text(&service,"id"),text(&service,"deliveryKeyId")),json!({"id":service["deliveryKeyId"],"serviceId":service["id"],"ownerId":auth,"publicKey":input["deliveryPublicKey"],"retired":false}))?;
                    Ok(service_view(&service))
                },
                "register"=>{
                    let session_id=hash(&auth);let old=tx.get("registrationSessions",&session_id).await?;
                    if !old.is_null(){for p in ["name","purpose","credentialHash"]{ensure(old[p]==input[p],409,"idempotency_conflict")?;}ensure(key_id(&old["deliveryPublicKey"])==key_id(&input["deliveryPublicKey"])&&same_caps(&old["capabilities"],&input["capabilities"]),409,"idempotency_conflict")?;return Ok(registration_view(&old,now));}
                    let receipt=tx.get("serviceCredentials",text(&input,"credentialHash")).await?;
                    if !receipt.is_null(){
                        ensure(text(&receipt,"registrationId")==session_id&&text(&receipt,"registrationKeyId")==key_id(&input["deliveryPublicKey"]),409,"idempotency_conflict")?;
                        let service=s.active_service(tx,text(&receipt,"serviceId")).await?;
                        for p in ["name","purpose","credentialHash"]{ensure(service[p]==input[p],409,"idempotency_conflict")?;}
                        ensure(same_caps(&service["capabilities"],&input["capabilities"]),409,"idempotency_conflict")?;
                        let mut p=input;p["id"]=json!(session_id);p["serviceId"]=service["id"].clone();p["ownerId"]=service["ownerId"].clone();p["status"]=json!("approved");p["createdAt"]=service["createdAt"].clone();p["expiresAt"]=json!(num(&service,"createdAt")+10*MINUTE);p["connectionId"]=receipt["registrationConnectionId"].clone();p["pollAfter"]=json!(0);p["purgeAt"]=json!(now+HISTORY);
                        tx.create("registrationSessions",&session_id,p.clone())?;return Ok(registration_view(&p,now));
                    }
                    let rate=s.onboarding_rate(tx,&format!("registration:{id}"),30).await?;let global=s.onboarding_rate(tx,"registration:global",600).await?;
                    let mut p=input;p["id"]=json!(session_id);p["serviceId"]=json!(random_service_id);p["ownerId"]=Value::Null;p["status"]=json!("pending");p["createdAt"]=json!(now);p["expiresAt"]=json!(now+10*MINUTE);p["connectionId"]=Value::Null;p["pollAfter"]=json!(0);p["purgeAt"]=json!(now+HISTORY);
                    tx.set("onboardingRates",&rate.0,rate.1)?;tx.set("onboardingRates",&global.0,global.1)?;tx.create("registrationSessions",&session_id,p.clone())?;Ok(registration_view(&p,now))
                },
                "registrationPoll"|"registrationReview"|"registrationDecide"=>{
                    let session_id=if method=="registrationPoll"{ensure(regex(r"^smsreg_[A-Za-z0-9_-]{43}$",&auth),401,"invalid_registration_credential")?;hash(&auth)}else{s.account(tx,&auth).await?;id.clone()};
                    let mut p=tx.get("registrationSessions",&session_id).await?;
                    ensure(!p.is_null(),if method=="registrationPoll"{401}else{404},if method=="registrationPoll"{"invalid_registration_credential"}else{"registration_not_found"})?;
                    if method=="registrationPoll"{ensure(num(&p,"pollAfter")<=now,429,"slow_down")?;if !text(&p,"ownerId").is_empty(){s.account(tx,text(&p,"ownerId")).await?;}tx.merge("registrationSessions",&session_id,json!({"pollAfter":now+5000}))?;return Ok(registration_view(&p,now));}
                    ensure(text(&p,"ownerId").is_empty()||text(&p,"ownerId")==auth,404,"registration_not_found")?;
                    if method=="registrationReview"||p["status"]!="pending"{return Ok(registration_view(&p,now));}
                    ensure(num(&p,"expiresAt")>now,410,"session_expired")?;select(&p["capabilities"],&input["capabilities"],&Value::Null,&input["expiresInDays"])?;
                    if input["decision"]=="approved"{ensure(tx.get("serviceCredentials",text(&p,"credentialHash")).await?.is_null(),409,"credential_already_used")?;let owned=tx.query(Query::new("services").eq("ownerId",auth.clone()).eq("deleted",false).limit(100)).await?;ensure(owned.len()<100,409,"service_limit_reached")?;}
                    let service=json!({"id":p["serviceId"],"ownerId":auth,"name":p["name"],"purpose":p["purpose"],"capabilities":p["capabilities"],"active":true,"deleted":false,"credentialHash":p["credentialHash"],"deliveryKeyId":key_id(&p["deliveryPublicKey"]),"createdAt":now});
                    if input["decision"]=="approved"{tx.create("services",text(&service,"id"),service.clone())?;tx.create("serviceCredentials",text(&service,"credentialHash"),json!({"serviceId":service["id"],"ownerId":auth,"registrationId":p["id"],"registrationKeyId":service["deliveryKeyId"],"registrationConnectionId":null}))?;tx.create("serviceDeliveryKeys",&format!("{}_{}",text(&service,"id"),text(&service,"deliveryKeyId")),json!({"id":service["deliveryKeyId"],"serviceId":service["id"],"ownerId":auth,"publicKey":p["deliveryPublicKey"],"retired":false}))?;}
                    p["status"]=input["decision"].clone();p["ownerId"]=json!(auth);tx.set("registrationSessions",&session_id,p.clone())?;Ok(registration_view(&p,now))
                },
                "publicService"=>Ok(service_view(&s.active_service(tx,&id).await?)),
                "listServices"=>{s.account(tx,&auth).await?;Ok(json!(tx.query(Query::new("services").eq("ownerId",auth).eq("deleted",false).limit(100)).await?.iter().filter(|v|!flag(v,"deleted")).map(service_view).collect::<Vec<_>>()))},
                "pairing"|"permanent"=>{
                    if method=="permanent"{s.account(tx,&auth).await?;ensure(input.get("externalAccountRef").is_none(),400,"external_binding_requires_service")?;}
                    let service=if method=="pairing"{s.service_auth(tx,&auth).await?}else{s.active_service(tx,&id).await?};
                    select(&service["capabilities"],&input["capabilities"],&Value::Null,&input["expiresInDays"])?;
                    let owner=if method=="permanent"{json!(auth)}else{Value::Null};let session_id=hash(&js_json(&json!([service["id"],owner,input["idempotencyKey"]]),false));let old=tx.get("pairingSessions",&session_id).await?;
                    if !old.is_null(){ensure(old["externalAccountRef"]==input["externalAccountRef"]&&old["expiresInDays"]==input["expiresInDays"]&&same_caps(&old["capabilities"],&input["capabilities"]),409,"idempotency_conflict")?;return Ok(session_view(&old,&service,now));}
                    let rate=s.onboarding_rate(tx,&format!("pairing:{}",if method=="permanent"{auth.as_str()}else{text(&service,"id")}),60).await?;
                    let code=if method=="pairing"{json!(format!("{:06}",rand::random::<u32>()%1_000_000))}else{Value::Null};
                    let p=json!({"id":session_id,"serviceId":service["id"],"ownerId":owner,"status":"pending","capabilities":input["capabilities"],"expiresInDays":input["expiresInDays"],"createdAt":now,"expiresAt":now+10*MINUTE,"pollAfter":0,"comparisonCode":code,"externalAccountRef":input["externalAccountRef"],"connectionId":null,"purgeAt":now+HISTORY});
                    tx.set("onboardingRates",&rate.0,rate.1)?;tx.create("pairingSessions",&session_id,p.clone())?;Ok(session_view(&p,&service,now))
                },
                "pairingReview"|"pairingPoll"|"pairingDecide"=>{
                    let service=if method=="pairingPoll"{Some(s.service_auth(tx,&auth).await?)}else{s.account(tx,&auth).await?;None};
                    let mut p=tx.get("pairingSessions",&id).await?;ensure(!p.is_null()&&if let Some(service)=&service{p["serviceId"]==service["id"]}else{text(&p,"ownerId").is_empty()||text(&p,"ownerId")==auth},404,"session_not_found")?;
                    let service=if let Some(service)=service{service}else{s.active_service(tx,text(&p,"serviceId")).await?};
                    if method=="pairingPoll"{ensure(num(&p,"pollAfter")<=now,429,"slow_down")?;tx.merge("pairingSessions",&id,json!({"pollAfter":now+5000}))?;return Ok(session_view(&p,&service,now));}
                    if method=="pairingReview"||p["status"]!="pending"{return Ok(session_view(&p,&service,now));}
                    ensure(num(&p,"expiresAt")>now,410,"session_expired")?;select(&p["capabilities"],&input["capabilities"],&p["expiresInDays"],&input["expiresInDays"])?;
                    let key=tx.get("serviceDeliveryKeys",&format!("{}_{}",text(&service,"id"),text(&service,"deliveryKeyId"))).await?;ensure(!key.is_null()&&!flag(&key,"retired"),409,"delivery_key_unavailable")?;
                    let grant=if input["decision"]=="approved"{Some(s.prepare_connection(tx,&auth,&service,&key["publicKey"],&input["capabilities"],(&input["expiresInDays"],&p["externalAccountRef"])).await?)}else{None};
                    if let Some((id,writes))=grant{p["connectionId"]=json!(id);for(c,id,value)in writes{tx.set(c,&id,value)?;}}
                    p["ownerId"]=json!(auth);p["status"]=input["decision"].clone();tx.set("pairingSessions",&id,p.clone())?;Ok(session_view(&p,&service,now))
                },
                "deliveries"=>{
                    let service=s.service_auth(tx,&auth).await?;let rows=tx.query(Query::new("credentialDeliveries").eq("serviceId",service["id"].clone()).eq("acknowledged",false).limit(100)).await?;let mut out=vec![];let has_more=rows.len()==100;let mut discarded=vec![];
                    for d in rows{let g=tx.get("grants",text(&d,"grantId")).await?;if num(&d,"expiresAt")>now&&s.valid_grant(tx,&g).await?&&!flag(&tx.get("accounts",text(&d,"ownerId")).await?,"deleting"){out.push(json!({"deliveryId":d["id"],"connectionId":d["connectionId"],"keyId":d["keyId"],"envelope":d["envelope"],"expiresAt":d["expiresAt"]}));}else{discarded.push(text(&d,"id").to_owned());}}
                    for id in discarded {tx.merge("credentialDeliveries",&id,json!({"acknowledged":true,"envelope":""}))?;}
                    Ok(json!({"deliveries":out,"hasMore":has_more,"interval":5}))
                },
                "acknowledge"=>{
                    let service=s.service_auth(tx,&auth).await?;let d=tx.get("credentialDeliveries",&id).await?;ensure(!d.is_null()&&d["serviceId"]==service["id"],404,"delivery_not_found")?;let g=tx.get("grants",text(&d,"grantId")).await?;ensure(s.valid_grant(tx,&g).await?,410,"delivery_expired")?;s.account(tx,text(&d,"ownerId")).await?;ensure(flag(&d,"acknowledged")||num(&d,"expiresAt")>now,410,"delivery_expired")?;tx.merge("credentialDeliveries",&id,json!({"acknowledged":true,"envelope":""}))?;tx.merge("grants",text(&d,"grantId"),json!({"deliveryAcknowledged":true}))?;Ok(json!({"ok":true}))
                },
                "manageService"|"rotate"=>{
                    let mut service=if method=="rotate"{s.service_auth(tx,&auth).await?}else{s.account(tx,&auth).await?;tx.get("services",&id).await?};
                    ensure(!service.is_null()&&(method=="rotate"||text(&service,"ownerId")==auth)&&!flag(&service,"deleted"),404,"service_not_found")?;s.account(tx,text(&service,"ownerId")).await?;
                    let retire=input.get("retireKeyId").map(|v|format!("{}_{}",text(&service,"id"),v.as_str().unwrap()));
                    if let Some(ref id)=retire{ensure(!tx.get("serviceDeliveryKeys",id).await?.is_null(),404,"delivery_key_not_found")?;}
                    if input.get("deliveryPublicKey").is_some(){let key=key_id(&input["deliveryPublicKey"]);let old=tx.get("serviceDeliveryKeys",&format!("{}_{}",text(&service,"id"),key)).await?;ensure(!flag(&old,"retired"),409,"delivery_key_retired")?;service["deliveryKeyId"]=json!(key);}
                    ensure(input.get("retireKeyId").is_none()||input["retireKeyId"]!=service["deliveryKeyId"],409,"cannot_retire_current_key")?;
                    if input.get("credentialHash").is_some(){let old=tx.get("serviceCredentials",text(&input,"credentialHash")).await?;ensure(old.is_null()||old["serviceId"]==service["id"],409,"credential_already_used")?;}
                    if input.get("credentialHash").is_some(){service["credentialHash"]=input["credentialHash"].clone();tx.set("serviceCredentials",text(&service,"credentialHash"),json!({"ownerId":service["ownerId"],"serviceId":service["id"]}))?;}
                    if input.get("deliveryPublicKey").is_some(){tx.set("serviceDeliveryKeys",&format!("{}_{}",text(&service,"id"),text(&service,"deliveryKeyId")),json!({"id":service["deliveryKeyId"],"serviceId":service["id"],"ownerId":service["ownerId"],"publicKey":input["deliveryPublicKey"],"retired":false}))?;}
                    if let Some(id)=retire{tx.merge("serviceDeliveryKeys",&id,json!({"retired":true}))?;}
                    if input.get("active").is_some(){service["active"]=input["active"].clone();}
                    if flag(&input,"delete"){tx.set("serviceCleanup",text(&service,"id"),json!({"serviceId":service["id"],"ownerId":service["ownerId"],"collectionIndex":0}))?;service["active"]=json!(false);service["deleted"]=json!(true);service["name"]=json!("");service["purpose"]=json!("");}
                    tx.set("services",text(&service,"id"),service.clone())?;Ok(service_view(&service))
                },
                "connectionStatus"|"ownerConnectionStatus"|"serviceConnectionStatus"|"manageConnection"=>{
                    let mut g=if method=="connectionStatus"{s.agent(tx,&auth).await?.0}else{let link=tx.get("serviceConnections",&id).await?;let g=if link.is_null(){Value::Null}else{tx.get("grants",text(&link,"grantId")).await?};if method=="serviceConnectionStatus"{let service=s.service_auth(tx,&auth).await?;ensure(!g.is_null()&&g["serviceId"]==service["id"],404,"connection_not_found")?;}else{s.account(tx,&auth).await?;ensure(!g.is_null()&&text(&g,"ownerId")==auth,404,"connection_not_found")?;}g};
                    let service=tx.get("services",text(&g,"serviceId")).await?;let recipient=tx.get("accounts",text(&g,"ownerId")).await?;let valid=!flag(&recipient,"deleting")&&s.valid_grant(tx,&g).await?;let devices=if flag(&recipient,"deleting"){vec![]}else{s.devices(tx,text(&g,"ownerId")).await?};
                    if method=="manageConnection"{ensure(valid,404,"connection_not_found")?;let service=s.active_service(tx,text(&g,"serviceId")).await?;select(&service["capabilities"],&input["capabilities"],&Value::Null,&Value::Null)?;ensure(input["expiresAt"].is_null()||num(&input,"expiresAt")>now,400,"expiry_in_past")?;g["capabilities"]=input["capabilities"].clone();g["formsApproved"]=json!(capability(&g,"forms"));g["expiresAt"]=if input["expiresAt"].is_null(){json!(FOREVER)}else{input["expiresAt"].clone()};tx.set("grants",text(&g,"id"),g.clone())?;}
                    let available=devices.iter().any(|d|!text(d,"fcmToken").is_empty()&&(!capability(&g,"forms")||d["wizardVersion"]==1));
                    Ok(json!({"connectionId":g["connectionId"],"serviceId":g["serviceId"],"name":service["name"],"purpose":service["purpose"],"availableCapabilities":service["capabilities"],"capabilities":g["capabilities"],"expiresAt":if num(&g,"expiresAt")==FOREVER{Value::Null}else{g["expiresAt"].clone()},"revoked":!valid,"receivingDeviceAvailable":available,"setup":if !valid{"disconnected"}else if !available{"phone_setup_needed"}else if flag(&g,"deliveryAcknowledged"){"setup_complete"}else{"waiting_for_service"}}))
                },
                _=>Err(Error::Api(404,"not_found"))
            }
        })}).await
    }
    pub async fn onboarding_cleanup(&self) -> Result<()> {
        self.oauth_cleanup().await?;
        for job in self
            .store
            .query(Query::new("serviceCleanup").limit(20))
            .await?
        {
            let service_id = text(&job, "serviceId").to_owned();
            let index = num(&job, "collectionIndex");
            let collections = [
                "serviceCredentials",
                "serviceDeliveryKeys",
                "credentialDeliveries",
                "registrationSessions",
                "pairingSessions",
                "connectionBindings",
                "serviceConnections",
                "oauthSessions",
                "oauthBindings",
                "oauthCodes",
                "oauthFamilies",
                "oauthAccess",
                "oauthRefresh",
                "oauthCleanup",
                "oauthGrantCleanup",
            ];
            let Some(collection) = collections.get(index as usize) else {
                let id = service_id.clone();
                self.store
                    .tx(move |tx| {
                        let id = id.clone();
                        Box::pin(async move { tx.delete("serviceCleanup", &id) })
                    })
                    .await?;
                continue;
            };
            let docs = self
                .store
                .query_documents(
                    Query::new(collection)
                        .eq("serviceId", service_id.clone())
                        .limit(100),
                )
                .await?;
            self.store.delete_documents_if_unchanged(&docs).await?;
            if docs.len() < 100 {
                self.store
                    .tx(move |tx| {
                        let id = service_id.clone();
                        Box::pin(async move {
                            let current = tx.get("serviceCleanup", &id).await?;
                            if !current.is_null() && num(&current, "collectionIndex") == index {
                                tx.merge(
                                    "serviceCleanup",
                                    &id,
                                    json!({"collectionIndex":index+1}),
                                )?;
                            }
                            Ok(())
                        })
                    })
                    .await?;
            }
        }
        for c in [
            "registrationSessions",
            "pairingSessions",
            "credentialDeliveries",
            "onboardingRates",
            "oauthClients",
            "oauthSessions",
            "oauthCodes",
            "oauthFamilies",
            "oauthAccess",
            "oauthRefresh",
        ] {
            self.maintenance_purge(c, self.now()).await?;
        }
        Ok(())
    }
}
fn same_caps(a: &Value, b: &Value) -> bool {
    a.as_array().unwrap().len() == b.as_array().unwrap().len()
        && a.as_array()
            .unwrap()
            .iter()
            .all(|v| b.as_array().unwrap().contains(v))
}

fn regex(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).unwrap().is_match(value)
}
