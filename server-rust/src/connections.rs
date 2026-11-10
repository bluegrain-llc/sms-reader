use crate::{
    error::{Result, ensure},
    model::*,
    relay::Relay,
};
use rand::RngCore;
use serde_json::{Value, json};
pub fn user_code(s: &str) -> Result<String> {
    ensure(s.chars().count() <= 32, 400, "invalid_input")?;
    let code = s.to_uppercase().replace([' ', '-'], "");
    ensure(
        code.len() == 10
            && code
                .bytes()
                .all(|c| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&c)),
        400,
        "invalid_input",
    )?;
    Ok(code)
}
fn formatted(c: &str) -> String {
    format!("{}-{}", &c[..5], &c[5..])
}
fn view(c: &Value) -> Value {
    json!({"connectionId":c["id"],"callerName":c["callerName"],"purpose":c["purpose"],"status":c["status"],"expiresAt":c["expiresAt"],"expiresInDays":c["days"],"grantExpiresAt":c["grantExpiresAt"]})
}
impl Relay {
    pub async fn connection_start(&self, source: String, input: Value) -> Result<Value> {
        strict(&input, &["callerName", "purpose", "expiresInDays"])?;
        let name = string(&input, "callerName", 1, 80, true)?;
        let purpose = string(&input, "purpose", 1, 240, true)?;
        let days = integer(&input, "expiresInDays", 1, 90, Some(30))?;
        let token = secret();
        let id = hash(&token);
        let mut bytes = [0; 10];
        rand::rng().fill_bytes(&mut bytes);
        let alphabet = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = bytes
            .iter()
            .map(|b| alphabet[(b % 32) as usize] as char)
            .collect::<String>();
        let s = self.clone();
        let c = code.clone();
        self.store.tx(move|tx|{let(s,source,id,code,name,purpose)=(s.clone(),source.clone(),id.clone(),c.clone(),name.clone(),purpose.clone());Box::pin(async move{
 let window=s.now()/(10*MINUTE);let limits=[(hash(&format!("source:{source}:{window}")),60),(format!("global-{window}"),600)];let mut rates=vec![];for(k,max)in &limits{let r=tx.get("connectionRates",k).await?;let mut v=bump(&if r.is_null(){json!({"start":s.now(),"count":0})}else{r},s.now(),*max)?;v["purgeAt"]=json!((window+1)*10*MINUTE);rates.push(v);}
 let code_id=hash(&code);ensure(tx.get("connectionCodes",&code_id).await?.is_null(),409,"connection_code_collision")?;
 let c=json!({"id":id,"callerName":name,"purpose":purpose,"days":days,"codeHash":code_id,"status":"pending","ownerId":null,"createdAt":s.now(),"expiresAt":s.now()+10*MINUTE,"grantExpiresAt":null,"pollAfter":0,"purgeAt":s.now()+HISTORY});
 for((key,_),rate)in limits.iter().zip(rates){tx.set("connectionRates",key,rate)?;}tx.create("connections",&id,c)?;tx.create("connectionCodes",&code_id,json!({"connectionId":id,"purgeAt":s.now()+10*MINUTE,"ownerId":null}))?;Ok(())})}).await?;
        Ok(
            json!({"connectionToken":token,"userCode":formatted(&code),"expiresAt":self.now()+10*MINUTE,"interval":5}),
        )
    }
    pub async fn connection_poll(&self, token: String) -> Result<Value> {
        ensure(valid_secret(&token), 401, "invalid_connection_token")?;
        let s = self.clone();
        self.store.tx(move|tx|{let(s,token)=(s.clone(),token.clone());Box::pin(async move{
 let id=hash(&token);let mut c=tx.get("connections",&id).await?;ensure(!c.is_null(),401,"invalid_connection_token")?;let g=if text(&c,"status")=="approved"{tx.get("grants",&id).await?}else{Value::Null};let valid=s.valid_grant(&g);
 if !text(&c,"ownerId").is_empty(){s.account(tx,text(&c,"ownerId")).await?;}
if text(&c,"status")=="pending"&&num(&c,"expiresAt")<=s.now(){c["status"]=json!("expired");}ensure(num(&c,"pollAfter")<=s.now(),429,"slow_down")?;c["pollAfter"]=json!(s.now()+5000);tx.set("connections",&id,c.clone())?;
 Ok(json!({"status":if text(&c,"status")=="approved"&&!valid{json!("revoked")}else{c["status"].clone()},"expiresAt":c["expiresAt"],"grantExpiresAt":c["grantExpiresAt"],"interval":5}))})}).await
    }
    pub async fn connection_owner(
        &self,
        uid: String,
        raw: String,
        decision: Option<String>,
    ) -> Result<Value> {
        let code = user_code(&raw)?;
        let s = self.clone();
        let output=self.store.tx(move|tx|{let(s,uid,code,decision)=(s.clone(),uid.clone(),code.clone(),decision.clone());Box::pin(async move{
 let a=s.account(tx,&uid).await?;let code_id=hash(&code);let link=tx.get("connectionCodes",&code_id).await?;let mut c=if link.is_null(){Value::Null}else{tx.get("connections",text(&link,"connectionId")).await?};
 let g=if text(&c,"status")=="approved"&&text(&c,"ownerId")==uid{tx.get("grants",text(&c,"id")).await?}else{Value::Null};let revoked=text(&c,"status")=="approved"&&!s.valid_grant(&g);
 let rate=bump(&rate(&a,"connectionRate",s.now()),s.now(),30)?;tx.merge("accounts",&uid,json!({"connectionRate":rate}))?;
 if c.is_null()||(!text(&c,"ownerId").is_empty()&&text(&c,"ownerId")!=uid){return Ok(Value::Null);}
 if text(&c,"status")=="pending"&&num(&c,"expiresAt")<=s.now(){c["status"]=json!("expired");tx.set("connections",text(&c,"id"),c.clone())?;}
 if let Some(decision)=decision&& text(&c,"status")=="pending"{c["status"]=json!(decision);c["ownerId"]=json!(uid);if decision=="approved"{c["grantExpiresAt"]=json!(s.now()+num(&c,"days")*DAY);tx.create("grants",text(&c,"id"),json!({"id":c["id"],"ownerId":uid,"deviceId":"","callerName":c["callerName"],"callerId":c["id"],"revoked":false,"createdAt":s.now(),"expiresAt":c["grantExpiresAt"],"rate":{"start":s.now(),"count":0}}))?;}tx.set("connections",text(&c,"id"),c.clone())?;tx.merge("connectionCodes",&code_id,json!({"ownerId":uid}))?;}
 let mut v=view(&c);if revoked{v["status"]=json!("revoked");}v["userCode"]=json!(formatted(&code));Ok(v)})}).await?;
        ensure(!output.is_null(), 404, "connection_not_found")?;
        Ok(output)
    }
}
