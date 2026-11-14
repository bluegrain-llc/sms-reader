use crate::worker_context::WorkerContext;
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
 let g=tx.get("grants",text(&r,"grantId")).await?;let a=tx.get("accounts",text(&r,"ownerId")).await?;if flag(&a,"deleting"){tx.merge("requests",&id,json!({"status":"cancelled","reason":"account_deleted","notificationSent":true}))?;return Ok(vec![]);}let ds=s.devices(tx,text(&r,"ownerId")).await?;s.expire(tx,&mut r,&a,s.valid_grant(tx, &g).await? && crate::onboarding::capability(&g,"sms"),&ds)?;if !active(text(&r,"status")){return Ok(vec![]);}r["phones"]=phones(&r);let ttl=num(&r,"expiresAt")-s.now();let created_at=r["createdAt"].clone();let mut plans=vec![];
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
        self.deliver_form_with_context(id, None).await
    }
    pub async fn deliver_form_with_context(
        &self,
        id: String,
        context: Option<&WorkerContext>,
    ) -> Result<()> {
        let lease = Uuid::new_v4().to_string();
        let s = self.clone();
        let (rid, l) = (id.clone(), lease.clone());
        let claim_trace = context.map(|c| c.trace().to_owned());
        let claim=self.store.tx(move|tx|{let(s,id,lease,claim_trace)=(s.clone(),rid.clone(),l.clone(),claim_trace.clone());Box::pin(async move{
 let j=tx.get("deliveryOutbox",&id).await?;if j.is_null()||num(&j,"nextAt")>s.now(){return Ok(Value::Null);}let g=tx.get("grants",text(&j,"grantId")).await?;let r=tx.get("formRequests",text(&j,"requestId")).await?;let a=tx.get("accounts",text(&j,"ownerId")).await?;let e=tx.get("requestEvents",text(&j,"eventId")).await?;let d=if text(&j,"deviceId").is_empty(){Value::Null}else{tx.get("devices",text(&j,"deviceId")).await?};let hook=arr(&g,"webhooks").into_iter().find(|h|h["id"]==j["hookId"]);
 if r.is_null()||e.is_null()||num(&j,"purgeAt")<=s.now()||flag(&a,"deleting")||!crate::forms::allowed(&g,&r["definition"])||!s.valid_grant(tx, &g).await?||(text(&j,"kind")=="push"&&(text(&r,"status")!="pending"||num(&r,"expiresAt")<=s.now()||d.is_null()||flag(&d,"deleted")||flag(&d,"paused")||d["ownerId"]!=j["ownerId"]||(r["definition"].get("steps").is_some()&&d["wizardVersion"]!=1)))||(text(&j,"kind")=="webhook"&&hook.is_none()){tx.delete("deliveryOutbox",&id)?;return Ok(Value::Null);}
 tx.merge("deliveryOutbox",&id,json!({"lease":lease,"claimTrace":claim_trace,"nextAt":s.now()+MINUTE,"attempts":num(&j,"attempts")+1}))?;Ok(json!({"j":j,"r":r,"e":e,"token":d["fcmToken"],"hook":hook}))})}).await?;
        if claim.is_null() {
            return Ok(());
        }
        let push = text(&claim["j"], "kind") == "push";
        let mut event =
            json!({"event":"delivery_lease_claimed","kind":if push { "form" } else { "webhook" }});
        if let Some(context) = context {
            event["logging.googleapis.com/trace"] = json!(context.trace());
        }
        self.delivery.record(event).await;
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
        self.dispatch_with_context(None).await
    }
    pub async fn dispatch_with_context(&self, context: Option<&WorkerContext>) -> Result<()> {
        let count = self
            .maintenance_page(
                "form-delivery",
                Query::new("deliveryOutbox").cmp("nextAt", "<=", self.now()),
                Some("nextAt"),
                50,
                10,
                |id| self.deliver_form_with_context(id, context),
            )
            .await?;
        if count == 50 {
            self.kick().await;
        }
        Ok(())
    }
    pub async fn maintenance(&self) -> Result<()> {
        self.maintenance_with_context(None).await
    }
    pub async fn maintenance_with_context(&self, context: Option<&WorkerContext>) -> Result<()> {
        self.onboarding_cleanup().await?;
        self.maintenance_page(
            "active-owners",
            Query::new("accounts").eq("hasWork", true),
            None,
            250,
            8,
            |id| async move {
                let account = self.store.get("accounts", &id).await?;
                if !flag(&account, "deleting") {
                    self.advance(&id).await?;
                }
                Ok(())
            },
        )
        .await?;
        for (index, query) in crate::telemetry::due_sms_queries(self.now())
            .into_iter()
            .enumerate()
        {
            self.maintenance_page(
                &format!("sms-{index}"),
                query,
                Some("nextNotificationAt"),
                250,
                10,
                |id| self.deliver_sms(id),
            )
            .await?;
        }
        for collection in [
            "results",
            "requests",
            "audit",
            "connections",
            "connectionCodes",
            "connectionRates",
        ] {
            self.maintenance_purge(collection, self.now()).await?;
        }
        self.form_maintenance_with_context(context).await?;
        self.access_cleanup().await
    }
    pub async fn form_maintenance(&self) -> Result<()> {
        self.form_maintenance_with_context(None).await
    }
    pub async fn form_maintenance_with_context(
        &self,
        context: Option<&WorkerContext>,
    ) -> Result<()> {
        self.maintenance_page(
            "revoked-forms",
            Query::new("grants").eq("formsCancellationPending", true),
            None,
            250,
            8,
            |id| async move { self.cancel_grant(&id).await },
        )
        .await?;
        self.maintenance_page(
            "helper-timeouts",
            Query::new("formRequests").eq("status", "pending").cmp(
                "helperNextAt",
                "<=",
                self.now(),
            ),
            Some("helperNextAt"),
            250,
            8,
            |id| self.maintenance_helper(id),
        )
        .await?;
        self.maintenance_page(
            "form-expiry",
            Query::new("formRequests")
                .eq("status", "pending")
                .cmp("nextCheckAt", "<=", self.now()),
            Some("nextCheckAt"),
            250,
            8,
            |id| self.maintenance_form_expire(id),
        )
        .await?;
        self.dispatch_with_context(context).await?;
        for collection in [
            "formResults",
            "formRequests",
            "requestEvents",
            "deliveryOutbox",
        ] {
            self.maintenance_purge(collection, self.now()).await?;
        }
        Ok(())
    }
    async fn maintenance_helper(&self, id: String) -> Result<()> {
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, id) = (s.clone(), id.clone());
                Box::pin(async move {
                    let mut r = tx.get("formRequests", &id).await?;
                    if r.is_null() {
                        return Ok(());
                    }
                    let mut g = tx.get("grants", text(&r, "grantId")).await?;
                    if g.is_null() || text(&r, "status") != "pending" {
                        return Ok(());
                    }
                    let due = r["helpers"]
                        .as_object()
                        .ok_or(crate::error::Error::External)?
                        .iter()
                        .filter(|(_, helper)| {
                            num(helper, "until") <= s.now() && !flag(helper, "timedOut")
                        })
                        .map(|(id, helper)| (id.clone(), helper["fieldId"].clone()))
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
                        .ok_or(crate::error::Error::External)?
                        .values()
                        .filter(|helper| !flag(helper, "timedOut"))
                        .map(|helper| num(helper, "until"))
                        .min()
                        .unwrap_or(9_007_199_254_740_991);
                    tx.merge("formRequests", &id, json!({"helperNextAt":next}))
                })
            })
            .await
    }
    async fn maintenance_form_expire(&self, id: String) -> Result<()> {
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, id) = (s.clone(), id.clone());
                Box::pin(async move {
                    let mut r = tx.get("formRequests", &id).await?;
                    if r.is_null() {
                        return Ok(());
                    }
                    let mut g = tx.get("grants", text(&r, "grantId")).await?;
                    if text(&r, "status") == "pending" && !g.is_null() {
                        let valid = crate::forms::allowed(&g, &r["definition"])
                            && s.valid_grant(tx, &g).await?;
                        s.form_expire(tx, &mut r, &mut g, valid).await?;
                    }
                    Ok(())
                })
            })
            .await
    }
}
