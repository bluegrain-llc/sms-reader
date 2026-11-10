use crate::{
    connections::user_code,
    error::{Error, Result, ensure},
    google::{Google, Identity},
    model::*,
    relay::{Auth, Relay},
};
use axum::{
    Router,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{convert::Infallible, sync::Arc, time::Duration};
pub trait Authentication: Send + Sync {
    fn owner<'a>(&'a self, token: &'a str) -> futures::future::BoxFuture<'a, Result<Identity>>;
    fn worker<'a>(&'a self, token: &'a str) -> futures::future::BoxFuture<'a, Result<()>>;
    fn delete<'a>(&'a self, uid: &'a str) -> futures::future::BoxFuture<'a, Result<()>>;
}
impl Authentication for Google {
    fn owner<'a>(&'a self, t: &'a str) -> futures::future::BoxFuture<'a, Result<Identity>> {
        Box::pin(self.verify_owner(t))
    }
    fn worker<'a>(&'a self, t: &'a str) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(self.verify_worker(t))
    }
    fn delete<'a>(&'a self, u: &'a str) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(self.delete_identity(u))
    }
}
#[derive(Clone)]
pub struct Options {
    pub auth: Arc<dyn Authentication>,
    pub public_url: Option<String>,
    pub android_cert: Option<String>,
    pub origins: Vec<String>,
    pub trust_proxy_hops: usize,
    pub sse_duration: Duration,
}
#[derive(Clone)]
struct App {
    relay: Relay,
    options: Options,
}
pub fn app(relay: Relay, options: Options) -> Router {
    let state = App { relay, options };
    Router::new()
        .fallback(handle)
        .layer(middleware::from_fn_with_state(state.clone(), common))
        .with_state(state)
}
fn header<'a>(h: &'a HeaderMap, k: &str) -> Option<&'a str> {
    h.get(k).and_then(|v| v.to_str().ok())
}
pub fn bearer(h: &HeaderMap) -> Result<String> {
    let token = header(h, "authorization").and_then(|s| s.strip_prefix("Bearer "));
    ensure(
        token.is_some_and(|s| !s.is_empty() && !s.chars().any(char::is_whitespace)),
        401,
        "authentication_required",
    )?;
    Ok(token.unwrap().into())
}
impl App {
    async fn owner(&self, h: &HeaderMap) -> Result<Identity> {
        let token = bearer(h).map_err(|_| Error::Api(401, "invalid_owner_session"))?;
        let mut identity = self
            .options
            .auth
            .owner(&token)
            .await
            .map_err(|_| Error::Api(401, "invalid_owner_session"))?;
        identity.uid = crate::js_string::encode(&identity.uid);
        Ok(identity)
    }
}
async fn common(State(s): State<App>, mut request: Request, next: Next) -> Response {
    let is_head = request.method() == axum::http::Method::HEAD;
    if is_head {
        *request.method_mut() = axum::http::Method::GET;
    }
    let origin = header(request.headers(), "origin");
    let mut response =
        if origin.is_some_and(|o| !s.options.origins.iter().any(|allowed| allowed == o)) {
            Error::Api(403, "origin_not_allowed").into_response()
        } else {
            next.run(request).await
        };
    response
        .headers_mut()
        .insert("X-Content-Type-Options", "nosniff".parse().unwrap());
    if !response.headers().contains_key("Cache-Control") {
        response
            .headers_mut()
            .insert("Cache-Control", "no-store".parse().unwrap());
    }
    if is_head {
        *response.body_mut() = Body::empty();
    }
    response
}
async fn handle(State(s): State<App>, request: Request) -> Response {
    match route(s, request).await {
        Ok(r) => r,
        Err(e) => e.into_response(),
    }
}
pub(crate) fn json_response(v: Value, status: u16) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("Content-Type", "application/json; charset=utf-8")],
        js_json(&v, false),
    )
        .into_response()
}
async fn json_body(body: Body, headers: &HeaderMap) -> Result<Vec<u8>> {
    use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder};
    use futures::TryStreamExt;
    use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
    let stream = body.into_data_stream().map_err(std::io::Error::other);
    let reader = BufReader::new(tokio_util::io::StreamReader::new(stream));
    let reader: std::pin::Pin<Box<dyn AsyncRead + Send>> = match header(headers, "content-encoding")
        .unwrap_or("identity")
        .to_ascii_lowercase()
        .as_str()
    {
        "identity" => Box::pin(reader),
        "gzip" => Box::pin(GzipDecoder::new(reader)),
        "deflate" => Box::pin(ZlibDecoder::new(reader)),
        "br" => Box::pin(BrotliDecoder::new(reader)),
        _ => return Err(Error::External),
    };
    let mut bytes = Vec::new();
    reader
        .take(256 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Error::External)?;
    ensure(bytes.len() <= 256 * 1024, 413, "payload_too_large")?;
    let charset = header(headers, "content-type")
        .unwrap_or("")
        .split(';')
        .skip(1)
        .find_map(|p| {
            let (k, v) = p.trim().split_once('=')?;
            k.eq_ignore_ascii_case("charset")
                .then(|| v.trim().trim_matches('"').to_ascii_lowercase())
        })
        .unwrap_or_else(|| "utf-8".into());
    let (bytes, charset) = (bytes.as_slice(), charset.as_str());
    let text = match charset {
        "utf-8" | "utf8" => String::from_utf8_lossy(bytes).into_owned(),
        "utf-16" | "utf-16le" | "utf-16be" => {
            let be =
                charset == "utf-16be" || (charset == "utf-16" && bytes.starts_with(&[0xfe, 0xff]));
            let units = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| {
                    if be {
                        u16::from_be_bytes([c[0], c[1]])
                    } else {
                        u16::from_le_bytes([c[0], c[1]])
                    }
                })
                .collect::<Vec<_>>();
            let mut text = String::from_utf16_lossy(&units);
            if bytes.len() % 2 != 0 {
                text.push('\u{fffd}');
            }
            text
        }
        "utf-32" | "utf-32le" | "utf-32be" => {
            let be = charset == "utf-32be"
                || (charset == "utf-32" && bytes.starts_with(&[0, 0, 0xfe, 0xff]));
            bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| {
                    char::from_u32(if be {
                        u32::from_be_bytes(*c)
                    } else {
                        u32::from_le_bytes(*c)
                    })
                    .unwrap_or('\u{fffd}')
                })
                .collect()
        }
        _ => return Err(Error::External),
    };
    Ok(text
        .strip_prefix('\u{feff}')
        .unwrap_or(&text)
        .as_bytes()
        .to_vec())
}
fn validate_event(v: &Value) -> Result<()> {
    let target = string(v, "status", 1, 64, false)?;
    let allowed = match target.as_str() {
        "ready" => {
            integer(v, "listenerStartedAt", 1, i64::MAX, None)?;
            vec!["status", "listenerStartedAt"]
        }
        "completed" => {
            ensure(code(text(v, "code")), 400, "invalid_input")?;
            if let Some(src) = v.get("source") {
                ensure(
                    src == "android_consent" || src == "manual",
                    400,
                    "invalid_input",
                )?;
            }
            vec!["status", "code", "source"]
        }
        "failed" => {
            ensure(
                [
                    "play_services_unavailable",
                    "listener_failed",
                    "process_restarted",
                    "code_extraction_failed",
                    "consent_unavailable",
                    "notifications_disabled",
                    "listener_timeout",
                ]
                .contains(&text(v, "reason")),
                400,
                "invalid_input",
            )?;
            vec!["status", "reason"]
        }
        "awaiting_consent" | "denied" | "cancelled" => vec!["status"],
        _ => return Err(Error::Api(400, "invalid_input")),
    };
    strict(v, &allowed)
}
async fn route(s: App, request: Request) -> Result<Response> {
    let method = request.method().clone();
    let raw_path = request.uri().path();
    let path = raw_path.strip_suffix('/').unwrap_or(raw_path).to_owned();
    let query = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
        .into_owned()
        .collect::<Vec<_>>();
    let headers = request.headers().clone();
    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|x| x.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into());
    let (parts, body) = request.into_parts();
    let is_json = header(&headers, "content-type").is_some_and(|s| {
        s.split(';')
            .next()
            .unwrap()
            .trim()
            .eq_ignore_ascii_case("application/json")
    });
    let bytes = if is_json {
        json_body(body, &headers).await?
    } else {
        Vec::new()
    };
    let mut input = Value::Null;
    if is_json && !bytes.is_empty() {
        input = crate::js_string::parse(&bytes).map_err(|_| Error::Api(400, "invalid_input"))?;
        js_numbers(&mut input);
        ensure(input.is_object() || input.is_array(), 400, "invalid_input")?;
    }
    let parts_of_path = path
        .strip_prefix('/')
        .unwrap_or(&path)
        .split('/')
        .enumerate()
        .map(|(i, s)| {
            if [0, 1, 3, 5].contains(&i)
                || (i == 2 && path.to_ascii_lowercase().starts_with("/v1/connections/"))
            {
                s.to_ascii_lowercase()
            } else {
                s.to_owned()
            }
        })
        .collect::<Vec<_>>();
    let segments = parts_of_path.iter().map(String::as_str).collect::<Vec<_>>();
    let p = segments.as_slice();
    let r = &s.relay;
    let mut status = 200;
    let query_value = |key: &str| -> Result<Option<String>> {
        let values = query
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .collect::<Vec<_>>();
        ensure(values.len() <= 1, 400, "invalid_input")?;
        Ok(values.into_iter().next())
    };
    let cursor = || -> Result<Option<String>> {
        let value =
            query_value("cursor")?.or_else(|| header(&headers, "Last-Event-ID").map(str::to_owned));
        ensure(
            value
                .as_ref()
                .is_none_or(|v| crate::js_string::count(v) <= 128),
            400,
            "invalid_input",
        )?;
        Ok(value)
    };
    let check_id = |v: &str| -> Result<String> {
        let v = urlencoding(v)?;
        id(&v)?;
        Ok(v)
    };
    let output = match (method.as_str(), p) {
        ("GET", ["health" | "healthz"]) => json!({"ok":true}),
        ("GET", [".well-known", "assetlinks.json"]) => {
            let cert = s.options.android_cert.as_deref().unwrap_or("");
            ensure(
                regex::Regex::new(r"^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$")
                    .unwrap()
                    .is_match(cert),
                503,
                "app_links_not_configured",
            )?;
            json!([{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"com.bluegrain.smsrelay","sha256_cert_fingerprints":[cert.to_uppercase()]}}])
        }
        ("GET", ["connect"]) => {
            let code = user_code(&query_value("code")?.ok_or(Error::Api(400, "invalid_input"))?)?;
            let code = format!("{}-{}", &code[..5], &code[5..]);
            let html = include_str!("../compat/connect.html").replace("{{CODE}}", &code);
            let mut response=(StatusCode::OK,[("Content-Type","text/html; charset=utf-8"),("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"),("Referrer-Policy","no-referrer")],html).into_response();
            response
                .headers_mut()
                .insert("Cache-Control", "no-store".parse().unwrap());
            return Ok(response);
        }
        ("POST", ["v1", "connections"]) => {
            let base = s
                .options
                .public_url
                .as_deref()
                .ok_or(Error::Api(503, "pairing_not_configured"))?;
            let source = if s.options.trust_proxy_hops > 0 {
                header(&headers, "x-forwarded-for")
                    .and_then(|h| h.split(',').rev().nth(s.options.trust_proxy_hops - 1))
                    .map(|v| v.trim().to_owned())
                    .unwrap_or(peer)
            } else {
                peer
            };
            let mut result = r.connection_start(source, input).await?;
            result["verificationUri"] = json!(format!(
                "{}/connect?code={}",
                base.trim_end_matches('/'),
                text(&result, "userCode")
            ));
            status = 201;
            result
        }
        ("POST", ["v1", "connections", "poll"]) => r.connection_poll(bearer(&headers)?).await?,
        ("POST", ["v1", "connections", operation @ ("review" | "decision")]) => {
            let uid = s.owner(&headers).await?.uid;
            strict(
                &input,
                if *operation == "review" {
                    &["userCode"]
                } else {
                    &["userCode", "decision"]
                },
            )?;
            let code = string(&input, "userCode", 0, 32, false)?;
            let decision = if *operation == "decision" {
                ensure(
                    ["approved", "denied"].contains(&text(&input, "decision")),
                    400,
                    "invalid_input",
                )?;
                Some(text(&input, "decision").into())
            } else {
                None
            };
            r.connection_owner(uid, code, decision).await?
        }
        ("GET", ["v1", "devices"]) => r.list_devices(&s.owner(&headers).await?.uid).await?,
        ("PUT", ["v1", "devices", did]) => {
            let uid = s.owner(&headers).await?.uid;
            strict(&input, &["name", "fcmToken", "wizardVersion"])?;
            let name = string(&input, "name", 1, 80, true)?;
            let fcm = string(&input, "fcmToken", 1, 4096, false)?;
            ensure(
                input.get("wizardVersion").is_none()
                    || input["wizardVersion"].as_f64() == Some(1.0),
                400,
                "invalid_input",
            )?;
            r.register(
                uid,
                check_id(did)?,
                name,
                fcm,
                input["wizardVersion"].as_f64() == Some(1.0),
            )
            .await?
        }
        ("PATCH", ["v1", "devices", did]) => {
            let uid = s.owner(&headers).await?.uid;
            strict(&input, &["paused"])?;
            let paused = input["paused"]
                .as_bool()
                .ok_or(Error::Api(400, "invalid_input"))?;
            r.change_device(uid, check_id(did)?, paused, false).await?;
            json!({"ok":true})
        }
        ("DELETE", ["v1", "devices", did]) => {
            r.change_device(s.owner(&headers).await?.uid, check_id(did)?, true, true)
                .await?;
            json!({"ok":true})
        }
        ("GET", ["v1", "callers"]) => r.list_grants(s.owner(&headers).await?.uid, None).await?,
        ("GET", ["v1", "devices", did, "grants"]) => {
            r.list_grants(s.owner(&headers).await?.uid, Some(check_id(did)?))
                .await?
        }
        ("POST", ["v1", "devices", did, "grants"]) => {
            let uid = s.owner(&headers).await?.uid;
            strict(&input, &["callerName", "expiresInDays"])?;
            let name = string(&input, "callerName", 1, 80, true)?;
            let days = integer(&input, "expiresInDays", 1, 90, Some(30))?;
            status = 201;
            r.create_grant(uid, check_id(did)?, name, days).await?
        }
        ("DELETE", ["v1", "grants", gid]) => {
            r.revoke(s.owner(&headers).await?.uid, check_id(gid)?)
                .await?;
            json!({"ok":true})
        }
        ("DELETE", ["v1", "account"]) => {
            let identity = s.owner(&headers).await?;
            ensure(
                now() as f64 / 1000.0 - identity.auth_time < 300.0,
                401,
                "recent_sign_in_required",
            )?;
            r.delete_account(identity.uid.clone()).await?;
            s.options
                .auth
                .delete(&crate::js_string::utf8(&identity.uid))
                .await?;
            json!({"ok":true})
        }
        ("GET", ["v1", "history"]) => r.history(s.owner(&headers).await?.uid, None).await?,
        ("GET", ["v1", "devices", did, "history"]) => {
            r.history(s.owner(&headers).await?.uid, Some(check_id(did)?))
                .await?
        }
        ("GET", ["v1", "devices", did, "requests", rid]) => {
            r.phone_get(s.owner(&headers).await?.uid, check_id(did)?, check_id(rid)?)
                .await?
        }
        ("POST", ["v1", "devices", did, "requests", rid, "events"]) => {
            let uid = s.owner(&headers).await?.uid;
            validate_event(&input)?;
            r.transition(
                Auth::Phone {
                    uid,
                    device: check_id(did)?,
                },
                check_id(rid)?,
                input,
            )
            .await?
        }
        ("POST", ["v1", "requests"]) => {
            status = 201;
            r.create(bearer(&headers)?, input).await?
        }
        ("GET", ["v1", "requests", rid]) => r.get(bearer(&headers)?, check_id(rid)?).await?,
        ("POST", ["v1", "requests", rid, "cancel"]) => {
            r.transition(
                Auth::Agent(bearer(&headers)?),
                check_id(rid)?,
                json!({"status":"cancelled"}),
            )
            .await?
        }
        ("POST", ["v2", "requests"]) => {
            status = 201;
            r.form_create(bearer(&headers)?, input).await?
        }
        ("GET", ["v2", "requests", rid]) => {
            r.form_get(Auth::Agent(bearer(&headers)?), check_id(rid)?)
                .await?
        }
        ("GET", ["v2", "requests", rid, "result"]) => {
            r.form_result(bearer(&headers)?, check_id(rid)?).await?
        }
        ("POST", ["v2", "requests", rid, "cancel"]) => {
            r.form_cancel(bearer(&headers)?, check_id(rid)?).await?
        }
        ("GET", ["v2", "devices", did, "inbox"]) => {
            r.inbox(s.owner(&headers).await?.uid, check_id(did)?)
                .await?
        }
        ("GET", ["v2", "devices", did, "requests", rid]) => {
            r.form_get(
                Auth::Phone {
                    uid: s.owner(&headers).await?.uid,
                    device: check_id(did)?,
                },
                check_id(rid)?,
            )
            .await?
        }
        ("POST", ["v2", "devices", did, "requests", rid, "events"]) => {
            let uid = s.owner(&headers).await?.uid;
            let did = check_id(did)?;
            let rid = check_id(rid)?;
            r.observe(uid, did, rid, input).await?
        }
        ("POST", ["v2", "devices", did, "requests", rid, "submissions"]) => {
            let uid = s.owner(&headers).await?.uid;
            r.submit(uid, check_id(did)?, check_id(rid)?, input).await?
        }
        ("PUT", ["v2", "grants", gid, "forms"]) => {
            strict(&input, &["approved"])?;
            let approved = input["approved"]
                .as_bool()
                .ok_or(Error::Api(400, "invalid_input"))?;
            r.approve_forms(s.owner(&headers).await?.uid, check_id(gid)?, approved)
                .await?;
            json!({"ok":true})
        }
        ("POST", ["v2", "webhooks"]) => {
            status = 201;
            r.register_webhook(bearer(&headers)?, input).await?
        }
        ("GET", ["v2", "webhooks"]) => r.webhooks(bearer(&headers)?, None).await?,
        ("DELETE", ["v2", "webhooks", hid]) => {
            r.webhooks(bearer(&headers)?, Some(check_id(hid)?)).await?
        }
        ("GET", ["v2", "events"]) => r.events(bearer(&headers)?, cursor()?).await?,
        ("GET", ["v2", "events", "stream"]) => {
            return stream(s.clone(), bearer(&headers)?, cursor()?).await;
        }
        ("POST", ["internal", operation @ ("delivery" | "maintenance")]) => {
            let reason = if *operation == "delivery" {
                "invalid_worker_identity"
            } else {
                "invalid_scheduler_identity"
            };
            let token = bearer(&headers).map_err(|_| Error::Api(401, reason))?;
            s.options
                .auth
                .worker(&token)
                .await
                .map_err(|_| Error::Api(401, reason))?;
            if *operation == "delivery" {
                r.dispatch().await?;
            } else {
                r.maintenance().await?;
            }
            json!({"ok":true})
        }
        ("POST", ["mcp"]) => {
            let secret = bearer(&headers)?;
            r.check_agent(&secret).await?;
            let request =
                Request::from_parts(parts, Body::from(serde_json::to_vec(&input).unwrap()));
            return Ok(crate::mcp::handle(r.clone(), secret, request, input).await);
        }
        (_, ["mcp"]) => return Err(Error::Api(405, "method_not_allowed")),
        _ => return Err(Error::Api(404, "not_found")),
    };
    Ok(json_response(output, status))
}
fn urlencoding(s: &str) -> Result<String> {
    let mut bytes = Vec::new();
    let mut input = s.as_bytes().iter().copied();
    while let Some(b) = input.next() {
        if b == b'%' {
            let high = input.next().and_then(|b| (b as char).to_digit(16));
            let low = input.next().and_then(|b| (b as char).to_digit(16));
            let (Some(high), Some(low)) = (high, low) else {
                return Err(Error::Api(400, "invalid_input"));
            };
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).map_err(|_| Error::Api(400, "invalid_input"))
}
async fn stream(s: App, secret: String, cursor: Option<String>) -> Result<Response> {
    let mut page = s.relay.events(secret.clone(), cursor.clone()).await?;
    let (mut next, relay) = (cursor, s.relay);
    let duration = s.options.sse_duration;
    let (tx, rx) = tokio::sync::mpsc::channel::<std::result::Result<String, Infallible>>(128);
    tx.try_send(Ok("retry: 1000\n\n".into())).unwrap();
    tokio::spawn(async move {
        let end = tokio::time::Instant::now() + duration;
        loop {
            for event in arr(&page, "events") {
                let frame = format!(
                    "id: {}\nevent: {}\ndata: {}\n\n",
                    text(&event, "id"),
                    text(&event, "type"),
                    js_json(&event, false)
                );
                if tx.try_send(Ok(frame)).is_err() {
                    return;
                }
                next = Some(text(&event, "id").into());
            }
            if tx.try_send(Ok(": heartbeat\n\n".into())).is_err() {
                return;
            }
            if tokio::time::Instant::now() >= end {
                return;
            }
            tokio::select! {_=tx.closed()=>return,_=tokio::time::sleep_until(end.min(tokio::time::Instant::now()+Duration::from_secs(1)))=>{}}
            if tokio::time::Instant::now() >= end {
                return;
            }
            match relay.events(secret.clone(), next.clone()).await {
                Ok(p) => page = p,
                Err(_) => return,
            }
        }
    });
    Ok((
        [
            ("Content-Type", "text/event-stream"),
            ("Cache-Control", "no-cache, no-store"),
            ("X-Accel-Buffering", "no"),
        ],
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)),
    )
        .into_response())
}
