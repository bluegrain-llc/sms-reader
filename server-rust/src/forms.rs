use crate::{
    error::{Result, ensure},
    forms_model::*,
    model::*,
    relay::{Auth, Relay},
    store::{Query, Tx},
};
use serde_json::{Value, json};
use uuid::Uuid;
pub struct FormContext {
    pub r: Value,
    pub g: Value,
    pub d: Value,
    pub valid: bool,
    pub a: Value,
}
impl Relay {
    pub async fn form_agent(&self, tx: &Tx, secret: &str) -> Result<(Value, Value)> {
        let (g, a) = self.agent(tx, secret).await?;
        ensure(flag(&g, "formsApproved"), 403, "forms_approval_required")?;
        Ok((g, a))
    }
    pub async fn approve_forms(&self, uid: String, id: String, approved: bool) -> Result<()> {
        let s = self.clone();
        let gid = id.clone();
        self.store
            .tx(move |tx| {
                let (s, uid, id) = (s.clone(), uid.clone(), gid.clone());
                Box::pin(async move {
                    s.account(tx, &uid).await?;
                    let g = tx.get("grants", &id).await?;
                    ensure(
                        !g.is_null() && text(&g, "ownerId") == uid && s.valid_grant(&g),
                        404,
                        "grant_not_found",
                    )?;
                    tx.merge(
                        "grants",
                        &id,
                        json!({"formsApproved":approved,"formsCancellationPending":!approved}),
                    )
                })
            })
            .await?;
        if !approved {
            self.cancel_grant(&id).await?;
        }
        Ok(())
    }
    pub async fn form_context(&self, tx: &Tx, id: &str, auth: &Auth) -> Result<FormContext> {
        let (mut g, a, d) = match auth {
            Auth::Agent(secret) => {
                let (g, a) = self.form_agent(tx, secret).await?;
                (g, a, Value::Null)
            }
            Auth::Phone { uid, device } => (
                Value::Null,
                self.account(tx, uid).await?,
                self.device(tx, uid, device).await?,
            ),
        };
        let r = tx.get("formRequests", id).await?;
        ensure(
            !r.is_null()
                && match auth {
                    Auth::Agent(_) => r["grantId"] == g["id"] && r["ownerId"] == g["ownerId"],
                    Auth::Phone { uid, .. } => text(&r, "ownerId") == uid,
                },
            404,
            "request_not_found",
        )?;
        ensure(
            r["definition"].get("steps").is_none() || d.is_null() || d["wizardVersion"] == 1,
            409,
            "wizard_app_update_required",
        )?;
        ensure(num(&r, "purgeAt") > self.now(), 404, "request_not_found")?;
        if matches!(auth, Auth::Phone { .. }) {
            g = tx.get("grants", text(&r, "grantId")).await?;
        }
        ensure(!g.is_null(), 409, "grant_unavailable")?;
        let valid = flag(&g, "formsApproved") && self.valid_grant(&g);
        Ok(FormContext { r, g, d, a, valid })
    }
    pub fn form_event(
        &self,
        tx: &mut Tx,
        r: &mut Value,
        g: &mut Value,
        kind: &str,
        extra: Value,
    ) -> Result<Value> {
        let seq = num(g, "eventSequence") + 1;
        g["eventSequence"] = json!(seq);
        r["sequence"] = json!(num(r, "sequence") + 1);
        let id = format!("{}_{seq:016}", text(g, "id"));
        let mut e = json!({"id":id,"type":kind,"requestId":r["id"],"sequence":seq,"requestSequence":r["sequence"],"ownerId":r["ownerId"],"grantId":g["id"],"at":self.now(),"purgeAt":r["purgeAt"]});
        for (k, v) in extra.as_object().unwrap() {
            e[k] = v.clone();
        }
        tx.create("requestEvents", &id, e.clone())?;
        tx.merge("grants", text(g, "id"), json!({"eventSequence":seq}))?;
        for hook in arr(g, "webhooks") {
            if arr(&hook, "events").contains(&json!(kind)) {
                self.form_job(tx, r, &id, "webhook", text(&hook, "id"))?;
            }
        }
        tx.set("formRequests", text(r, "id"), r.clone())?;
        Ok(e)
    }
    pub fn form_job(
        &self,
        tx: &mut Tx,
        r: &Value,
        event: &str,
        kind: &str,
        target: &str,
    ) -> Result<()> {
        let id = hash(&format!("{event}:{kind}:{target}"));
        let mut j = json!({"id":id,"requestId":r["id"],"ownerId":r["ownerId"],"grantId":r["grantId"],"eventId":event,"kind":kind,"nextAt":self.now(),"lease":null,"attempts":0,"purgeAt":r["purgeAt"]});
        j[if kind == "push" { "deviceId" } else { "hookId" }] = json!(target);
        tx.create("deliveryOutbox", &id, j)
    }
    pub async fn form_end(
        &self,
        tx: &mut Tx,
        r: &mut Value,
        g: &mut Value,
        status: &str,
        at: i64,
    ) -> Result<()> {
        let events = tx
            .query(Query::new("requestEvents").eq("requestId", r["id"].clone()))
            .await?;
        let jobs = tx
            .query(Query::new("deliveryOutbox").eq("requestId", r["id"].clone()))
            .await?;
        r["status"] = json!(status);
        r["terminatedAt"] = json!(at);
        r["purgeAt"] = json!(at + HISTORY);
        for (c, docs) in [("requestEvents", events), ("deliveryOutbox", jobs)] {
            for doc in docs {
                tx.merge(c, text(&doc, "__id"), json!({"purgeAt":r["purgeAt"]}))?;
            }
        }
        self.form_event(tx, r, g, &format!("request.{status}"), json!({}))?;
        Ok(())
    }
    pub async fn form_expire(
        &self,
        tx: &mut Tx,
        r: &mut Value,
        g: &mut Value,
        valid: bool,
    ) -> Result<()> {
        if text(r, "status") == "pending" && (!valid || num(r, "expiresAt") <= self.now()) {
            let at = if valid {
                num(r, "expiresAt")
            } else {
                self.now()
            };
            self.form_end(tx, r, g, if valid { "expired" } else { "cancelled" }, at)
                .await?;
        }
        Ok(())
    }
    pub async fn kick(&self) {
        let _ = self.delivery.wake().await;
    }
    pub async fn form_create(&self, secret: String, raw: Value) -> Result<Value> {
        let definition = definition(raw)?;
        let s = self.clone();
        let result=self.store.tx(move|tx|{let(s,secret,def)=(s.clone(),secret.clone(),definition.clone());Box::pin(async move{
 let(mut g,a)=s.form_agent(tx,&secret).await?;let id=hash(&format!("v2:{}:{}",text(&g,"id"),text(&def,"idempotencyKey")));let fp=hash(&js_json(&def,true));let mut old=tx.get("formRequests",&id).await?;
 if !old.is_null(){ensure(num(&old,"purgeAt")>s.now(),410,"request_retention_ended")?;ensure(text(&old,"fingerprint")==fp,409,"idempotency_conflict")?;s.form_expire(tx,&mut old,&mut g,true).await?;return Ok(form_view(&old));}
 let ds=s.devices(tx,text(&g,"ownerId")).await?.into_iter().filter(|d|def.get("steps").is_none()||d["wizardVersion"]==1).collect::<Vec<_>>();let pending=tx.query(Query::new("formRequests").eq("ownerId",g["ownerId"].clone()).eq("status","pending").limit(101)).await?;
 ensure(!ds.is_empty(),409,if def.get("steps").is_some(){"wizard_devices_unavailable"}else{"devices_unavailable"})?;ensure(pending.len()<100,429,"inbox_full")?;let gr=bump(&rate(&g,"formRate",s.now()),s.now(),30)?;let ar=bump(&rate(&a,"formRate",s.now()),s.now(),100)?;
 let expires=s.now()+num(&def,"expiresInSeconds")*1000;let mut r=json!({"id":id,"grantId":g["id"],"ownerId":g["ownerId"],"callerName":g["callerName"],"definition":def,"fingerprint":fp,"status":"pending","createdAt":s.now(),"expiresAt":expires,"nextCheckAt":num(&g,"expiresAt").min(expires),"terminatedAt":null,"resultExpiresAt":null,"sequence":0,"firstOpenedAt":null,"taps":{},"opens":{},"helpers":{},"purgeAt":expires+HISTORY});
 let e=s.form_event(tx,&mut r,&mut g,"request.created",json!({}))?;for d in ds{s.form_job(tx,&r,text(&e,"id"),"push",text(&d,"id"))?;}tx.merge("grants",text(&g,"id"),json!({"formRate":gr}))?;tx.merge("accounts",text(&g,"ownerId"),json!({"formRate":ar}))?;Ok(form_view(&r))})}).await?;
        self.kick().await;
        Ok(result)
    }
    pub async fn form_get(&self, auth: Auth, id: String) -> Result<Value> {
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, auth, id) = (s.clone(), auth.clone(), id.clone());
                Box::pin(async move {
                    let mut c = s.form_context(tx, &id, &auth).await?;
                    s.form_expire(tx, &mut c.r, &mut c.g, c.valid).await?;
                    Ok(form_view(&c.r))
                })
            })
            .await
    }
    pub async fn inbox(&self, uid: String, device: String) -> Result<Value> {
        let s = self.clone();
        let (u, d) = (uid.clone(), device.clone());
        let ids = self
            .store
            .tx(move |tx| {
                let (s, u, d) = (s.clone(), u.clone(), d.clone());
                Box::pin(async move {
                    s.account(tx, &u).await?;
                    let d = s.device(tx, &u, &d).await?;
                    Ok(tx
                        .query(
                            Query::new("formRequests")
                                .eq("ownerId", u)
                                .eq("status", "pending")
                                .limit(100),
                        )
                        .await?
                        .into_iter()
                        .filter(|r| {
                            r["definition"].get("steps").is_none() || d["wizardVersion"] == 1
                        })
                        .map(|r| text(&r, "id").to_owned())
                        .collect::<Vec<_>>())
                })
            })
            .await?;
        let mut out = vec![];
        for id in ids {
            let r = self
                .form_get(
                    Auth::Phone {
                        uid: uid.clone(),
                        device: device.clone(),
                    },
                    id,
                )
                .await?;
            if text(&r, "status") == "pending" {
                out.push(r);
            }
        }
        out.sort_by_key(|r| std::cmp::Reverse(num(r, "createdAt")));
        Ok(json!(out.into_iter().map(|r|json!({"requestId":r["requestId"],"callerName":r["callerName"],"title":r["title"],"status":r["status"],"expiresAt":r["expiresAt"],"createdAt":r["createdAt"]})).collect::<Vec<_>>()))
    }
    pub async fn form_cancel(&self, secret: String, id: String) -> Result<Value> {
        let s = self.clone();
        let result = self
            .store
            .tx(move |tx| {
                let (s, secret, id) = (s.clone(), secret.clone(), id.clone());
                Box::pin(async move {
                    let mut c = s.form_context(tx, &id, &Auth::Agent(secret)).await?;
                    s.form_expire(tx, &mut c.r, &mut c.g, true).await?;
                    if text(&c.r, "status") == "pending" {
                        s.form_end(tx, &mut c.r, &mut c.g, "cancelled", s.now())
                            .await?;
                    }
                    Ok(form_view(&c.r))
                })
            })
            .await?;
        self.kick().await;
        Ok(result)
    }
    pub async fn observe(
        &self,
        uid: String,
        device: String,
        id: String,
        data: Value,
    ) -> Result<Value> {
        validate("observation", &data)?;
        let s = self.clone();
        let result=self.store.tx(move|tx|{let(s,uid,device,id,data)=(s.clone(),uid.clone(),device.clone(),id.clone(),data.clone());Box::pin(async move{
 let mut c=s.form_context(tx,&id,&Auth::Phone{uid:uid.clone(),device:device.clone()}).await?;let ds=if text(&data,"type")=="input.ready"{s.devices(tx,&uid).await?}else{vec![]};s.form_expire(tx,&mut c.r,&mut c.g,c.valid).await?;let r=&mut c.r;
 if text(&data,"type")=="input.ready"{if text(r,"status")!="pending"{return Ok(form_view(r));}ensure(!flag(&c.d,"paused"),409,"device_paused")?;let fields=arr(&r["definition"],"fields");ensure(fields.iter().any(|f|f["id"]==data["fieldId"]&&text(f,"input")=="sms_code"),400,"unknown_input")?;
 if let Some(old)=r["helpers"].get(&device){ensure(old["startedAt"]==data["listenerStartedAt"],409,"input_already_started")?;return Ok(form_view(r));}let start=num(&data,"listenerStartedAt");ensure(start<=s.now()+5000&&start>s.now()-MINUTE,409,"listener_start_stale")?;
 let held=num(&c.a,"formListenerUntil")>s.now();ensure(text(&c.a,"activeRequestId").is_empty()&&if held{c.a["formListenerRequestId"]==r["id"]}else{arr(&c.a,"queueIds").is_empty()&&ds.iter().all(|d|num(d,"listenerUntil")<=s.now())},409,"sms_listener_busy")?;ensure(num(&c.d,"listenerUntil")<=s.now(),409,"sms_listener_busy")?;
 let until=(start+5*MINUTE).min(s.now()+5*MINUTE);r["helpers"][&device]=json!({"fieldId":data["fieldId"],"readyAt":s.now(),"startedAt":start,"until":until});tx.merge("devices",&device,json!({"listenerUntil":until,"formListenerUntil":until}))?;tx.merge("accounts",&uid,json!({"formListenerRequestId":r["id"],"formListenerUntil":num(&c.a,"formListenerUntil").max(until)}))?;r["helperNextAt"]=json!(r["helperNextAt"].as_i64().unwrap_or(until).min(until));s.form_event(tx,r,&mut c.g,"input.ready",json!({"deviceId":device,"fieldId":data["fieldId"]}))?;
 }else{let reports=if text(&data,"type")=="notification.tapped"{"taps"}else{"opens"};if r[reports].get(&device).is_some(){return Ok(form_view(r));}let observed=num(r,"createdAt").max(data["occurredAt"].as_i64().unwrap_or(s.now()).min(s.now()));r[reports][&device]=json!(observed);if text(&data,"type")=="request.opened"{r["firstOpenedAt"]=json!(r["firstOpenedAt"].as_i64().unwrap_or(observed).min(observed));}s.form_event(tx,r,&mut c.g,text(&data,"type"),json!({"deviceId":device,"observedAt":observed}))?;}Ok(form_view(r))})}).await?;
        self.kick().await;
        Ok(result)
    }
    pub async fn submit(
        &self,
        uid: String,
        device: String,
        id: String,
        input: Value,
    ) -> Result<Value> {
        validate("submission", &input)?;
        let fp = hash(&js_json(&input, true));
        let s = self.clone();
        let out=self.store.tx(move|tx|{let(s,uid,device,id,input,fp)=(s.clone(),uid.clone(),device.clone(),id.clone(),input.clone(),fp.clone());Box::pin(async move{
 let mut c=s.form_context(tx,&id,&Auth::Phone{uid:uid.clone(),device:device.clone()}).await?;s.form_expire(tx,&mut c.r,&mut c.g,c.valid).await?;let r=&mut c.r;
 if r["winner"]["deviceId"]==device&&r["winner"]["submissionId"]==input["submissionId"]{ensure(text(&r["winner"],"fingerprint")==fp,409,"submission_conflict")?;return Ok(form_view(r));}
if text(r,"status")!="pending"{return Ok(form_view(r));}ensure(!flag(&c.d,"paused"),409,"device_paused")?;let status=validate_submission(&r["definition"],&input)?;r["winner"]=json!({"deviceId":device,"submissionId":input["submissionId"],"fingerprint":fp});
 if status=="submitted"{r["resultExpiresAt"]=json!(s.now()+DAY);}s.form_end(tx,r,&mut c.g,status,s.now()).await?;if status=="submitted"{tx.create("formResults",&id,json!({"ownerId":uid,"grantId":c.g["id"],"action":input["action"],"values":input["values"],"submittedAt":s.now(),"expiresAt":r["resultExpiresAt"],"purgeAt":r["resultExpiresAt"]}))?;}Ok(form_view(r))})}).await?;
        self.kick().await;
        Ok(out)
    }
    pub async fn form_result(&self, secret: String, id: String) -> Result<Value> {
        let s = self.clone();
        self.store.tx(move|tx|{let(s,secret,id)=(s.clone(),secret.clone(),id.clone());Box::pin(async move{let mut c=s.form_context(tx,&id,&Auth::Agent(secret)).await?;let result=tx.get("formResults",&id).await?;s.form_expire(tx,&mut c.r,&mut c.g,true).await?;Ok(json!({"requestId":id,"status":c.r["status"],"result":if text(&c.r,"status")=="submitted"&&!result.is_null()&&num(&result,"expiresAt")>s.now(){json!({"action":result["action"],"values":result["values"],"submittedAt":result["submittedAt"]})}else{Value::Null}}))})}).await
    }
    pub async fn events(&self, secret: String, cursor: Option<String>) -> Result<Value> {
        let s = self.clone();
        let g = self
            .store
            .tx(move |tx| {
                let (s, secret) = (s.clone(), secret.clone());
                Box::pin(async move { Ok(s.form_agent(tx, &secret).await?.0) })
            })
            .await?;
        let mut seq = 0;
        if let Some(c) = &cursor
            && !c.is_empty()
        {
            let prefix = format!("{}_", text(&g, "id"));
            ensure(
                c.starts_with(&prefix)
                    && c.len() == prefix.len() + 16
                    && c[prefix.len()..].bytes().all(|b| b.is_ascii_digit()),
                400,
                "invalid_cursor",
            )?;
            seq = c[prefix.len()..].parse::<i64>().unwrap();
            ensure(seq <= num(&g, "eventSequence"), 400, "invalid_cursor")?;
        }
        let events = self
            .store
            .query(
                Query::new("requestEvents")
                    .eq("grantId", g["id"].clone())
                    .cmp("sequence", ">", seq)
                    .cmp("purgeAt", ">", self.now())
                    .order("sequence", false)
                    .order("purgeAt", false)
                    .limit(100),
            )
            .await?
            .into_iter()
            .map(public_event)
            .collect::<Vec<_>>();
        let next = events
            .last()
            .map(|e| e["id"].clone())
            .unwrap_or(json!(cursor));
        Ok(json!({"events":events,"cursor":next}))
    }
    pub async fn register_webhook(&self, secret: String, input: Value) -> Result<Value> {
        validate("webhook", &input)?;
        let s = self.clone();
        let key = secret.clone();
        self.store
            .tx(move |tx| {
                let (s, key) = (s.clone(), key.clone());
                Box::pin(async move {
                    s.form_agent(tx, &key).await?;
                    Ok(())
                })
            })
            .await?;
        crate::webhooks::destination(text(&input, "url")).await?;
        let mut hook = input;
        hook["id"] = json!(Uuid::new_v4().to_string());
        hook["secret"] = json!(crate::webhooks::hook_secret());
        let s = self.clone();
        let h = hook.clone();
        self.store
            .tx(move |tx| {
                let (s, secret, h) = (s.clone(), secret.clone(), h.clone());
                Box::pin(async move {
                    let (g, _) = s.form_agent(tx, &secret).await?;
                    let mut hooks = arr(&g, "webhooks");
                    ensure(hooks.len() < 5, 409, "webhook_limit")?;
                    hooks.push(h);
                    tx.merge("grants", text(&g, "id"), json!({"webhooks":hooks}))
                })
            })
            .await?;
        Ok(hook)
    }
    pub async fn webhooks(&self, secret: String, remove: Option<String>) -> Result<Value> {
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, secret, remove) = (s.clone(), secret.clone(), remove.clone());
                Box::pin(async move {
                    let (g, _) = s.form_agent(tx, &secret).await?;
                    let hooks = arr(&g, "webhooks")
                        .into_iter()
                        .filter(|h| remove.as_deref() != Some(text(h, "id")))
                        .collect::<Vec<_>>();
                    if remove.is_some() {
                        tx.merge("grants", text(&g, "id"), json!({"webhooks":hooks}))?;
                    }
                    Ok(json!(
                        hooks
                            .into_iter()
                            .map(|mut h| {
                                h.as_object_mut().unwrap().remove("secret");
                                h
                            })
                            .collect::<Vec<_>>()
                    ))
                })
            })
            .await
    }
    pub async fn cancel_grant(&self, id: &str) -> Result<()> {
        let docs = self
            .store
            .query(
                Query::new("formRequests")
                    .eq("grantId", id)
                    .eq("status", "pending"),
            )
            .await?;
        for doc in &docs {
            let s = self.clone();
            let rid = text(doc, "id").to_owned();
            let gid = id.to_owned();
            self.store
                .tx(move |tx| {
                    let (s, rid, gid) = (s.clone(), rid.clone(), gid.clone());
                    Box::pin(async move {
                        let mut r = tx.get("formRequests", &rid).await?;
                        let mut g = tx.get("grants", &gid).await?;
                        if text(&r, "status") == "pending"
                            && !g.is_null()
                            && (!flag(&g, "formsApproved") || !s.valid_grant(&g))
                        {
                            s.form_end(tx, &mut r, &mut g, "cancelled", s.now()).await?;
                        }
                        Ok(())
                    })
                })
                .await?;
        }
        let id = id.to_owned();
        self.store
            .tx(move |tx| {
                let id = id.clone();
                Box::pin(async move {
                    let g = tx.get("grants", &id).await?;
                    if flag(&g, "formsCancellationPending") {
                        tx.merge("grants", &id, json!({"formsCancellationPending":false}))?;
                    }
                    Ok(())
                })
            })
            .await?;
        if !docs.is_empty() {
            self.kick().await;
        }
        Ok(())
    }
}
