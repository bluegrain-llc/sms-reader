use crate::{
    error::{Result, ensure},
    model::*,
    store::{Query, Store, Tx},
};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;
#[derive(Clone)]
pub struct Relay {
    pub store: Store,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub delivery: Arc<dyn Delivery>,
}
pub trait Delivery: Send + Sync {
    fn notify<'a>(
        &'a self,
        token: &'a str,
        id: &'a str,
        ttl: i64,
        form: bool,
    ) -> futures::future::BoxFuture<'a, Result<()>>;
    fn wake(&self) -> futures::future::BoxFuture<'_, Result<()>>;
    fn webhook<'a>(
        &'a self,
        url: &'a str,
        secret: &'a str,
        event: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<()>>;
}
#[derive(Clone)]
pub enum Auth {
    Agent(String),
    Phone { uid: String, device: String },
}
pub struct Context {
    pub r: Value,
    pub a: Value,
    pub g: Value,
    pub d: Value,
    pub devices: Vec<Value>,
    pub valid: bool,
}
pub fn pending() -> Value {
    json!({"status":"pending_phone","reason":null,"listeningDeadline":null,"sent":false,"lease":0,"attempts":0,"nextAt":0})
}
pub fn ids(r: &Value) -> Vec<String> {
    r["deviceIds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_else(|| vec![text(r, "deviceId").into()])
}
pub fn phones(r: &Value) -> Value {
    r.get("phones").cloned().unwrap_or_else(|| {
        let mut p = json!({});
        for id in ids(r) {
            let mut v = pending();
            v["status"] = r["status"].clone();
            v["listeningDeadline"] = r["listeningDeadline"].clone();
            v["sent"] = r["notificationSent"].clone();
            p[id] = v;
        }
        p
    })
}
impl Relay {
    pub fn now(&self) -> i64 {
        (self.clock)()
    }
    pub async fn account(&self, tx: &Tx, uid: &str) -> Result<Value> {
        let a = tx.get("accounts", uid).await?;
        ensure(!flag(&a, "deleting"), 403, "account_deleted")?;
        Ok(if a.is_null() { json!({}) } else { a })
    }
    pub async fn device(&self, tx: &Tx, uid: &str, id: &str) -> Result<Value> {
        let d = tx.get("devices", id).await?;
        ensure(
            !d.is_null() && text(&d, "ownerId") == uid && !flag(&d, "deleted"),
            404,
            "device_not_found",
        )?;
        Ok(d)
    }
    pub async fn devices(&self, tx: &Tx, uid: &str) -> Result<Vec<Value>> {
        Ok(tx
            .query(Query::new("devices").eq("ownerId", uid))
            .await?
            .into_iter()
            .filter(|d| !flag(d, "deleted") && !flag(d, "paused"))
            .collect())
    }
    pub fn valid_grant(&self, g: &Value) -> bool {
        !g.is_null()
            && !flag(g, "revoked")
            && num(g, "expiresAt") > self.now()
            && text(g, "managerId").is_empty()
    }
    pub async fn agent(&self, tx: &Tx, secret: &str) -> Result<(Value, Value)> {
        ensure(valid_secret(secret), 401, "invalid_token")?;
        let g = tx.get("grants", &hash(secret)).await?;
        ensure(self.valid_grant(&g), 401, "invalid_token")?;
        let a = self.account(tx, text(&g, "ownerId")).await?;
        Ok((g, a))
    }
    pub async fn check_agent(&self, secret: &str) -> Result<()> {
        let s = self.clone();
        let key = secret.to_owned();
        self.store
            .tx(move |tx| {
                let s = s.clone();
                let key = key.clone();
                Box::pin(async move {
                    s.agent(tx, &key).await?;
                    Ok(())
                })
            })
            .await
    }
    pub fn audit(&self, tx: &mut Tx, r: &Value, status: &str) -> Result<()> {
        tx.set("audit",&Uuid::new_v4().to_string(),json!({"ownerId":r["ownerId"],"deviceId":r["deviceId"],"requestId":r["id"],"status":status,"at":self.now(),"purgeAt":self.now()+HISTORY}))
    }
    pub fn finish(
        &self,
        tx: &mut Tx,
        r: &mut Value,
        a: &Value,
        status: &str,
        reason: Value,
    ) -> Result<()> {
        r["status"] = json!(status);
        r["reason"] = reason;
        tx.set("requests", text(r, "id"), r.clone())?;
        if a["activeRequestId"] == r["id"] {
            tx.merge(
                "accounts",
                text(r, "ownerId"),
                json!({"activeRequestId":null,"hasWork":!arr(a,"queueIds").is_empty()}),
            )?;
        }
        if status != "completed" {
            tx.delete("results", text(r, "id"))?;
        }
        self.audit(tx, r, status)
    }
    pub fn expire(
        &self,
        tx: &mut Tx,
        r: &mut Value,
        a: &Value,
        valid: bool,
        devices: &[Value],
    ) -> Result<()> {
        if active(text(r, "status"))
            && (deadline(r) <= self.now()
                || !valid
                || !devices.iter().any(|d| {
                    text(r, "status") == "queued" || ids(r).contains(&text(d, "id").into())
                }))
        {
            let reason = if deadline(r) <= self.now() {
                "request_timeout"
            } else {
                "grant_or_device_unavailable"
            };
            self.finish(tx, r, a, "expired", json!(reason))?;
        } else if text(r, "status") == "completed" && num(r, "resultExpiresAt") <= self.now() {
            self.finish(tx, r, a, "expired", json!("result_expired"))?;
        }
        Ok(())
    }
    pub async fn register(
        &self,
        uid: String,
        id: String,
        name: String,
        fcm: String,
        wizard: bool,
    ) -> Result<Value> {
        let s = self.clone();
        self.store.tx(move|tx|{let(s,uid,id,name,fcm)=(s.clone(),uid.clone(),id.clone(),name.clone(),fcm.clone());Box::pin(async move{
 s.account(tx,&uid).await?;let old=tx.get("devices",&id).await?;let all=tx.query(Query::new("devices").eq("ownerId",uid.clone())).await?;
 ensure(old.is_null()||(text(&old,"ownerId")==uid&&!flag(&old,"deleted")),409,"installation_id_unavailable")?;
 ensure(!old.is_null()||all.iter().filter(|d|!flag(d,"deleted")).count()<20,409,"device_limit_reached")?;
 let mut d=if old.is_null(){json!({"id":id,"ownerId":uid,"paused":false,"deleted":false,"activeRequestId":null,"rate":{"start":s.now(),"count":0}})}else{old};
 d["name"]=json!(name);d["fcmToken"]=json!(fcm);d["updatedAt"]=json!(s.now());d["wizardVersion"]=if wizard{json!(1)}else{Value::Null};
 tx.set("devices",&id,d.clone())?;Ok(json!({"deviceId":id,"name":name,"paused":d["paused"],"activeRequestId":null}))})}).await
    }
    pub async fn create_grant(
        &self,
        uid: String,
        device: String,
        name: String,
        days: i64,
    ) -> Result<Value> {
        let token = secret();
        let id = hash(&token);
        let s = self.clone();
        let gid = id.clone();
        self.store.tx(move|tx|{let(s,uid,device,name,id)=(s.clone(),uid.clone(),device.clone(),name.clone(),gid.clone());Box::pin(async move{
 s.account(tx,&uid).await?;if !device.is_empty(){s.device(tx,&uid,&device).await?;}
 tx.create("grants",&id,json!({"id":id,"ownerId":uid,"deviceId":device,"callerName":name,"revoked":false,"createdAt":s.now(),"expiresAt":s.now()+days*DAY,"rate":{"start":s.now(),"count":0}}))?;Ok(())})}).await?;
        Ok(json!({"grantId":id,"token":token}))
    }
    pub async fn list_devices(&self, uid: &str) -> Result<Value> {
        let all = self
            .store
            .query(Query::new("devices").eq("ownerId", uid))
            .await?;
        let a = self.store.get("accounts", uid).await?;
        let rid = text(&a, "activeRequestId");
        let r = if rid.is_empty() {
            Value::Null
        } else {
            self.store.get("requests", rid).await?
        };
        Ok(json!(all.into_iter().filter(|d|!flag(d,"deleted")).map(|d|{
 let has=active(text(&r,"status"))&&!flag(&d,"paused")&&ids(&r).contains(&text(&d,"id").into())&&active(text(&phones(&r)[text(&d,"id")],"status"));
 json!({"deviceId":d["id"],"name":d["name"],"paused":d["paused"],"wizardVersion":d["wizardVersion"],"activeRequestId":if has{r["id"].clone()}else{Value::Null}})}).collect::<Vec<_>>()))
    }
    pub async fn list_grants(&self, uid: String, device: Option<String>) -> Result<Value> {
        if let Some(id) = device {
            let s = self.clone();
            let u = uid.clone();
            self.store
                .tx(move |tx| {
                    let (s, u, id) = (s.clone(), u.clone(), id.clone());
                    Box::pin(async move {
                        s.device(tx, &u, &id).await?;
                        Ok(())
                    })
                })
                .await?;
        }
        Ok(json!(self.store.query(Query::new("grants").eq("ownerId",uid)).await?.iter().map(|g|json!({"grantId":g["id"],"callerName":g["callerName"],"callerId":g["callerId"],"formsApproved":flag(g,"formsApproved"),"revoked":flag(g,"revoked")||!text(g,"managerId").is_empty(),"expiresAt":g["expiresAt"]})).collect::<Vec<_>>()))
    }
    pub async fn revoke(&self, uid: String, id: String) -> Result<()> {
        let s = self.clone();
        let u = uid.clone();
        let gid = id.clone();
        self.store
            .tx(move |tx| {
                let (s, uid, id) = (s.clone(), u.clone(), gid.clone());
                Box::pin(async move {
                    let a = s.account(tx, &uid).await?;
                    let g = tx.get("grants", &id).await?;
                    ensure(
                        !g.is_null() && text(&g, "ownerId") == uid,
                        404,
                        "grant_not_found",
                    )?;
                    let mut r = if !text(&a, "activeRequestId").is_empty() {
                        tx.get("requests", text(&a, "activeRequestId")).await?
                    } else {
                        Value::Null
                    };
                    tx.merge(
                        "grants",
                        &id,
                        json!({"revoked":true,"formsCancellationPending":true}),
                    )?;
                    if text(&r, "grantId") == id && active(text(&r, "status")) {
                        s.finish(tx, &mut r, &a, "cancelled", json!("token_revoked"))?;
                    }
                    Ok(())
                })
            })
            .await?;
        self.advance(&uid).await?;
        self.cancel_grant(&id).await
    }
    pub async fn change_device(
        &self,
        uid: String,
        id: String,
        paused: bool,
        deleted: bool,
    ) -> Result<()> {
        let s = self.clone();
        let u = uid.clone();
        self.store
            .tx(move |tx| {
                let (s, uid, id) = (s.clone(), u.clone(), id.clone());
                Box::pin(async move {
                    let a = s.account(tx, &uid).await?;
                    s.device(tx, &uid, &id).await?;
                    let ds = s.devices(tx, &uid).await?;
                    let mut r = if !text(&a, "activeRequestId").is_empty() {
                        tx.get("requests", text(&a, "activeRequestId")).await?
                    } else {
                        Value::Null
                    };
                    let mut patch = json!({"paused":paused,"deleted":deleted});
                    if deleted {
                        patch["fcmToken"] = json!("");
                        patch["name"] = json!("");
                        patch["activeRequestId"] = Value::Null;
                    }
                    tx.merge("devices", &id, patch)?;
                    if active(text(&r, "status")) && ids(&r).contains(&id) && (paused || deleted) {
                        r["phones"] = phones(&r);
                        r["phones"][&id]["status"] = json!("failed");
                        r["phones"][&id]["reason"] = json!(if deleted {
                            "device_unregistered"
                        } else {
                            "device_paused"
                        });
                        if !ds
                            .iter()
                            .any(|d| text(d, "id") != id && ids(&r).contains(&text(d, "id").into()))
                        {
                            s.finish(tx, &mut r, &a, "cancelled", json!("devices_unavailable"))?;
                        } else {
                            s.aggregate(tx, &mut r, &a)?;
                        }
                    }
                    Ok(())
                })
            })
            .await?;
        self.advance(&uid).await
    }
    pub async fn delete_account(&self, uid: String) -> Result<()> {
        let u = uid.clone();
        self.store
            .tx(move |tx| {
                let u = u.clone();
                Box::pin(async move { tx.set("accounts", &u, json!({"deleting":true})) })
            })
            .await?;
        for c in [
            "devices",
            "grants",
            "managers",
            "managerCallers",
            "connections",
            "connectionCodes",
            "requests",
            "results",
            "audit",
            "formRequests",
            "formResults",
            "requestEvents",
            "deliveryOutbox",
        ] {
            self.delete_matching(Query::new(c).eq("ownerId", uid.clone()))
                .await?;
        }
        Ok(())
    }
    pub async fn delete_matching(&self, q: Query) -> Result<()> {
        loop {
            let docs = self.store.query(q.clone().limit(400)).await?;
            if docs.is_empty() {
                return Ok(());
            }
            let c = q.col.clone();
            self.store
                .tx(move |tx| {
                    let (docs, c) = (docs.clone(), c.clone());
                    Box::pin(async move {
                        for d in docs {
                            tx.delete(&c, text(&d, "__id"))?;
                        }
                        Ok(())
                    })
                })
                .await?;
        }
    }
    pub async fn advance(&self, uid: &str) -> Result<()> {
        for _ in 0..22 {
            let s = self.clone();
            let uid = uid.to_owned();
            let again = self
                .store
                .tx(move |tx| {
                    let (s, uid) = (s.clone(), uid.clone());
                    Box::pin(async move {
                        let a = s.account(tx, &uid).await?;
                        let queue = arr(&a, "queueIds");
                        if !text(&a, "activeRequestId").is_empty() {
                            let mut r = tx.get("requests", text(&a, "activeRequestId")).await?;
                            if !active(text(&r, "status")) {
                                tx.merge(
                                    "accounts",
                                    &uid,
                                    json!({"activeRequestId":null,"hasWork":!queue.is_empty()}),
                                )?;
                                return Ok(true);
                            }
                            let g = tx.get("grants", text(&r, "grantId")).await?;
                            let ds = s.devices(tx, &uid).await?;
                            s.expire(tx, &mut r, &a, s.valid_grant(&g), &ds)?;
                            return Ok(!active(text(&r, "status")));
                        }
                        if queue.is_empty() {
                            if flag(&a, "hasWork") {
                                tx.merge("accounts", &uid, json!({"hasWork":false}))?;
                            }
                            return Ok(false);
                        }
                        let rid = queue[0].as_str().unwrap();
                        let rest = queue[1..].to_vec();
                        let mut r = tx.get("requests", rid).await?;
                        let g = if r.is_null() {
                            Value::Null
                        } else {
                            tx.get("grants", text(&r, "grantId")).await?
                        };
                        let ds = s.devices(tx, &uid).await?;
                        if active(text(&r, "status")) {
                            s.expire(tx, &mut r, &a, s.valid_grant(&g), &ds)?;
                        }
                        if !active(text(&r, "status")) {
                            tx.merge(
                                "accounts",
                                &uid,
                                json!({"queueIds":rest,"hasWork":!rest.is_empty()}),
                            )?;
                            return Ok(true);
                        }
                        if num(&a, "formListenerUntil") > s.now()
                            || !ds.iter().any(|d| num(d, "listenerUntil") <= s.now())
                        {
                            return Ok(false);
                        }
                        r["status"] = json!("pending_phone");
                        r["deviceIds"] =
                            json!(ds.iter().map(|d| d["id"].clone()).collect::<Vec<_>>());
                        r["phones"] = json!({});
                        for d in &ds {
                            r["phones"][text(d, "id")] = pending();
                        }
                        r["notificationSent"] = json!(false);
                        r["nextNotificationAt"] = json!(s.now());
                        tx.set("requests", rid, r.clone())?;
                        s.audit(tx, &r, "pending_phone")?;
                        tx.merge(
                            "accounts",
                            &uid,
                            json!({"activeRequestId":rid,"queueIds":rest,"hasWork":true}),
                        )?;
                        Ok(false)
                    })
                })
                .await?;
            if !again {
                return Ok(());
            }
        }
        Ok(())
    }
    pub async fn create(&self, secret: String, raw: Value) -> Result<Value> {
        let input = sms_input(&raw)?;
        let s = self.clone();
        let key = secret.clone();
        let uid = self
            .store
            .tx(move |tx| {
                let (s, key) = (s.clone(), key.clone());
                Box::pin(async move { Ok(text(&s.agent(tx, &key).await?.0, "ownerId").to_owned()) })
            })
            .await?;
        self.advance(&uid).await?;
        let s = self.clone();
        self.store.tx(move|tx|{let(s,secret,input)=(s.clone(),secret.clone(),input.clone());Box::pin(async move{
 let(g,a)=s.agent(tx,&secret).await?;let id=hash(&format!("{}:{}",text(&g,"id"),text(&input,"idempotencyKey")));let fp=sms_fingerprint(&input);let mut old=tx.get("requests",&id).await?;let ds=s.devices(tx,text(&g,"ownerId")).await?;
 if !old.is_null(){ensure(text(&old,"fingerprint")==fp,409,"idempotency_conflict")?;s.expire(tx,&mut old,&a,true,&ds)?;return Ok(view(&old));}
 ensure(!ds.is_empty(),409,"devices_unavailable")?;let mut queue=arr(&a,"queueIds");ensure(queue.len()<20,429,"queue_full")?;
 let owner_rate=bump(&rate(&a,"rate",s.now()),s.now(),5)?;let grant_rate=bump(&g["rate"],s.now(),3)?;
 let status=if !text(&a,"activeRequestId").is_empty()||!queue.is_empty()||num(&a,"formListenerUntil")>s.now()||!ds.iter().any(|d|num(d,"listenerUntil")<=s.now()){"queued"}else{"pending_phone"};
 let mut ps=json!({});for d in &ds{ps[text(d,"id")]=pending();}
 let r=json!({"id":id,"ownerId":g["ownerId"],"deviceId":ds[0]["id"],"deviceIds":ds.iter().map(|d|d["id"].clone()).collect::<Vec<_>>(),"phones":ps,"grantId":g["id"],"callerName":g["callerName"],"purpose":input["purpose"],"title":input.get("title").cloned().unwrap_or(json!("Verification code")),"senderPhone":input["senderPhone"],"fingerprint":fp,"status":status,"reason":null,"createdAt":s.now(),"expiresAt":s.now()+10*MINUTE,"listeningDeadline":null,"resultExpiresAt":null,"notificationSent":false,"notificationLease":0,"notificationAttempts":0,"nextNotificationAt":s.now(),"purgeAt":s.now()+HISTORY});
 tx.create("requests",&id,r.clone())?;let mut patch=json!({"rate":owner_rate,"hasWork":true});if status=="queued"{queue.push(json!(id));patch["queueIds"]=json!(queue);}else{patch["activeRequestId"]=json!(id);}
 tx.merge("accounts",text(&g,"ownerId"),patch)?;tx.merge("grants",text(&g,"id"),json!({"rate":grant_rate}))?;s.audit(tx,&r,status)?;Ok(view(&r))})}).await
    }
    pub async fn context(&self, tx: &Tx, id: &str, auth: &Auth) -> Result<Context> {
        match auth {
            Auth::Agent(secret) => {
                let (g, a) = self.agent(tx, secret).await?;
                let r = tx.get("requests", id).await?;
                ensure(
                    !r.is_null() && r["grantId"] == g["id"] && r["ownerId"] == g["ownerId"],
                    404,
                    "request_not_found",
                )?;
                let ds = self.devices(tx, text(&g, "ownerId")).await?;
                Ok(Context {
                    r,
                    a,
                    g,
                    d: Value::Null,
                    devices: ds,
                    valid: true,
                })
            }
            Auth::Phone { uid, device } => {
                let a = self.account(tx, uid).await?;
                let d = self.device(tx, uid, device).await?;
                let r = tx.get("requests", id).await?;
                ensure(
                    !r.is_null() && text(&r, "ownerId") == uid && ids(&r).contains(device),
                    404,
                    "request_not_found",
                )?;
                let g = tx.get("grants", text(&r, "grantId")).await?;
                let valid = self.valid_grant(&g);
                ensure(valid, 409, "grant_unavailable")?;
                let ds = self.devices(tx, uid).await?;
                Ok(Context {
                    r,
                    a,
                    g,
                    d,
                    devices: ds,
                    valid,
                })
            }
        }
    }
    pub async fn get(&self, secret: String, id: String) -> Result<Value> {
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, secret, id) = (s.clone(), secret.clone(), id.clone());
                Box::pin(async move {
                    let mut c = s.context(tx, &id, &Auth::Agent(secret)).await?;
                    let result = tx.get("results", &id).await?;
                    s.expire(tx, &mut c.r, &c.a, c.valid, &c.devices)?;
                    let mut out = view(&c.r);
                    if text(&c.r, "status") == "completed"
                        && !result.is_null()
                        && num(&result, "expiresAt") > s.now()
                    {
                        out["code"] = result["code"].clone();
                    }
                    Ok(out)
                })
            })
            .await
    }
    pub fn phone_view(&self, r: &Value, d: &Value) -> Value {
        let p = phones(r)[text(d, "id")].clone();
        let mut v = view(r);
        if active(text(r, "status")) && text(r, "status") != "queued" && !p.is_null() {
            for k in ["status", "reason", "listeningDeadline"] {
                v[k] = p[k].clone();
            }
        }
        if !text(r, "completedByDeviceId").is_empty() && r["completedByDeviceId"] != d["id"] {
            v["reason"] = json!("handled_on_another_device");
        }
        for k in ["callerName", "purpose", "senderPhone"] {
            v[k] = r[k].clone();
        }
        v["title"] = r
            .get("title")
            .cloned()
            .unwrap_or(json!("Verification code"));
        v
    }
    pub async fn phone_get(&self, uid: String, device: String, id: String) -> Result<Value> {
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, uid, device, id) = (s.clone(), uid.clone(), device.clone(), id.clone());
                Box::pin(async move {
                    let mut c = s.context(tx, &id, &Auth::Phone { uid, device }).await?;
                    s.expire(tx, &mut c.r, &c.a, c.valid, &c.devices)?;
                    Ok(s.phone_view(&c.r, &c.d))
                })
            })
            .await
    }
    pub fn aggregate(&self, tx: &mut Tx, r: &mut Value, a: &Value) -> Result<()> {
        let ps = phones(r);
        let all = ps.as_object().unwrap().values().collect::<Vec<_>>();
        let live = all
            .iter()
            .filter(|p| active(text(p, "status")))
            .collect::<Vec<_>>();
        if live.is_empty() {
            let status = if all.iter().any(|p| text(p, "status") == "denied") {
                "denied"
            } else if all.iter().all(|p| text(p, "status") == "cancelled") {
                "cancelled"
            } else {
                "failed"
            };
            let reason = all
                .iter()
                .find(|p| !p["reason"].is_null())
                .map(|p| p["reason"].clone())
                .unwrap_or(Value::Null);
            return self.finish(tx, r, a, status, reason);
        }
        let status = if live.iter().any(|p| text(p, "status") == "awaiting_consent") {
            "awaiting_consent"
        } else if live.iter().any(|p| text(p, "status") == "ready") {
            "ready"
        } else {
            "pending_phone"
        };
        let deadline = live
            .iter()
            .filter_map(|p| p["listeningDeadline"].as_i64())
            .max();
        r["status"] = json!(status);
        r["listeningDeadline"] = json!(deadline);
        tx.set("requests", text(r, "id"), r.clone())?;
        self.audit(tx, r, status)
    }
    pub async fn transition(&self, auth: Auth, id: String, input: Value) -> Result<Value> {
        let s = self.clone();
        let who = auth.clone();
        let output=self.store.tx(move|tx|{let(s,auth,id,input)=(s.clone(),who.clone(),id.clone(),input.clone());Box::pin(async move{
 let mut c=s.context(tx,&id,&auth).await?;let result=tx.get("results",&id).await?;s.expire(tx,&mut c.r,&c.a,c.valid,&c.devices)?;let r=&mut c.r;let target=text(&input,"status");
 if !active(text(r,"status")){if let Auth::Phone{device,..}=&auth{if text(r,"status")=="completed"&&target=="completed"&&r.get("completedByDeviceId").unwrap_or(&r["deviceId"])==device{ensure(result["code"]==input["code"],409,"upload_conflict")?;}return Ok(s.phone_view(r,&c.d));}return Ok(view(r));}
 if matches!(auth,Auth::Agent(_)){ensure(target=="cancelled",403,"agent_cannot_submit")?;s.finish(tx,r,&c.a,target,input["reason"].clone())?;return Ok(view(r));}
 let d=&c.d;ensure(!flag(d,"paused")&&text(r,"status")!="queued",409,"request_not_ready")?;r["phones"]=phones(r);let p=&mut r["phones"][text(d,"id")];
 if text(p,"status")==target||!active(text(p,"status")){return Ok(s.phone_view(r,d));}
 let source=input.get("source").and_then(Value::as_str).unwrap_or("android_consent");let mut complete=false;
 match target{
 "ready"=>{ensure(text(p,"status")=="pending_phone",409,"invalid_transition")?;ensure(num(d,"formListenerUntil")<=s.now(),409,"sms_listener_busy")?;let start=if input.get("listenerStartedAt").is_some(){num(&input,"listenerStartedAt")}else{s.now()};ensure(start<=s.now()+5000&&start>s.now()-MINUTE,409,"listener_start_stale")?;let until=num(r,"expiresAt").min(start+5*MINUTE).min(s.now()+5*MINUTE);r["phones"][text(d,"id")]["listeningDeadline"]=json!(until);tx.merge("devices",text(d,"id"),json!({"listenerUntil":until}))?;},
 "awaiting_consent"=>{ensure(text(p,"status")=="ready"&&num(p,"listeningDeadline")>s.now(),409,"invalid_transition")?;},
 "completed"=>{ensure((text(p,"status")=="awaiting_consent"||(source=="manual"&&text(p,"status")=="ready"))&&num(p,"listeningDeadline")>s.now(),409,"invalid_transition")?;ensure(code(text(&input,"code")),400,"invalid_input")?;complete=true;},
 _=>ensure(["denied","cancelled","failed"].contains(&target),409,"invalid_transition")?}
 if complete{r["completedByDeviceId"]=d["id"].clone();r["deviceId"]=d["id"].clone();r["submissionSource"]=json!(source);r["resultExpiresAt"]=json!(s.now()+2*MINUTE);tx.create("results",&id,json!({"ownerId":r["ownerId"],"deviceId":d["id"],"grantId":r["grantId"],"code":input["code"],"expiresAt":r["resultExpiresAt"],"purgeAt":r["resultExpiresAt"]}))?;s.finish(tx,r,&c.a,"completed",Value::Null)?;return Ok(s.phone_view(r,d));}
 r["phones"][text(d,"id")]["status"]=json!(target);r["phones"][text(d,"id")]["reason"]=input["reason"].clone();s.aggregate(tx,r,&c.a)?;Ok(s.phone_view(r,d))})}).await?;
        if !active(text(&output, "status")) {
            let uid = match auth {
                Auth::Phone { uid, .. } => uid,
                Auth::Agent(secret) => {
                    let s = self.clone();
                    self.store
                        .tx(move |tx| {
                            let (s, secret) = (s.clone(), secret.clone());
                            Box::pin(async move {
                                Ok(text(&s.agent(tx, &secret).await?.0, "ownerId").to_owned())
                            })
                        })
                        .await?
                }
            };
            self.advance(&uid).await?;
        }
        Ok(output)
    }
    pub async fn history(&self, uid: String, device: Option<String>) -> Result<Value> {
        let s = self.clone();
        let u = uid.clone();
        self.store
            .tx(move |tx| {
                let (s, u, device) = (s.clone(), u.clone(), device.clone());
                Box::pin(async move {
                    s.account(tx, &u).await?;
                    if let Some(id) = device {
                        s.device(tx, &u, &id).await?;
                    }
                    Ok(())
                })
            })
            .await?;
        Ok(json!(
            self.store
                .query(
                    Query::new("requests")
                        .eq("ownerId", uid)
                        .order("createdAt", true)
                        .limit(30)
                )
                .await?
                .into_iter()
                .filter(|r| num(r, "createdAt") + HISTORY > self.now())
                .map(|r| {
                    let mut v = view(&r);
                    v["callerName"] = r["callerName"].clone();
                    v["createdAt"] = r["createdAt"].clone();
                    v
                })
                .collect::<Vec<_>>()
        ))
    }
}
