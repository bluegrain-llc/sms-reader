use crate::{error::Result, forms_model::public_event, model::*, relay::*, store::Query};
use serde_json::{Value, json};
use uuid::Uuid;
fn delivery_summary(r: &mut Value) {
    let unsent = r["phones"]
        .as_object()
        .unwrap()
        .values()
        .filter(|p| !flag(p, "sent"))
        .collect::<Vec<_>>();
    let at = unsent
        .iter()
        .map(|p| num(p, "nextAt").max(num(p, "lease")))
        .min()
        .unwrap_or(num(r, "expiresAt"));
    let done = unsent.is_empty();
    r["notificationSent"] = json!(done);
    r["nextNotificationAt"] = json!(at);
}
impl Relay {
    pub async fn deliver_sms(&self, id: String) -> Result<()> {
        let s = self.clone();
        let rid = id.clone();
        let claims=self.store.tx(move|tx|{let(s,id)=(s.clone(),rid.clone());Box::pin(async move{
 let mut r=tx.get("requests",&id).await?;if !active(text(&r,"status"))||text(&r,"status")=="queued"||flag(&r,"notificationSent")||num(&r,"nextNotificationAt")>s.now(){return Ok(vec![]);}
 let g=tx.get("grants",text(&r,"grantId")).await?;let a=tx.get("accounts",text(&r,"ownerId")).await?;if flag(&a,"deleting"){tx.merge("requests",&id,json!({"status":"cancelled","reason":"account_deleted","notificationSent":true}))?;return Ok(vec![]);}let ds=s.devices(tx,text(&r,"ownerId")).await?;s.expire(tx,&mut r,&a,s.valid_grant(&g),&ds)?;if !active(text(&r,"status")){return Ok(vec![]);}r["phones"]=phones(&r);let ttl=num(&r,"expiresAt")-s.now();let created_at=r["createdAt"].clone();let mut plans=vec![];
 for(device,p)in r["phones"].as_object_mut().unwrap(){let d=ds.iter().find(|d|text(d,"id")==device);if d.is_none()||!active(text(p,"status")){p["sent"]=json!(true);continue;}
if flag(p,"sent")||num(p,"lease")>s.now()||num(p,"nextAt")>s.now(){continue;}p["lease"]=json!(s.now()+MINUTE);p["attempts"]=json!(num(p,"attempts")+1);plans.push(json!({"deviceId":device,"token":d.unwrap()["fcmToken"],"lease":p["lease"],"attempts":p["attempts"],"ttl":ttl,"createdAt":created_at}));}
 delivery_summary(&mut r);tx.set("requests",&id,r)?;Ok(plans)})}).await?;
        let results = futures::future::join_all(claims.into_iter().map(|claim| {
            let s = self.clone();
            let id = id.clone();
            async move {
                let delivery_result = s
                    .delivery
                    .notify(text(&claim, "token"), &id, num(&claim, "ttl"), false)
                    .await;
                s.telemetry_delivery("sms", num(&claim, "createdAt"), &delivery_result)
                    .await;
                let sent = delivery_result.is_ok();
                s.store
                    .clone()
                    .tx(move |tx| {
                        let (s, id, claim) = (s.clone(), id.clone(), claim.clone());
                        Box::pin(async move {
                            let mut r = tx.get("requests", &id).await?;
                            if r.get("phones").is_none() || !active(text(&r, "status")) {
                                return Ok(());
                            }
                            let p = &mut r["phones"][text(&claim, "deviceId")];
                            if p.is_null() || p["lease"] != claim["lease"] {
                                return Ok(());
                            }
                            p["sent"] = json!(sent);
                            p["lease"] = json!(0);
                            p["nextAt"] = json!(
                                s.now()
                                    + (5 * MINUTE)
                                        .min((1 << num(&claim, "attempts").min(10)) * 1000)
                            );
                            delivery_summary(&mut r);
                            tx.set("requests", &id, r)
                        })
                    })
                    .await
            }
        }))
        .await;
        for r in results {
            r?;
        }
        Ok(())
    }
    pub async fn deliver_form(&self, id: String) -> Result<()> {
        let lease = Uuid::new_v4().to_string();
        let s = self.clone();
        let (rid, l) = (id.clone(), lease.clone());
        let claim=self.store.tx(move|tx|{let(s,id,lease)=(s.clone(),rid.clone(),l.clone());Box::pin(async move{
 let j=tx.get("deliveryOutbox",&id).await?;if j.is_null()||num(&j,"nextAt")>s.now(){return Ok(Value::Null);}let g=tx.get("grants",text(&j,"grantId")).await?;let r=tx.get("formRequests",text(&j,"requestId")).await?;let a=tx.get("accounts",text(&j,"ownerId")).await?;let e=tx.get("requestEvents",text(&j,"eventId")).await?;let d=if text(&j,"deviceId").is_empty(){Value::Null}else{tx.get("devices",text(&j,"deviceId")).await?};let hook=arr(&g,"webhooks").into_iter().find(|h|h["id"]==j["hookId"]);
 if r.is_null()||e.is_null()||num(&j,"purgeAt")<=s.now()||flag(&a,"deleting")||!flag(&g,"formsApproved")||!s.valid_grant(&g)||(text(&j,"kind")=="push"&&(text(&r,"status")!="pending"||num(&r,"expiresAt")<=s.now()||d.is_null()||flag(&d,"deleted")||flag(&d,"paused")||d["ownerId"]!=j["ownerId"]||(r["definition"].get("steps").is_some()&&d["wizardVersion"]!=1)))||(text(&j,"kind")=="webhook"&&hook.is_none()){tx.delete("deliveryOutbox",&id)?;return Ok(Value::Null);}
 tx.merge("deliveryOutbox",&id,json!({"lease":lease,"nextAt":s.now()+MINUTE,"attempts":num(&j,"attempts")+1}))?;Ok(json!({"j":j,"r":r,"e":e,"token":d["fcmToken"],"hook":hook}))})}).await?;
        if claim.is_null() {
            return Ok(());
        }
        let push = text(&claim["j"], "kind") == "push";
        let delivery_result = if push {
            self.delivery
                .notify(
                    text(&claim, "token"),
                    text(&claim["r"], "id"),
                    num(&claim["r"], "expiresAt") - self.now(),
                    true,
                )
                .await
        } else {
            self.delivery
                .webhook(
                    text(&claim["hook"], "url"),
                    text(&claim["hook"], "secret"),
                    &public_event(claim["e"].clone()),
                )
                .await
        };
        self.telemetry_delivery(
            if push { "form" } else { "webhook" },
            num(&claim["r"], "createdAt"),
            &delivery_result,
        )
        .await;
        let sent = delivery_result.is_ok();
        let s = self.clone();
        self.store.tx(move|tx|{let(s,id,lease)=(s.clone(),id.clone(),lease.clone());Box::pin(async move{let j=tx.get("deliveryOutbox",&id).await?;if j.is_null()||text(&j,"lease")!=lease{return Ok(());}let mut r=tx.get("formRequests",text(&j,"requestId")).await?;let mut g=tx.get("grants",text(&j,"grantId")).await?;
 if sent{tx.delete("deliveryOutbox",&id)?;if text(&j,"kind")=="push"&&!r.is_null()&&!g.is_null(){s.form_event(tx,&mut r,&mut g,"notification.accepted",json!({"deviceId":j["deviceId"]}))?;}}else{tx.merge("deliveryOutbox",&id,json!({"lease":null,"nextAt":s.now()+(60*MINUTE).min(1000*(1<<(num(&j,"attempts")+1).min(12)))}))?;}Ok(())})}).await?;
        if sent && push {
            self.kick().await;
        }
        Ok(())
    }
    pub async fn dispatch(&self) -> Result<()> {
        let jobs = self
            .store
            .query(
                Query::new("deliveryOutbox")
                    .cmp("nextAt", "<=", self.now())
                    .limit(50),
            )
            .await?;
        for batch in jobs.chunks(10) {
            for r in futures::future::join_all(
                batch
                    .iter()
                    .map(|d| self.deliver_form(text(d, "id").to_owned())),
            )
            .await
            {
                r?;
            }
        }
        if jobs.len() == 50 {
            self.kick().await;
        }
        Ok(())
    }
    pub async fn maintenance(&self) -> Result<()> {
        let accounts = self
            .store
            .query(Query::new("accounts").eq("hasWork", true).limit(250))
            .await?;
        for a in accounts {
            if !flag(&a, "deleting") {
                self.advance(text(&a, "__id")).await?;
            }
        }
        for query in crate::telemetry::due_sms_queries(self.now()) {
            let docs = self.store.query(query.limit(250)).await?;
            for batch in docs.chunks(10) {
                for r in futures::future::join_all(
                    batch
                        .iter()
                        .map(|r| self.deliver_sms(text(r, "id").to_owned())),
                )
                .await
                {
                    r?;
                }
            }
        }
        for c in [
            "results",
            "requests",
            "audit",
            "connections",
            "connectionCodes",
            "connectionRates",
        ] {
            self.cleanup(c).await?;
        }
        self.form_maintenance().await?;
        self.access_cleanup().await
    }
    async fn cleanup(&self, c: &str) -> Result<()> {
        let docs = self
            .store
            .query(Query::new(c).cmp("purgeAt", "<=", self.now()).limit(400))
            .await?;
        let c = c.to_owned();
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
            .await
    }
    pub async fn form_maintenance(&self) -> Result<()> {
        let revoked = self
            .store
            .query(
                Query::new("grants")
                    .eq("formsCancellationPending", true)
                    .limit(250),
            )
            .await?;
        for g in revoked {
            self.cancel_grant(text(&g, "id")).await?;
        }
        let helpers = self
            .store
            .query(
                Query::new("formRequests")
                    .eq("status", "pending")
                    .cmp("helperNextAt", "<=", self.now())
                    .limit(250),
            )
            .await?;
        for doc in helpers {
            let s = self.clone();
            let id = text(&doc, "id").to_owned();
            self.store
                .tx(move |tx| {
                    let (s, id) = (s.clone(), id.clone());
                    Box::pin(async move {
                        let mut r = tx.get("formRequests", &id).await?;
                        let mut g = tx.get("grants", text(&r, "grantId")).await?;
                        if g.is_null() || text(&r, "status") != "pending" {
                            return Ok(());
                        }
                        let due = r["helpers"]
                            .as_object()
                            .unwrap()
                            .iter()
                            .filter(|(_, h)| num(h, "until") <= s.now() && !flag(h, "timedOut"))
                            .map(|(id, h)| (id.clone(), h["fieldId"].clone()))
                            .collect::<Vec<_>>();
                        for (device, field) in due {
                            r["helpers"][&device]["timedOut"] = json!(true);
                            s.form_event(
                                tx,
                                &mut r,
                                &mut g,
                                "input.timeout",
                                json!({"deviceId":device,"fieldId":field}),
                            )?;
                        }
                        let next = r["helpers"]
                            .as_object()
                            .unwrap()
                            .values()
                            .filter(|h| !flag(h, "timedOut"))
                            .map(|h| num(h, "until"))
                            .min()
                            .unwrap_or(9_007_199_254_740_991);
                        tx.merge("formRequests", &id, json!({"helperNextAt":next}))
                    })
                })
                .await?;
        }
        let expired = self
            .store
            .query(
                Query::new("formRequests")
                    .eq("status", "pending")
                    .cmp("nextCheckAt", "<=", self.now())
                    .limit(250),
            )
            .await?;
        for doc in expired {
            let s = self.clone();
            let id = text(&doc, "id").to_owned();
            self.store
                .tx(move |tx| {
                    let (s, id) = (s.clone(), id.clone());
                    Box::pin(async move {
                        let mut r = tx.get("formRequests", &id).await?;
                        let mut g = tx.get("grants", text(&r, "grantId")).await?;
                        if text(&r, "status") == "pending" && !g.is_null() {
                            let valid = flag(&g, "formsApproved") && s.valid_grant(&g);
                            s.form_expire(tx, &mut r, &mut g, valid).await?;
                        }
                        Ok(())
                    })
                })
                .await?;
        }
        self.dispatch().await?;
        for c in [
            "formResults",
            "formRequests",
            "requestEvents",
            "deliveryOutbox",
        ] {
            self.cleanup(c).await?;
        }
        Ok(())
    }
}
