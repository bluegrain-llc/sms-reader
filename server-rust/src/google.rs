use crate::{
    error::{Error, Result, ensure},
    model::*,
    relay::Delivery,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, OnceCell};
#[derive(Clone)]
pub struct Google {
    pub project: String,
    client: reqwest::Client,
    provider: Arc<OnceCell<Arc<dyn gcp_auth::TokenProvider>>>,
    firebase: Arc<Mutex<Keys>>,
    worker: Arc<Mutex<Keys>>,
    pub auth_emulator: Option<String>,
    pub service_url: Option<String>,
    pub scheduler: Option<String>,
    pub queue: Option<String>,
}
#[derive(Default)]
struct Keys {
    set: Option<JwkSet>,
    until: i64,
}
#[derive(Clone)]
pub struct Identity {
    pub uid: String,
    pub auth_time: f64,
}
fn provider_transport(error: reqwest::Error) -> Error {
    Error::Provider(if error.is_timeout() {
        "timeout"
    } else {
        "unavailable"
    })
}
fn provider_response(status: u16, response: &Value) -> Error {
    let details = response["error"]["details"].as_array();
    let fcm = details
        .into_iter()
        .flatten()
        .filter(|d| d["@type"] == "type.googleapis.com/google.firebase.fcm.v1.FcmError")
        .find_map(|d| d["errorCode"].as_str());
    Error::Provider(match fcm {
        Some("UNREGISTERED") => "destination",
        Some("QUOTA_EXCEEDED") => "quota",
        Some("UNAVAILABLE") => "unavailable",
        _ => match status {
            429 => "quota",
            502 | 503 => "unavailable",
            504 => "timeout",
            _ => "internal",
        },
    })
}
impl Google {
    pub fn new(project: String) -> Self {
        Self {
            project,
            client: reqwest::Client::builder()
                .tls_backend_rustls()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            provider: Arc::new(OnceCell::new()),
            firebase: Arc::new(Mutex::new(Keys::default())),
            worker: Arc::new(Mutex::new(Keys::default())),
            auth_emulator: std::env::var("FIREBASE_AUTH_EMULATOR_HOST").ok(),
            service_url: std::env::var("SERVICE_URL").ok(),
            scheduler: std::env::var("SCHEDULER_EMAIL").ok(),
            queue: std::env::var("DELIVERY_QUEUE").ok(),
        }
    }
    async fn access(&self) -> Result<String> {
        let p = self
            .provider
            .get_or_try_init(|| async { gcp_auth::provider().await.map_err(|_| Error::External) })
            .await?;
        Ok(p.token(&["https://www.googleapis.com/auth/cloud-platform"])
            .await
            .map_err(|_| Error::External)?
            .as_str()
            .into())
    }
    async fn api(&self, url: String, body: Value, emulator: bool) -> Result<Value> {
        let mut request = self.client.post(url).json(&body);
        if emulator {
            request = request.bearer_auth("owner");
        } else {
            request = request.bearer_auth(self.access().await?);
        }
        let r = request.send().await.map_err(provider_transport)?;
        if !r.status().is_success() {
            let status = r.status().as_u16();
            let error = r.json::<Value>().await.unwrap_or(Value::Null);
            if error["error"]["message"] == "USER_NOT_FOUND" {
                return Err(Error::Api(404, "auth/user-not-found"));
            }
            return Err(provider_response(status, &error));
        }
        r.json().await.map_err(|_| Error::External)
    }
    async fn jwt(&self, token: &str, worker: bool) -> Result<Value> {
        let header = decode_header(token).map_err(|_| Error::External)?;
        ensure(header.alg == Algorithm::RS256, 401, "invalid_owner_session")?;
        let kid = header.kid.ok_or(Error::External)?;
        let mut keys = if worker {
            self.worker.lock().await
        } else {
            self.firebase.lock().await
        };
        let cache_valid = keys.until > now() && keys.set.is_some();
        if !cache_valid {
            let url = if worker {
                "https://www.googleapis.com/oauth2/v3/certs"
            } else {
                "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
            };
            let r = self
                .client
                .get(url)
                .send()
                .await
                .map_err(|_| Error::External)?
                .error_for_status()
                .map_err(|_| Error::External)?;
            let max_age = r
                .headers()
                .get("cache-control")
                .and_then(|h| h.to_str().ok())
                .and_then(|h| {
                    h.split(',').find_map(|p| {
                        p.trim()
                            .strip_prefix("max-age=")
                            .and_then(|v| v.parse::<i64>().ok())
                    })
                })
                .unwrap_or(0);
            let age = r
                .headers()
                .get("age")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            keys.set = Some(r.json().await.map_err(|_| Error::External)?);
            keys.until = now() + (max_age - age).max(0) * 1000;
        }
        let key = keys
            .set
            .as_ref()
            .and_then(|s| s.find(&kid))
            .ok_or(Error::External)?;
        let key = DecodingKey::from_jwk(key).map_err(|_| Error::External)?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.leeway = if worker { 300 } else { 0 };
        validation.validate_nbf = true;
        if worker {
            let audience = self.service_url.as_deref().ok_or(Error::External)?;
            validation.set_audience(&[audience]);
            validation.set_issuer(&["accounts.google.com", "https://accounts.google.com"]);
        } else {
            validation.set_audience(&[&self.project]);
            validation.set_issuer(&[format!("https://securetoken.google.com/{}", self.project)]);
        }
        let claims = decode::<Value>(token, &key, &validation)
            .map_err(|_| Error::External)?
            .claims;
        ensure(
            num(&claims, "iat") <= now() / 1000 + if worker { 300 } else { 0 }
                && (!worker || num(&claims, "exp") <= now() / 1000 + 86400),
            401,
            "invalid_owner_session",
        )?;
        Ok(claims)
    }
    fn auth_url(&self, method: &str) -> String {
        let base = self
            .auth_emulator
            .as_ref()
            .map(|h| format!("http://{h}/identitytoolkit.googleapis.com"))
            .unwrap_or_else(|| "https://identitytoolkit.googleapis.com".into());
        format!("{base}/v1/projects/{}/accounts:{method}", self.project)
    }
    pub async fn verify_owner(&self, token: &str) -> Result<Identity> {
        let claims = if self.auth_emulator.is_some() {
            let part = token.split('.').nth(1).ok_or(Error::External)?;
            serde_json::from_slice::<Value>(
                &URL_SAFE_NO_PAD.decode(part).map_err(|_| Error::External)?,
            )
            .map_err(|_| Error::External)?
        } else {
            self.jwt(token, false).await?
        };
        let uid = text(&claims, "sub");
        ensure(
            !uid.is_empty()
                && uid.encode_utf16().count() <= 128
                && claims["aud"] == self.project
                && claims["iss"] == format!("https://securetoken.google.com/{}", self.project)
                && num(&claims, "exp") > now() / 1000
                && num(&claims, "iat") <= now() / 1000
                && claims["auth_time"].is_number()
                && num(&claims, "auth_time") <= now() / 1000,
            401,
            "invalid_owner_session",
        )?;
        ensure(
            claims["firebase"]["sign_in_provider"] == "google.com",
            401,
            "google_sign_in_required",
        )?;
        let result = self
            .api(
                self.auth_url("lookup"),
                json!({"localId":[uid]}),
                self.auth_emulator.is_some(),
            )
            .await?;
        let users = arr(&result, "users");
        let user = users
            .iter()
            .find(|u| text(u, "localId") == uid)
            .ok_or(Error::External)?;
        let valid_since = text(user, "validSince").parse::<i64>().unwrap_or(0);
        ensure(
            !flag(user, "disabled") && num(&claims, "auth_time") >= valid_since,
            401,
            "invalid_owner_session",
        )?;
        Ok(Identity {
            uid: uid.into(),
            auth_time: num(&claims, "auth_time") as f64,
        })
    }
    pub async fn delete_identity(&self, uid: &str) -> Result<()> {
        match self
            .api(
                self.auth_url("delete"),
                json!({"localId":uid}),
                self.auth_emulator.is_some(),
            )
            .await
        {
            Ok(_) | Err(Error::Api(_, "auth/user-not-found")) => Ok(()),
            Err(error) => Err(error),
        }
    }
    pub async fn verify_worker(&self, token: &str) -> Result<()> {
        ensure(
            self.service_url.is_some() && self.scheduler.is_some(),
            401,
            "scheduler_not_configured",
        )?;
        let claims = self.jwt(token, true).await?;
        ensure(
            flag(&claims, "email_verified")
                && claims["email"] == self.scheduler.as_deref().unwrap(),
            401,
            "scheduler_not_authorized",
        )
    }
}
impl Delivery for Google {
    fn notify<'a>(
        &'a self,
        token: &'a str,
        id: &'a str,
        ttl: i64,
        form: bool,
    ) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let mut data = json!({"requestId":id});
            if form {
                data["kind"] = json!("form");
            }
            self.api(format!("https://fcm.googleapis.com/v1/projects/{}/messages:send",self.project),json!({"message":{"token":crate::js_string::utf8(token),"data":data,"android":{"priority":"HIGH","ttl":format!("{}.{:03}s",ttl.max(0)/1000,ttl.max(0)%1000),"collapse_key":id}}}),false).await?;
            Ok(())
        })
    }
    fn wake(&self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if let (Some(queue), Some(url), Some(email)) =
                (&self.queue, &self.service_url, &self.scheduler)
            {
                let token = self.access().await?;
                let response=self.client.post(format!("https://cloudtasks.googleapis.com/v2/{queue}/tasks")).timeout(Duration::from_secs(3)).bearer_auth(token).json(&json!({"task":{"httpRequest":{"httpMethod":"POST","url":format!("{url}/internal/delivery"),"oidcToken":{"serviceAccountEmail":email,"audience":url},"headers":{"Content-Type":"application/json"},"body":STANDARD.encode("{}")}}})).send().await.map_err(provider_transport)?;
                if !response.status().is_success() {
                    return Err(provider_response(response.status().as_u16(), &Value::Null));
                }
            }
            Ok(())
        })
    }
    fn webhook<'a>(
        &'a self,
        url: &'a str,
        secret: &'a str,
        event: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(crate::webhooks::send(url, secret, event))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    async fn verifier() -> Google {
        let mut google = Google::new("demo-sms-relay".into());
        google.auth_emulator = None;
        google.service_url = Some("https://relay.example.test".into());
        google.scheduler = Some("scheduler@example.test".into());
        let set: JwkSet =
            serde_json::from_str(include_str!("../tests/fixtures/jwks.json")).unwrap();
        for cache in [&google.firebase, &google.worker] {
            *cache.lock().await = Keys {
                set: Some(set.clone()),
                until: now() + MINUTE,
            };
        }
        google
    }
    fn signed(claims: &Value, kid: &str) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(kid.into());
        encode(
            &header,
            claims,
            &EncodingKey::from_rsa_der(include_bytes!("../tests/fixtures/test-only-rsa.der")),
        )
        .unwrap()
    }
    fn claims() -> Value {
        json!({"sub":"owner", "iss":"https://securetoken.google.com/demo-sms-relay", "aud":"demo-sms-relay", "iat":now()/1000-1, "exp":now()/1000+3600, "auth_time":now()/1000-1, "firebase":{"sign_in_provider":"google.com"}})
    }
    #[tokio::test]
    async fn signed_tokens_enforce_algorithm_issuer_audience_expiry_and_iat() {
        let google = verifier().await;
        assert!(
            google
                .jwt(&signed(&claims(), "test-key"), false)
                .await
                .is_ok()
        );
        for (key, value) in [
            ("iss", json!("https://evil.test")),
            ("aud", json!("other-project")),
            ("exp", json!(now() / 1000 - 1)),
            ("iat", json!(now() / 1000 + 300)),
        ] {
            let mut c = claims();
            c[key] = value;
            assert!(
                google.jwt(&signed(&c, "test-key"), false).await.is_err(),
                "{key}"
            );
        }
        // A cache miss cannot force a network key refresh before its max-age expires.
        assert!(
            google
                .jwt(&signed(&claims(), "unknown"), false)
                .await
                .is_err()
        );
        let hmac = encode(
            &Header::new(Algorithm::HS256),
            &claims(),
            &EncodingKey::from_secret(b"synthetic-test-key"),
        )
        .unwrap();
        assert!(google.jwt(&hmac, false).await.is_err());
        let mut tampered = signed(&claims(), "test-key").into_bytes();
        let last = tampered.len() - 2;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        assert!(
            google
                .jwt(std::str::from_utf8(&tampered).unwrap(), false)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn worker_requires_exact_audience_and_verified_service_identity() {
        let google = verifier().await;
        let mut c = json!({"iss":"https://accounts.google.com", "sub":"worker", "aud":"https://relay.example.test", "email":"scheduler@example.test", "email_verified":true,"iat":now()/1000-1,"exp":now()/1000+3600});
        assert!(google.verify_worker(&signed(&c, "test-key")).await.is_ok());
        for (key, value) in [
            ("iat", json!(now() / 1000 + 299)),
            ("exp", json!(now() / 1000 - 299)),
        ] {
            let mut skew = c.clone();
            skew[key] = value;
            assert!(
                google
                    .verify_worker(&signed(&skew, "test-key"))
                    .await
                    .is_ok(),
                "{key}"
            );
        }
        for (key, value) in [
            ("iat", json!(now() / 1000 + 301)),
            ("exp", json!(now() / 1000 - 301)),
            ("exp", json!(now() / 1000 + 86401)),
        ] {
            let mut skew = c.clone();
            skew[key] = value;
            assert!(
                google
                    .verify_worker(&signed(&skew, "test-key"))
                    .await
                    .is_err(),
                "{key}"
            );
        }
        for (key, value) in [
            ("aud", json!("https://other.example.test")),
            ("email", json!("intruder@example.test")),
            ("email_verified", json!(false)),
        ] {
            let old = c[key].clone();
            c[key] = value;
            assert!(
                google.verify_worker(&signed(&c, "test-key")).await.is_err(),
                "{key}"
            );
            c[key] = old;
        }
    }
}
