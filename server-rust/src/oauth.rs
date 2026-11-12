//! OAuth authorization for a named service's MCP resource. Storage is shared with TypeScript.
use crate::{
    error::{Error, Result, ensure},
    model::*,
    onboarding::{FOREVER, capability},
    relay::Relay,
    store::{Query, Tx},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use uuid::Uuid;

fn token(prefix: &str) -> String {
    secret().replacen("smsr_", &format!("{prefix}_"), 1)
}
fn challenge(v: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes()))
}
fn code(id: &str, uid: &str) -> Result<String> {
    let key = std::env::var("OAUTH_CODE_KEY").unwrap_or_default();
    ensure(
        key.len() == 64
            && key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        503,
        "oauth_not_configured",
    )?;
    let bytes = (0..32)
        .map(|i| u8::from_str_radix(&key[i * 2..i * 2 + 2], 16).unwrap())
        .collect::<Vec<_>>();
    let mut mac = Hmac::<Sha256>::new_from_slice(&bytes).unwrap();
    mac.update(format!("{id}\n{}", crate::js_string::utf8(uid)).as_bytes());
    Ok(format!(
        "smsc_{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
fn base(raw: &str) -> Result<String> {
    let u = url::Url::parse(raw).map_err(|_| Error::Api(503, "oauth_not_configured"))?;
    ensure(
        u.scheme() == "https"
            && u.path() == "/"
            && u.query().is_none()
            && u.fragment().is_none()
            && u.username().is_empty()
            && u.password().is_none(),
        503,
        "oauth_not_configured",
    )?;
    Ok(u.origin().ascii_serialization())
}
pub fn resource(root: &str, id: &str) -> String {
    format!("{root}/mcp/services/{id}")
}
pub fn metadata(raw: &str) -> Result<Value> {
    let b = base(raw)?;
    Ok(
        json!({"issuer":b,"authorization_endpoint":format!("{b}/oauth/authorize"),"token_endpoint":format!("{b}/oauth/token"),"registration_endpoint":format!("{b}/oauth/register"),"revocation_endpoint":format!("{b}/oauth/revoke"),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none","client_secret_post"],"scopes_supported":["forms","sms"],"client_id_metadata_document_supported":true}),
    )
}
async fn document(raw: &str) -> Result<Value> {
    let (url, address) = crate::webhooks::destination(raw).await?;
    let host = url.host_str().unwrap().trim_matches(['[', ']']).to_owned();
    let client = reqwest::Client::builder()
        .tls_backend_rustls()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .resolve(&host, address)
        .build()
        .map_err(|_| Error::External)?;
    let mut res = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| Error::Api(503, "client_metadata_unavailable"))?;
    ensure(
        res.status().as_u16() == 200
            && res
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|s| {
                    let t = s.split(';').next().unwrap_or("");
                    t == "application/json"
                        || (t.starts_with("application/") && t.ends_with("+json"))
                }),
        400,
        "invalid_client_metadata",
    )?;
    let mut bytes = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|_| Error::Api(503, "client_metadata_unavailable"))?
    {
        ensure(
            bytes.len() + chunk.len() <= 32768,
            400,
            "invalid_client_metadata",
        )?;
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::Api(400, "invalid_client_metadata"))
}
fn selected(requested: &Value, caps: &Value) -> Result<()> {
    crate::onboarding::caps(caps)?;
    ensure(
        caps.as_array()
            .unwrap()
            .iter()
            .all(|c| requested.as_array().is_some_and(|r| r.contains(c))),
        400,
        "capability_not_requested",
    )
}
fn redirect(p: &Value, auth_code: Option<&str>) -> Result<String> {
    let mut u =
        url::Url::parse(text(p, "redirect_uri")).map_err(|_| Error::Api(400, "invalid_client"))?;
    let retained = u
        .query_pairs()
        .filter(|(name, _)| !["state", "code", "error"].contains(&name.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    u.set_query(None);
    {
        let mut q = u.query_pairs_mut();
        q.extend_pairs(retained);
        if let Some(state) = p["state"].as_str() {
            q.append_pair("state", state);
        }
        if let Some(c) = auth_code {
            q.append_pair("code", c);
        } else {
            q.append_pair("error", "access_denied");
        }
    }
    Ok(u.to_string())
}
impl Relay {
    pub async fn oauth_register(
        &self,
        mut input: Value,
        source: String,
        metadata_id: Option<String>,
    ) -> Result<Value> {
        let name = string(&input, "client_name", 1, 80, true)?;
        let redirects = input["redirect_uris"]
            .as_array()
            .ok_or(Error::Api(400, "invalid_input"))?
            .clone();
        ensure(
            !redirects.is_empty() && redirects.len() <= 8,
            400,
            "invalid_input",
        )?;
        let auth = input
            .get("token_endpoint_auth_method")
            .map_or(Some("none"), Value::as_str)
            .ok_or(Error::Api(400, "invalid_input"))?
            .to_owned();
        ensure(
            ["none", "client_secret_post"].contains(&auth.as_str()),
            400,
            "invalid_input",
        )?;
        let grants = input
            .get("grant_types")
            .cloned()
            .unwrap_or(json!(["authorization_code", "refresh_token"]));
        ensure(
            grants.as_array().is_some_and(|a| {
                a.contains(&json!("authorization_code"))
                    && a.iter()
                        .all(|c| c == "authorization_code" || c == "refresh_token")
            }),
            400,
            "invalid_client_metadata",
        )?;
        let responses = input
            .get("response_types")
            .cloned()
            .unwrap_or(json!(["code"]));
        ensure(
            responses
                .as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(|c| c == "code")),
            400,
            "invalid_client_metadata",
        )?;
        if let Some(id) = &metadata_id {
            ensure(
                text(&input, "client_id") == id && auth == "none",
                400,
                "invalid_client_metadata",
            )?;
        }
        let mut seen = std::collections::HashSet::new();
        for uri in &redirects {
            let raw = uri.as_str().ok_or(Error::Api(400, "invalid_input"))?;
            ensure(
                raw.len() <= 2048 && !raw.contains('#') && seen.insert(raw),
                400,
                "invalid_client_metadata",
            )?;
            crate::webhooks::destination(raw).await?;
        }
        if let Some(uri) = input.get("client_uri") {
            crate::webhooks::destination(uri.as_str().ok_or(Error::Api(400, "invalid_input"))?)
                .await?;
        }
        let id = metadata_id
            .clone()
            .unwrap_or_else(|| format!("relay-client-{}", Uuid::new_v4()));
        let secret = if auth == "none" {
            None
        } else {
            Some(token("smscs"))
        };
        let expiry = if metadata_id.is_some() {
            self.now() + 60 * MINUTE
        } else {
            FOREVER
        };
        input = json!({"id":id,"client_name":name,"redirect_uris":redirects,"token_endpoint_auth_method":auth,"grant_types":grants,"response_types":responses,"secretHash":secret.as_ref().map(|s|hash(s)),"expiresAt":expiry,"purgeAt":null});
        let (s, v, key) = (self.clone(), input.clone(), hash(&id));
        self.store
            .tx(move |tx| {
                let (s, v, key, source) = (s.clone(), v.clone(), key.clone(), source.clone());
                Box::pin(async move {
                    let rate = s
                        .onboarding_rate(tx, &format!("oauth-register:{source}"), 20)
                        .await?;
                    let global = s.onboarding_rate(tx, "oauth-register:global", 200).await?;
                    tx.set("onboardingRates", &rate.0, rate.1)?;
                    tx.set("onboardingRates", &global.0, global.1)?;
                    tx.set("oauthClients", &key, v)
                })
            })
            .await?;
        let mut out = json!({"client_id":id,"client_name":name,"redirect_uris":redirects,"token_endpoint_auth_method":auth,"grant_types":grants,"response_types":responses});
        if let Some(secret) = secret {
            out["client_secret"] = json!(secret);
            out["client_secret_expires_at"] = json!(0);
        }
        Ok(out)
    }
    pub async fn oauth_start(
        &self,
        input: Value,
        source: String,
        raw_base: &str,
    ) -> Result<String> {
        code("configuration", "check")?;
        let root = base(raw_base)?;
        strict(
            &input,
            &[
                "response_type",
                "client_id",
                "redirect_uri",
                "resource",
                "code_challenge",
                "code_challenge_method",
                "scope",
                "state",
            ],
        )?;
        ensure(
            input["response_type"] == "code" && input["code_challenge_method"] == "S256",
            400,
            "invalid_input",
        )?;
        let client = string(&input, "client_id", 1, 2048, false)?;
        let target = string(&input, "resource", 1, 2048, false)?;
        let service_id = target
            .strip_prefix(&format!("{root}/mcp/services/"))
            .ok_or(Error::Api(400, "invalid_target"))?
            .to_owned();
        id(&service_id)?;
        ensure(
            target == resource(&root, &service_id),
            400,
            "invalid_target",
        )?;
        let ch = text(&input, "code_challenge");
        ensure(
            ch.len() == 43
                && ch
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            400,
            "invalid_input",
        )?;
        if let Some(state) = input.get("state") {
            ensure(
                state.as_str().is_some_and(|s| s.len() <= 1024),
                400,
                "invalid_input",
            )?;
        }
        if client.starts_with("https://") {
            let old = self.store.get("oauthClients", &hash(&client)).await?;
            if old.is_null() || num(&old, "expiresAt") <= self.now() {
                self.oauth_register(
                    document(&client).await?,
                    source.clone(),
                    Some(client.clone()),
                )
                .await?;
            }
        }
        let caps = json!(
            string(&input, "scope", 1, 80, false)?
                .split(' ')
                .collect::<Vec<_>>()
        );
        crate::onboarding::caps(&caps)?;
        let id = Uuid::new_v4().to_string();
        let (s, session_id) = (self.clone(), id.clone());
        self.store
            .tx(move |tx| {
                let (s, input, source, service_id, client, caps, id) = (
                    s.clone(),
                    input.clone(),
                    source.clone(),
                    service_id.clone(),
                    client.clone(),
                    caps.clone(),
                    session_id.clone(),
                );
                Box::pin(async move {
                    let c = tx.get("oauthClients", &hash(&client)).await?;
                    ensure(
                        c["redirect_uris"]
                            .as_array()
                            .is_some_and(|a| a.contains(&input["redirect_uri"])),
                        400,
                        "invalid_client",
                    )?;
                    let service = s.active_service(tx, &service_id).await?;
                    selected(&service["capabilities"], &caps)?;
                    let rate = s
                        .onboarding_rate(tx, &format!("oauth-authorize:{source}"), 60)
                        .await?;
                    let global = s.onboarding_rate(tx, "oauth-authorize:global", 600).await?;
                    let mut p = input;
                    p["id"] = json!(id);
                    p["serviceId"] = json!(service_id);
                    p["clientName"] = c["client_name"].clone();
                    p["capabilities"] = caps;
                    p["status"] = json!("pending");
                    p["ownerId"] = Value::Null;
                    p["connectionId"] = Value::Null;
                    p["expiresAt"] = json!(s.now() + 10 * MINUTE);
                    p["purgeAt"] = json!(s.now() + HISTORY);
                    tx.set("onboardingRates", &rate.0, rate.1)?;
                    tx.set("onboardingRates", &global.0, global.1)?;
                    tx.create("oauthSessions", &id, p)
                })
            })
            .await?;
        Ok(format!("/oauth/consent/{id}"))
    }
    pub async fn oauth_session(
        &self,
        action: String,
        uid: String,
        id: String,
        input: Value,
    ) -> Result<Value> {
        if action == "decide" {
            strict(&input, &["decision", "capabilities", "expiresInDays"])?;
            ensure(
                input["decision"] == "approved" || input["decision"] == "denied",
                400,
                "invalid_input",
            )?;
            crate::onboarding::caps(&input["capabilities"])?;
            ensure(
                input.get("expiresInDays").is_some()
                    && (input["expiresInDays"].is_null()
                        || input["expiresInDays"]
                            .as_i64()
                            .is_some_and(|n| (1..=365).contains(&n))),
                400,
                "invalid_input",
            )?;
        }
        let s = self.clone();
        self.store.tx(move|tx|{let(s,action,uid,id,input)=(s.clone(),action.clone(),uid.clone(),id.clone(),input.clone());Box::pin(async move{
            s.account(tx,&uid).await?;let mut p=tx.get("oauthSessions",&id).await?;ensure(!p.is_null()&&(text(&p,"ownerId").is_empty()||text(&p,"ownerId")==uid),404,"session_not_found")?;
            let service=s.active_service(tx,text(&p,"serviceId")).await?;
            if action=="review"{let status=if p["status"]=="pending"&&num(&p,"expiresAt")<=s.now(){json!("expired")}else{p["status"].clone()};let origin=url::Url::parse(text(&p,"redirect_uri")).map_err(|_|Error::Api(400,"invalid_client"))?.origin().ascii_serialization();return Ok(json!({"sessionId":id,"serviceId":service["id"],"name":service["name"],"purpose":service["purpose"],"nameIsOperatorSupplied":true,"clientName":p["clientName"],"clientOrigin":origin,"capabilities":p["capabilities"],"expiresInDays":null,"connectionId":p["connectionId"],"status":status,"expiresAt":p["expiresAt"]}));}
            ensure(num(&p,"expiresAt")>s.now(),410,"session_expired")?;let auth_code=code(&id,&uid)?;
            if action=="response"{ensure(text(&p,"ownerId")==uid&&p["status"]!="pending",404,"session_not_found")?;if p["status"]=="approved"{let c=tx.get("oauthCodes",&hash(&auth_code)).await?;let g=tx.get("grants",text(&p,"grantId")).await?;ensure(p["codeHash"]==hash(&auth_code)&&s.valid_grant(tx,&g).await?,410,"authorization_finished")?;ensure(c.is_null()||(num(&c,"expiresAt")>s.now()&&!flag(&c,"consumed")),410,"authorization_finished")?;
                if c.is_null(){tx.create("oauthCodes",&hash(&auth_code),json!({"ownerId":uid,"serviceId":p["serviceId"],"grantId":p["grantId"],"clientId":p["client_id"],"resource":p["resource"],"redirectUri":p["redirect_uri"],"challenge":p["code_challenge"],"capabilities":p["selectedCapabilities"],"expiresAt":num(&p,"expiresAt").min(s.now()+MINUTE),"consumed":false,"familyId":null,"purgeAt":s.now()+HISTORY}))?;}}return Ok(json!({"redirect":redirect(&p,if p["status"]=="approved"{Some(&auth_code)}else{None})?,"status":p["status"]}));}
            selected(&p["capabilities"],&input["capabilities"])?;
            let mut sorted=input["capabilities"].as_array().unwrap().clone();sorted.sort_by(|a,b|a.as_str().cmp(&b.as_str()));
            let fingerprint=hash(&json!([input["decision"],sorted,input["expiresInDays"]]).to_string());
            if p["status"]!="pending"{ensure(p["decisionHash"]==fingerprint,409,"decision_already_made")?;}else{
                let mut connection_id=Value::Null;let mut grant_id=Value::Null;
                if input["decision"]=="approved"{
                    let binding=hash(&js_json(&json!([uid,service["id"],"oauth",p["client_id"]]),false));let old=tx.get("oauthBindings",&binding).await?;
                    let mut g=if old.is_null(){Value::Null}else{tx.get("grants",text(&old,"grantId")).await?};
                    let valid=s.valid_grant(tx,&g).await?;let expiry=if input["expiresInDays"].is_null(){FOREVER}else{s.now()+num(&input,"expiresInDays")*DAY};
                    if !valid {g=json!({"id":hash(&secret()),"connectionId":Uuid::new_v4().to_string(),"serviceId":service["id"],"ownerId":uid,"deviceId":"","callerName":service["name"],"callerId":service["id"],"revoked":false,"createdAt":s.now(),"expiresAt":expiry,"capabilities":input["capabilities"],"deliveryAcknowledged":true,"rate":{"start":s.now(),"count":0}});}
                    g["capabilities"]=input["capabilities"].clone();g["expiresAt"]=json!(expiry);g["formsApproved"]=json!(capability(&g,"forms"));connection_id=g["connectionId"].clone();grant_id=g["id"].clone();
                    tx.set("grants",text(&g,"id"),g.clone())?;tx.set("oauthBindings",&binding,json!({"ownerId":uid,"serviceId":service["id"],"grantId":g["id"]}))?;
                    tx.set("serviceConnections",text(&g,"connectionId"),json!({"ownerId":uid,"serviceId":service["id"],"grantId":g["id"],"connectionId":g["connectionId"]}))?;

                }
                p["ownerId"]=json!(uid);p["status"]=input["decision"].clone();p["decisionHash"]=json!(fingerprint);p["connectionId"]=connection_id;p["codeHash"]=json!(hash(&auth_code));p["grantId"]=grant_id;p["selectedCapabilities"]=input["capabilities"].clone();tx.set("oauthSessions",&id,p.clone())?;
            }
            Ok(json!({"status":input["decision"],"connectionId":p["connectionId"]}))
        })}).await
    }
    async fn oauth_client(&self, tx: &Tx, input: &Value) -> Result<Value> {
        let c = tx
            .get("oauthClients", &hash(text(input, "client_id")))
            .await?;
        let secret = text(input, "client_secret");
        ensure(
            !c.is_null()
                && if c["secretHash"].is_null() {
                    secret.is_empty()
                } else {
                    hash(secret) == text(&c, "secretHash")
                },
            401,
            "invalid_client",
        )?;
        Ok(c)
    }
    pub async fn oauth_token(&self, input: Value) -> Result<Value> {
        let refresh = if input["grant_type"] == "refresh_token" {
            text(&input, "refresh_token").to_owned()
        } else {
            token("smsf")
        };
        let mut mac = Hmac::<Sha256>::new_from_slice(refresh.as_bytes()).unwrap();
        mac.update(format!("relay-oauth-access-v1\n{}", text(&input, "client_secret")).as_bytes());
        let access = format!(
            "smsa_{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        );
        let (s, family_id) = (self.clone(), Uuid::new_v4().to_string());
        let out=self.store.tx(move|tx|{let(s,input,access,refresh,family_id)=(s.clone(),input.clone(),access.clone(),refresh.clone(),family_id.clone());Box::pin(async move{
            let c=s.oauth_client(tx,&input).await?;let code_flow=input["grant_type"]=="authorization_code";ensure(code_flow||input["grant_type"]=="refresh_token",400,"unsupported_grant_type")?;
            ensure(c["grant_types"].as_array().is_some_and(|a|a.contains(&input["grant_type"])),400,"unauthorized_client")?;
            let collection=if code_flow{"oauthCodes"}else{"oauthRefresh"};let key=hash(text(&input,if code_flow{"code"}else{"refresh_token"}));let record=tx.get(collection,&key).await?;
            ensure(!record.is_null()&&record["clientId"]==c["id"]&&record["resource"]==input["resource"],400,"invalid_grant")?;
            if code_flow{let verifier=text(&input,"code_verifier");ensure(input["redirect_uri"]==record["redirectUri"]&&(43..=128).contains(&verifier.len())&&verifier.bytes().all(|b|b.is_ascii_alphanumeric()||b"._~-".contains(&b))&&challenge(verifier)==text(&record,"challenge"),400,"invalid_grant")?;}
            let mut family=if code_flow{json!({"id":family_id,"ownerId":record["ownerId"],"serviceId":record["serviceId"],"grantId":record["grantId"],"clientId":c["id"],"resource":record["resource"],"capabilities":record["capabilities"],"expiresAt":FOREVER,"revoked":false})}else{let f=tx.get("oauthFamilies",text(&record,"familyId")).await?;ensure(!f.is_null()&&!flag(&f,"revoked")&&num(&f,"expiresAt")>s.now(),400,"invalid_grant")?;f};
            ensure(!flag(&record,"consumed"),400,"invalid_grant")?;
            ensure(num(&record,"expiresAt")>s.now(),400,"invalid_grant")?;let g=tx.get("grants",text(&family,"grantId")).await?;ensure(s.valid_grant(tx,&g).await?,400,"invalid_grant")?;s.account(tx,text(&g,"ownerId")).await?;
            let caps=if let Some(scope)=input.get("scope"){json!(scope.as_str().ok_or(Error::Api(400,"invalid_scope"))?.split(' ').collect::<Vec<_>>())}else{family["capabilities"].clone()};crate::onboarding::caps(&caps)?;
            ensure(caps.as_array().unwrap().iter().all(|cap|family["capabilities"].as_array().unwrap().contains(cap)&&g["capabilities"].as_array().is_some_and(|a|a.contains(cap))),400,"invalid_scope")?;
            family["capabilities"]=caps.clone();family["expiresAt"]=json!(FOREVER);family["purgeAt"]=Value::Null;
            if code_flow{tx.merge(collection,&key,json!({"consumed":true,"familyId":family["id"]}))?;}tx.set("oauthFamilies",text(&family,"id"),family.clone())?;
            tx.set("oauthAccess",&hash(&access),json!({"ownerId":g["ownerId"],"serviceId":g["serviceId"],"grantId":g["id"],"clientId":c["id"],"familyId":family["id"],"resource":family["resource"],"capabilities":caps,"expiresAt":FOREVER,"purgeAt":null}))?;
            tx.merge("oauthClients",&hash(text(&c,"id")),json!({"purgeAt":null}))?;
            if c["grant_types"].as_array().unwrap().contains(&json!("refresh_token")){tx.set("oauthRefresh",&hash(&refresh),json!({"ownerId":g["ownerId"],"serviceId":g["serviceId"],"clientId":c["id"],"resource":family["resource"],"familyId":family["id"],"expiresAt":FOREVER,"consumed":false,"purgeAt":null}))?;}
            let mut result=json!({"access_token":access,"token_type":"Bearer","refresh_token":refresh,"scope":caps.as_array().unwrap().iter().map(|c|c.as_str().unwrap()).collect::<Vec<_>>().join(" ")});
            if !c["grant_types"].as_array().unwrap().contains(&json!("refresh_token")){result.as_object_mut().unwrap().remove("refresh_token");}Ok(result)
        })}).await?;
        Ok(out)
    }
    pub async fn oauth_revoke(&self, input: Value) -> Result<Value> {
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, input) = (s.clone(), input.clone());
                Box::pin(async move {
                    let c = s.oauth_client(tx, &input).await?;
                    let key = text(&input, "token");
                    let r = tx
                        .get(
                            if key.starts_with("smsf_") {
                                "oauthRefresh"
                            } else {
                                "oauthAccess"
                            },
                            &hash(key),
                        )
                        .await?;
                    if !r.is_null() && r["clientId"] == c["id"] {
                        tx.merge(
                            "oauthFamilies",
                            text(&r, "familyId"),
                            json!({"revoked":true}),
                        )?;
                        tx.set("oauthCleanup",text(&r,"familyId"),json!({"familyId":r["familyId"],"ownerId":r["ownerId"],"serviceId":r["serviceId"],"collectionIndex":0}))?;
                    }
                    Ok(json!({}))
                })
            })
            .await
    }
    pub async fn oauth_grant(&self, tx: &Tx, token: &str) -> Result<Value> {
        ensure(
            token.len() == 48
                && token.starts_with("smsa_")
                && token[5..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            401,
            "invalid_token",
        )?;
        let a = tx.get("oauthAccess", &hash(token)).await?;
        ensure(
            !a.is_null() && num(&a, "expiresAt") > self.now(),
            401,
            "invalid_token",
        )?;
        let f = tx.get("oauthFamilies", text(&a, "familyId")).await?;
        ensure(
            !f.is_null()
                && !flag(&f, "revoked")
                && num(&f, "expiresAt") > self.now()
                && f["clientId"] == a["clientId"]
                && f["resource"] == a["resource"],
            401,
            "invalid_token",
        )?;
        let mut g = tx.get("grants", text(&a, "grantId")).await?;
        ensure(
            g["serviceId"] == a["serviceId"] && self.valid_grant(tx, &g).await?,
            401,
            "invalid_token",
        )?;
        g["capabilities"] = json!(
            g["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| a["capabilities"].as_array().unwrap().contains(c)
                    && f["capabilities"].as_array().unwrap().contains(c))
                .cloned()
                .collect::<Vec<_>>()
        );
        Ok(g)
    }
}

impl Relay {
    pub async fn oauth_cleanup(&self) -> Result<()> {
        for job in self
            .store
            .query(Query::new("oauthGrantCleanup").limit(20))
            .await?
        {
            let id = text(&job, "__id").to_owned();
            self.store.tx(move|tx|{let id=id.clone();Box::pin(async move {
                let job=tx.get("oauthGrantCleanup",&id).await?;if job.is_null(){return Ok(());}
                let rows=tx.query(Query::new("oauthFamilies").eq("grantId",text(&job,"grantId")).limit(100)).await?;
                let mut missing=Vec::new();for f in &rows{if tx.get("oauthCleanup",text(f,"__id")).await?.is_null(){missing.push(f.clone());}}
                for f in missing{tx.create("oauthCleanup",text(&f,"__id"),json!({"familyId":f["__id"],"ownerId":job["ownerId"],"serviceId":job["serviceId"],"collectionIndex":0}))?;}
                if rows.is_empty(){tx.delete("oauthGrantCleanup",&id)?;}Ok(())
            })}).await?;
        }
        for job in self
            .store
            .query(Query::new("oauthCleanup").limit(20))
            .await?
        {
            let id = text(&job, "__id").to_owned();
            self.store
                .tx(move |tx| {
                    let id = id.clone();
                    Box::pin(async move {
                        let job = tx.get("oauthCleanup", &id).await?;
                        if job.is_null() {
                            return Ok(());
                        }
                        let Some(collection) = ["oauthAccess", "oauthRefresh", "oauthCodes"]
                            .get(num(&job, "collectionIndex") as usize)
                        else {
                            tx.delete("oauthFamilies", text(&job, "familyId"))?;
                            tx.delete("oauthCleanup", &id)?;
                            return Ok(());
                        };
                        let rows = tx
                            .query(
                                Query::new(collection)
                                    .eq("familyId", text(&job, "familyId"))
                                    .limit(100),
                            )
                            .await?;
                        for row in &rows {
                            tx.delete(collection, text(row, "__id"))?;
                        }
                        if rows.len() < 100 {
                            tx.merge(
                                "oauthCleanup",
                                &id,
                                json!({"collectionIndex":num(&job,"collectionIndex")+1}),
                            )?;
                        }
                        Ok(())
                    })
                })
                .await?;
        }
        Ok(())
    }
}
