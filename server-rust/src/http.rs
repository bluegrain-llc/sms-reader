use crate::worker_context::WorkerContext;
use crate::{
    connections::user_code,
    error::{Error, Result, ensure},
    google::{Google, Identity},
    model::*,
    relay::{Auth, Delivery, Relay},
};
use axum::{
    Router,
    body::{Body, Bytes, HttpBody},
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::{Duration, Instant},
};
pub trait Serving: Send + Sync {
    fn assert_serving(&self) -> futures::future::BoxFuture<'_, Result<()>>;
}
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
    pub project_id: Option<String>,
    pub auth: Arc<dyn Authentication>,
    pub serving: Option<Arc<dyn Serving>>,
    pub public_url: Option<String>,
    pub apple_app_ids: Vec<String>,
    pub android_cert: Option<String>,
    pub android_certs: Option<Value>,
    pub android_package: Option<String>,
    pub firebase_web_config: Option<Value>,
    pub privacy_contact: Option<String>,
    pub origins: Vec<String>,
    pub trust_proxy_hops: usize,
    pub sse_duration: Duration,
}
#[derive(Clone)]
struct App {
    relay: Relay,
    streams: crate::event_streams::EventStreams,
    options: Options,
}
pub fn app(relay: Relay, options: Options) -> Router {
    let streams = crate::event_streams::EventStreams::new(relay.clone());
    let state = App {
        relay,
        options,
        streams,
    };
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
    async fn owner(&self, h: &HeaderMap, read: bool, allow_deleted: bool) -> Result<Identity> {
        let token = bearer(h).map_err(|_| Error::Api(401, "invalid_owner_session"))?;
        let mut identity = self
            .options
            .auth
            .owner(&token)
            .await
            .map_err(|_| Error::Api(401, "invalid_owner_session"))?;
        identity.uid = crate::js_string::encode(&identity.uid);
        if !allow_deleted {
            let relay = self.relay.clone();
            let uid = identity.uid.clone();
            self.relay
                .store
                .tx(move |tx| {
                    let (relay, uid) = (relay.clone(), uid.clone());
                    Box::pin(async move {
                        relay.account(tx, &uid).await?;
                        Ok(())
                    })
                })
                .await?;
        }
        if read {
            self.relay.access_read(identity.uid.clone(), None).await?;
        }
        Ok(identity)
    }
    async fn agent_read(&self, h: &HeaderMap) -> Result<String> {
        let secret = bearer(h)?;
        let relay = self.relay.clone();
        let key = secret.clone();
        let grant = self
            .relay
            .store
            .tx(move |tx| {
                let (relay, key) = (relay.clone(), key.clone());
                Box::pin(async move { Ok(relay.agent(tx, &key).await?.0) })
            })
            .await?;
        self.relay
            .access_read(
                text(&grant, "ownerId").into(),
                Some(text(&grant, "id").into()),
            )
            .await?;
        Ok(secret)
    }
}
async fn common(State(s): State<App>, mut request: Request, next: Next) -> Response {
    let started = std::time::Instant::now();
    let method = request.method().as_str().to_owned();
    let is_head = request.method() == axum::http::Method::HEAD;
    if is_head {
        *request.method_mut() = axum::http::Method::GET;
    }
    let origin = request.headers().get("origin");
    let path = request.uri().path().to_ascii_lowercase();
    let account_route = matches!(
        path.strip_suffix('/').unwrap_or(&path),
        "/v1/account" | "/v1/account-deletion"
    ) || path.starts_with("/v3/");
    let account_origin = s
        .options
        .public_url
        .as_deref()
        .and_then(|url| url::Url::parse(url).ok())
        .map(|url| url.origin().ascii_serialization());
    let mut response = if origin.is_some_and(|o| {
        o.to_str()
            .map(|o| {
                !o.is_empty()
                    && !(account_route && account_origin.as_deref() == Some(o))
                    && !s.options.origins.iter().any(|allowed| allowed == o)
            })
            .unwrap_or(true)
    }) {
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
        // Dropping the producer releases admission. Preserve the response's
        // deadline token on the empty HEAD body so its actual flush completes it.
        let body = Body::empty();
        *response.body_mut() = match response
            .extensions_mut()
            .remove::<crate::newtransport::StreamDeadline>()
        {
            Some(deadline) => deadline.head_body(),
            None => body,
        };
    }
    measured_response(response, s.relay.delivery, &method, &path, started)
}
struct MeasuredBody {
    body: Body,
    logger: Arc<dyn Delivery>,
    event: Option<Value>,
    started: Instant,
}
impl MeasuredBody {
    fn complete(&mut self) {
        if let Some(mut event) = self.event.take() {
            event["duration_ms"] = json!(self.started.elapsed().as_millis());
            let logger = self.logger.clone();
            // Logging has no bearing on flushing or closing the response body.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    logger.record(event).await;
                });
            }
        }
    }
}
impl HttpBody for MeasuredBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<http_body::Frame<Bytes>, Self::Error>>> {
        let frame = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(&frame, Poll::Ready(None)) || self.body.is_end_stream() {
            self.complete();
        }
        frame
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}
impl Drop for MeasuredBody {
    fn drop(&mut self) {
        self.complete();
    }
}
fn measured_response(
    response: Response,
    logger: Arc<dyn Delivery>,
    method: &str,
    path: &str,
    started: Instant,
) -> Response {
    let mut event = json!({"event":"http_completed","method":method,"route":crate::telemetry::route_template(path),"status_class":format!("{}xx",response.status().as_u16()/100)});
    if let Some(context) = response.extensions().get::<WorkerContext>() {
        event["logging.googleapis.com/trace"] = json!(context.trace());
    }
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::new(MeasuredBody {
            body,
            logger,
            event: Some(event),
            started,
        }),
    )
}
async fn handle(State(s): State<App>, request: Request) -> Response {
    let logger = s.relay.delivery.clone();
    let (observed_path, observed_method) = (
        request.uri().path().to_owned(),
        request.method().as_str().to_owned(),
    );
    let challenge = request.uri().path().strip_prefix("/mcp/services/").and_then(|id| {
        crate::model::id(id).ok()?;
        let base = s.options.public_url.as_ref()?;
        Some(format!("Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp/services/{id}\"", base.trim_end_matches('/')))
    });
    let mut worker_context = None;
    let mut response = match route(s, request, &mut worker_context).await {
        Ok(r) => r,
        Err(e) => {
            if !matches!(e, Error::Api(_, _)) {
                logger
                    .emit("request_failed", crate::telemetry::category(&e))
                    .await;
            }
            let status = if let Error::Api(status, _) = &e {
                *status
            } else {
                500
            };
            let reason = if let Error::Api(_, reason) = &e {
                *reason
            } else {
                "internal_error"
            };
            if let Some(event) = crate::telemetry::onboarding_outcome(
                &observed_path,
                &observed_method,
                status,
                &json!({"error":reason}),
            ) {
                logger.record(event).await;
            }
            if observed_path.starts_with("/oauth/") {
                let standard = [
                    "invalid_client",
                    "invalid_grant",
                    "invalid_scope",
                    "unauthorized_client",
                    "unsupported_grant_type",
                    "invalid_target",
                    "invalid_client_metadata",
                ];
                let error = if status >= 500 {
                    "server_error"
                } else if status == 429 {
                    "temporarily_unavailable"
                } else if standard.contains(&reason) {
                    reason
                } else if reason == "capability_not_requested" {
                    "invalid_scope"
                } else if observed_path == "/oauth/register" {
                    "invalid_client_metadata"
                } else {
                    "invalid_request"
                };
                let mut response = json_response(json!({"error":error}), status);
                if status == 429 {
                    response
                        .headers_mut()
                        .insert("Retry-After", "60".parse().unwrap());
                }
                response
            } else {
                e.into_response()
            }
        }
    };
    if matches!(response.status().as_u16(), 401 | 403)
        && let Some(challenge) = challenge
    {
        response
            .headers_mut()
            .insert("WWW-Authenticate", challenge.parse().unwrap());
    }
    if let Some(context) = worker_context {
        response.extensions_mut().insert(context);
    }
    response
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
        "gzip" => {
            let mut decoder = GzipDecoder::new(reader);
            decoder.multiple_members(true);
            Box::pin(decoder)
        }
        "deflate" => Box::pin(ZlibDecoder::new(reader)),
        "br" => Box::pin(BrotliDecoder::new(reader)),
        _ => return Err(Error::External),
    };
    let limit = 256 * 1024;
    let mut reader = reader.take(limit + 1);
    let mut bytes = Vec::with_capacity(8192);
    let (mut utf16_sample, mut utf32_sample) = (None, None);
    while bytes.len() <= limit as usize {
        if bytes.len() == bytes.capacity() {
            let additional = bytes.capacity().min(limit as usize + 1 - bytes.len());
            bytes.reserve_exact(additional);
        }
        if reader
            .read_buf(&mut bytes)
            .await
            .map_err(|_| Error::External)?
            == 0
        {
            break;
        }
        // iconv locks automatic byte order at the first incoming chunk that
        // reaches its minimum sample size, before later chunks can change it.
        if bytes.len() >= 16 && utf16_sample.is_none() {
            utf16_sample = Some(bytes.len());
        }
        if bytes.len() >= 32 && utf32_sample.is_none() {
            utf32_sample = Some(bytes.len());
        }
    }
    ensure(bytes.len() <= limit as usize, 413, "payload_too_large")?;
    let charset = header(headers, "content-type")
        .unwrap_or("")
        .split(';')
        .skip(1)
        .find_map(|p| {
            let (k, v) = p.trim().split_once('=')?;
            k.eq_ignore_ascii_case("charset")
                .then(|| v.trim().trim_matches('"').to_ascii_lowercase())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "utf-8".into());
    if !charset.starts_with("utf-") {
        return Err(Error::External);
    }
    let charset = charset
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>();
    let (bytes, charset) = (bytes.as_slice(), charset.as_str());
    let text = match charset {
        "utf8" => String::from_utf8_lossy(bytes).into_owned(),
        "utf7" | "utf7imap" => utf7_json(bytes, charset == "utf7imap")?,
        "utf16" | "utf16le" | "utf16be" => {
            let pairs = bytes[..utf16_sample.unwrap_or(bytes.len())]
                .as_chunks::<2>()
                .0;
            let be = charset == "utf16be"
                || (charset == "utf16"
                    && if bytes.starts_with(&[0xfe, 0xff]) {
                        true
                    } else if bytes.starts_with(&[0xff, 0xfe]) {
                        false
                    } else {
                        pairs
                            .iter()
                            .take(100)
                            .filter(|p| p[0] == 0 && p[1] != 0)
                            .count()
                            > pairs
                                .iter()
                                .take(100)
                                .filter(|p| p[0] != 0 && p[1] == 0)
                                .count()
                    });
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
            crate::js_string::utf16_json(&units)?
        }
        "utf32" | "utf32le" | "utf32be" => {
            let sample = &bytes[..utf32_sample.unwrap_or(bytes.len())];
            let score = |be: bool| {
                sample
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .take(100)
                    .map(|b| {
                        let n = if be {
                            u32::from_be_bytes(*b)
                        } else {
                            u32::from_le_bytes(*b)
                        };
                        i32::from(n > 0 && n <= 0xffff) - i32::from(n > 0x10ffff)
                    })
                    .sum::<i32>()
            };
            let be = charset == "utf32be"
                || (charset == "utf32"
                    && if bytes.starts_with(&[0, 0, 0xfe, 0xff]) {
                        true
                    } else if bytes.starts_with(&[0xff, 0xfe, 0, 0]) {
                        false
                    } else {
                        score(true) > score(false)
                    });
            let mut units = vec![];
            for b in bytes.as_chunks::<4>().0 {
                let n = if be {
                    u32::from_be_bytes(*b)
                } else {
                    u32::from_le_bytes(*b)
                };
                if n <= 0xffff {
                    units.push(n as u16);
                } else {
                    units.extend(
                        char::from_u32(n)
                            .unwrap_or('\u{fffd}')
                            .encode_utf16(&mut [0; 2])
                            .iter()
                            .copied(),
                    );
                }
            }
            if bytes.len() % 4 != 0 {
                units.push(0xfffd);
            }
            crate::js_string::utf16_json(&units)?
        }
        _ => return Err(Error::External),
    };
    Ok(text
        .strip_prefix('\u{feff}')
        .unwrap_or(&text)
        .as_bytes()
        .to_vec())
}
// iconv-lite's forgiving UTF-7 decoder accepts implicit shift termination.
fn utf7_json(bytes: &[u8], imap: bool) -> Result<String> {
    let mut units = Vec::new();
    let shift = if imap { b'&' } else { b'+' };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != shift {
            units.push(if bytes[i] < 128 {
                bytes[i] as u16
            } else {
                0xfffd
            });
            i += 1;
            continue;
        }
        i += 1;
        let start = i;
        let (mut bits, mut count) = (0u32, 0u32);
        let mut decoded = Vec::new();
        while let Some(&byte) = bytes.get(i) {
            let value = match byte {
                b'A'..=b'Z' => byte - b'A',
                b'a'..=b'z' => byte - b'a' + 26,
                b'0'..=b'9' => byte - b'0' + 52,
                b'+' => 62,
                b'/' | b',' if byte == b'/' || imap => 63,
                _ => break,
            };
            bits = (bits << 6) | u32::from(value);
            count += 6;
            if count >= 8 {
                count -= 8;
                decoded.push((bits >> count) as u8);
                bits &= (1 << count) - 1;
            }
            i += 1;
        }
        if i == start && bytes.get(i) == Some(&b'-') {
            units.push(shift as u16);
        } else {
            units.extend(
                decoded
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|p| u16::from_be_bytes(*p)),
            );
        }
        if bytes.get(i) == Some(&b'-') {
            i += 1;
        }
    }
    crate::js_string::utf16_json(&units)
}
fn validate_event(v: &Value) -> Result<()> {
    let target = string(v, "status", 1, 64, false)?;
    let allowed = match target.as_str() {
        "ready" => {
            let mode = v.get("mode").and_then(Value::as_str).unwrap_or("listener");
            ensure(
                v.get("mode").is_none() || v["mode"] == "listener" || v["mode"] == "manual",
                400,
                "invalid_input",
            )?;
            if mode == "manual" {
                ensure(v.get("listenerStartedAt").is_none(), 400, "invalid_input")?;
            } else {
                integer(v, "listenerStartedAt", 1, i64::MAX, None)?;
            }
            vec!["status", "listenerStartedAt", "mode"]
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
async fn route(
    s: App,
    request: Request,
    worker_context: &mut Option<WorkerContext>,
) -> Result<Response> {
    let method = request.method().clone();
    let raw_path = request.uri().path();
    let raw_oauth_path = raw_path.to_owned();
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
    let is_form = path.starts_with("/oauth/")
        && header(&headers, "content-type").is_some_and(|s| {
            s.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/x-www-form-urlencoded")
        });
    let bytes = if is_json || is_form {
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
    if is_form {
        ensure(bytes.len() <= 16384, 413, "payload_too_large")?;
        input = json!({});
        let mut count = 0;
        for (k, v) in url::form_urlencoded::parse(&bytes) {
            count += 1;
            ensure(
                count <= 12 && input.get(k.as_ref()).is_none() && v.len() <= 4096,
                400,
                "invalid_input",
            )?;
            input[k.as_ref()] = json!(v);
        }
    }
    let parts_of_path = path
        .strip_prefix('/')
        .unwrap_or(&path)
        .split('/')
        .enumerate()
        .map(|(i, s)| {
            if [0, 1, 3, 5].contains(&i)
                || (i == 2
                    && ["/v1/connections/", "/v2/events/"]
                        .iter()
                        .any(|prefix| path.to_ascii_lowercase().starts_with(prefix)))
            {
                s.to_ascii_lowercase()
            } else {
                s.to_owned()
            }
        })
        .collect::<Vec<_>>();
    let segments = parts_of_path.iter().map(String::as_str).collect::<Vec<_>>();
    let p = segments.as_slice();
    let health =
        method == axum::http::Method::GET && matches!(p, ["health" | "healthz" | "startup"]);
    if !health
        && (headers
            .get("authorization")
            .is_some_and(|value| !value.as_bytes().is_empty())
            || (method == axum::http::Method::POST && matches!(p, ["v1", "connections"]))
            || path.starts_with("/oauth/"))
        && let Some(gate) = &s.options.serving
    {
        gate.assert_serving().await?;
    }
    // Express decodes matched path parameters before invoking authentication.
    let parameters: Vec<&str> = match p {
        ["v1" | "v2", "requests", id]
        | ["v1", "grants", id]
        | ["v2", "webhooks", id]
        | ["v1", "devices", id] => vec![id],
        ["v1", "requests", id, "cancel"]
        | ["v2", "requests", id, "cancel" | "result"]
        | ["v2", "grants", id, "forms"]
        | ["v1", "devices", id, "grants" | "history"]
        | ["v2", "devices", id, "inbox"] => vec![id],
        ["v1" | "v2", "devices", device, "requests", id]
        | ["v1", "devices", device, "requests", id, "events"]
        | [
            "v2",
            "devices",
            device,
            "requests",
            id,
            "events" | "submissions",
        ] => vec![device, id],
        _ => vec![],
    };
    for parameter in parameters {
        urlencoding(parameter)?;
    }
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
    let oauth_resource = match p {
        ["mcp", "services", id] => Some(check_id(id)?),
        _ => None,
    };
    let oauth_token = header(&headers, "authorization")
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.starts_with("smsa_"))
        .map(str::to_owned);
    let authorization: Result<()> = async {
        if let Some(id) = &oauth_resource {
            ensure(
                raw_oauth_path == format!("/mcp/services/{id}"),
                401,
                "invalid_token",
            )?;
            ensure(oauth_token.is_some(), 401, "authentication_required")?;
        }
        if let Some(token) = oauth_token {
            let target = oauth_resource
                .as_ref()
                .ok_or(Error::Api(401, "invalid_token"))?;
            let root = s
                .options
                .public_url
                .as_deref()
                .ok_or(Error::Api(503, "oauth_not_configured"))?
                .trim_end_matches('/');
            let expected = crate::oauth::resource(root, target);
            let relay = r.clone();
            r.store
                .tx(move |tx| {
                    let (relay, token, expected) = (relay.clone(), token.clone(), expected.clone());
                    Box::pin(async move {
                        let access = tx.get("oauthAccess", &hash(&token)).await?;
                        ensure(access["resource"] == expected, 401, "invalid_token")?;
                        relay.agent(tx, &token).await?;
                        Ok(())
                    })
                })
                .await?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = authorization {
        if matches!(error, Error::Api(401, _))
            && method == "POST"
            && let (Some(id), Some(base)) = (&oauth_resource, &s.options.public_url)
            && let Ok(input) = serde_json::from_slice::<Value>(&bytes)
            && input["jsonrpc"] == "2.0"
            && input["method"] == "tools/call"
            && (input["id"].is_string() || input["id"].is_number())
        {
            let challenge = format!(
                "Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp/services/{id}\", error=\"invalid_token\", error_description=\"Connect this service to authorize tools.\"",
                base.trim_end_matches('/')
            );
            return Ok(json_response(
                json!({"jsonrpc":"2.0","id":input["id"],"result":{"isError":true,"content":[{"type":"text","text":"Authorization required."}],"_meta":{"mcp/www_authenticate":[challenge]}}}),
                200,
            ));
        }
        return Err(error);
    }
    let output = match (method.as_str(), p) {
        ("GET", [".well-known", "oauth-authorization-server"]) => crate::oauth::metadata(
            s.options
                .public_url
                .as_deref()
                .ok_or(Error::Api(503, "oauth_not_configured"))?,
        )?,
        (
            "GET",
            [
                ".well-known",
                "oauth-protected-resource",
                "mcp",
                "services",
                id,
            ],
        ) => {
            let id = check_id(id)?;
            let service = r
                .onboarding(
                    "publicService".into(),
                    String::new(),
                    id.clone(),
                    Value::Null,
                )
                .await?;
            let root = s
                .options
                .public_url
                .as_deref()
                .ok_or(Error::Api(503, "oauth_not_configured"))?
                .trim_end_matches('/');
            json!({"resource":crate::oauth::resource(root,&id),"authorization_servers":[root],"bearer_methods_supported":["header"],"scopes_supported":service["capabilities"]})
        }
        ("POST", ["oauth", "register"]) => {
            status = 201;
            r.oauth_register(input, peer.clone(), None).await?
        }
        ("GET", ["oauth", "authorize"]) => {
            let mut params = json!({});
            for (k, v) in &query {
                ensure(params.get(k).is_none(), 400, "invalid_input")?;
                params[k] = json!(v);
            }
            let location = r
                .oauth_start(
                    params,
                    peer.clone(),
                    s.options
                        .public_url
                        .as_deref()
                        .ok_or(Error::Api(503, "oauth_not_configured"))?,
                )
                .await?;
            return Ok((StatusCode::SEE_OTHER, [("Location", location)]).into_response());
        }
        ("POST", ["oauth", "token" | "revoke"]) => {
            ensure(
                input.is_object()
                    && input
                        .as_object()
                        .unwrap()
                        .values()
                        .all(|v| v.as_str().is_some_and(|s| s.len() <= 4096)),
                400,
                "invalid_input",
            )?;
            if p[1] == "token" {
                r.oauth_token(input).await?
            } else {
                r.oauth_revoke(input).await?
            }
        }
        ("GET", ["oauth", "consent", id]) => {
            check_id(id)?;
            return Ok(crate::onboarding_pages::page(&s.options));
        }
        (verb, ["v3", "oauth", "sessions", id, rest @ ..]) => {
            let action = match (verb, rest) {
                ("GET", []) => "review",
                ("POST", ["decision"]) => "decide",
                ("POST", ["response"]) => "response",
                _ => return Err(Error::Api(404, "not_found")),
            };
            r.oauth_session(
                action.into(),
                s.owner(&headers, verb == "GET", false).await?.uid,
                check_id(id)?,
                input,
            )
            .await?
        }
        ("GET", ["owned-services"]) => {
            return Ok(crate::onboarding_pages::owned_services(&s.options));
        }
        ("GET", ["owned-services.js"]) => {
            return Ok((
                [("Content-Type", "application/javascript")],
                include_str!("../../server/public/owned-services.js"),
            )
                .into_response());
        }
        ("GET", ["onboarding-qr.js"]) => {
            return Ok((
                [("Content-Type", "application/javascript")],
                include_str!("../../server/public/onboarding-qr.js"),
            )
                .into_response());
        }
        ("GET", ["ticket-browser.js"]) => {
            return Ok((
                [("Content-Type", "application/javascript")],
                include_str!("../../server/public/ticket-browser.js"),
            )
                .into_response());
        }
        ("GET", ["onboarding.js"]) => {
            return Ok((
                [("Content-Type", "application/javascript")],
                include_str!("../../server/public/onboarding.js"),
            )
                .into_response());
        }
        ("GET", ["register" | "pair" | "services" | "connections", public_id]) => {
            check_id(public_id)?;
            return Ok(crate::onboarding_pages::page(&s.options));
        }
        (verb, ["v3", rest @ ..]) => {
            let (op, credential, target, created) = match (verb, rest) {
                ("POST", ["registration-sessions"]) => {
                    ("register", bearer(&headers)?, peer.clone(), true)
                }
                ("GET", ["registration-sessions", "current"]) => {
                    ("registrationPoll", bearer(&headers)?, String::new(), false)
                }
                ("GET", ["registration-sessions", id]) => (
                    "registrationReview",
                    s.owner(&headers, true, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                ("POST", ["registration-sessions", id, "decision"]) => (
                    "registrationDecide",
                    s.owner(&headers, false, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                ("POST", ["services"]) => (
                    "provision",
                    s.owner(&headers, false, false).await?.uid,
                    String::new(),
                    true,
                ),
                ("GET", ["service"]) => ("ticketService", bearer(&headers)?, String::new(), false),
                ("GET", ["services"]) => (
                    "listServices",
                    s.owner(&headers, true, false).await?.uid,
                    String::new(),
                    false,
                ),
                ("GET", ["services", id]) => (
                    "publicService",
                    s.owner(&headers, true, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                ("PATCH", ["services", id]) => (
                    "manageService",
                    s.owner(&headers, false, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                ("DELETE", ["services", id]) => {
                    input = json!({"delete":true});
                    (
                        "manageService",
                        s.owner(&headers, false, false).await?.uid,
                        check_id(id)?,
                        false,
                    )
                }
                ("POST", ["services", id, "connections"]) => (
                    "permanent",
                    s.owner(&headers, false, false).await?.uid,
                    check_id(id)?,
                    true,
                ),
                ("PATCH", ["service"]) => ("rotate", bearer(&headers)?, String::new(), false),
                ("POST", ["service", "pairing-sessions"]) => {
                    ("pairing", bearer(&headers)?, String::new(), true)
                }
                ("GET", ["service", "pairing-sessions", id]) => {
                    ("pairingPoll", bearer(&headers)?, check_id(id)?, false)
                }
                ("GET", ["pairing-sessions", id]) => (
                    "pairingReview",
                    s.owner(&headers, true, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                ("POST", ["pairing-sessions", id, "decision"]) => (
                    "pairingDecide",
                    s.owner(&headers, false, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                ("GET", ["service", "deliveries"]) => {
                    ("deliveries", bearer(&headers)?, String::new(), false)
                }
                ("POST", ["service", "deliveries", id, "acknowledgement"]) => {
                    ("acknowledge", bearer(&headers)?, check_id(id)?, false)
                }
                ("GET", ["connection"]) => {
                    ("connectionStatus", bearer(&headers)?, String::new(), false)
                }
                ("GET", ["service", "connections", id]) => (
                    "serviceConnectionStatus",
                    bearer(&headers)?,
                    check_id(id)?,
                    false,
                ),
                ("GET", ["connections", id]) => (
                    "ownerConnectionStatus",
                    s.owner(&headers, true, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                ("PATCH", ["connections", id]) => (
                    "manageConnection",
                    s.owner(&headers, false, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                ("DELETE", ["connections", id]) => (
                    "disconnect",
                    s.owner(&headers, false, false).await?.uid,
                    check_id(id)?,
                    false,
                ),
                _ => return Err(Error::Api(404, "not_found")),
            };
            if created {
                status = 201;
            }
            r.onboarding(op.into(), credential, target, input.clone())
                .await?
        }
        ("GET", ["health" | "healthz"]) => json!({"ok":true}),
        ("GET", ["startup"]) => {
            let ready = match &s.options.serving {
                Some(gate) => gate.assert_serving().await.is_ok(),
                None => true,
            };
            return Ok(json_response(
                json!({"ok":ready}),
                if ready { 200 } else { 503 },
            ));
        }
        ("GET", ["privacy"] | ["account", "delete"]) => {
            return Ok(
                crate::account_pages::account_page(&path.to_ascii_lowercase(), &s.options)
                    .expect("matched account page"),
            );
        }
        ("GET", ["v1", "account-deletion"]) => r.deletion_status(bearer(&headers)?).await?,
        ("GET", [".well-known", "apple-app-site-association"]) => {
            json!({"applinks":{"details":s.options.apple_app_ids.iter().filter(|id| regex::Regex::new(r"^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$").unwrap().is_match(id)).map(|id|json!({"appID":id,"paths":["/register/*","/pair/*","/services/*","/connections/*","/oauth/consent/*","/connect","/owned-services"]})).collect::<Vec<_>>()}})
        }
        ("GET", [".well-known", "assetlinks.json"]) => {
            let (package, _) = android_link_target(s.options.android_package.as_deref())?;
            let certificates = signing_fingerprints(
                s.options.android_cert.as_deref(),
                s.options.android_certs.as_ref(),
            )?;
            json!([{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":package,"sha256_cert_fingerprints":certificates}}])
        }
        ("GET", ["connect"]) => {
            let code = user_code(&query_value("code")?.ok_or(Error::Api(400, "invalid_input"))?)?;
            let code = format!("{}-{}", &code[..5], &code[5..]);
            let (_, scheme) = android_link_target(s.options.android_package.as_deref())?;
            let html = include_str!("../compat/connect.html")
                .replace("{{CODE}}", &code)
                .replace("smsrelay://connect", &format!("{scheme}://connect"));
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
            let uid = s
                .owner(&headers, method == axum::http::Method::GET, false)
                .await?
                .uid;
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
        ("GET", ["v1", "devices"]) => {
            r.list_devices(
                &s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
            )
            .await?
        }
        ("PUT", ["v1", "devices", did]) => {
            let uid = s
                .owner(&headers, method == axum::http::Method::GET, false)
                .await?
                .uid;
            strict(&input, &["name", "fcmToken", "wizardVersion", "platform"])?;
            let platform = input
                .get("platform")
                .and_then(Value::as_str)
                .unwrap_or("android");
            ensure(
                input.get("platform").is_none()
                    || input["platform"] == "android"
                    || input["platform"] == "ios",
                400,
                "invalid_input",
            )?;
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
                platform.to_owned(),
            )
            .await?
        }
        ("PATCH", ["v1", "devices", did]) => {
            let uid = s
                .owner(&headers, method == axum::http::Method::GET, false)
                .await?
                .uid;
            strict(&input, &["paused"])?;
            let paused = input["paused"]
                .as_bool()
                .ok_or(Error::Api(400, "invalid_input"))?;
            r.change_device(uid, check_id(did)?, paused, false).await?;
            json!({"ok":true})
        }
        ("DELETE", ["v1", "devices", did]) => {
            r.change_device(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                check_id(did)?,
                true,
                true,
            )
            .await?;
            json!({"ok":true})
        }
        ("GET", ["v1", "callers"]) => {
            r.list_grants(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                None,
            )
            .await?
        }
        ("GET", ["v1", "devices", did, "grants"]) => {
            r.list_grants(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                Some(check_id(did)?),
            )
            .await?
        }
        ("POST", ["v1", "devices", did, "grants"]) => {
            let uid = s
                .owner(&headers, method == axum::http::Method::GET, false)
                .await?
                .uid;
            strict(&input, &["callerName", "expiresInDays"])?;
            let name = string(&input, "callerName", 1, 80, true)?;
            let days = integer(&input, "expiresInDays", 1, 90, Some(30))?;
            status = 201;
            r.create_grant(uid, check_id(did)?, name, days).await?
        }
        ("DELETE", ["v1", "grants", gid]) => {
            r.revoke(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                check_id(gid)?,
            )
            .await?;
            json!({"ok":true})
        }
        ("DELETE", ["v1", "account"]) => {
            let identity = s.owner(&headers, false, true).await?;
            let now = r.now() as f64 / 1000.0;
            ensure(
                now - identity.auth_time < 300.0 && identity.auth_time <= now + 30.0,
                401,
                "recent_sign_in_required",
            )?;
            r.access_read(identity.uid.clone(), None).await?;
            status = 202;
            r.deletion_request(identity.uid).await?
        }
        ("GET", ["v1", "history"]) => {
            r.history(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                None,
            )
            .await?
        }
        ("GET", ["v1", "devices", did, "history"]) => {
            r.history(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                Some(check_id(did)?),
            )
            .await?
        }
        ("GET", ["v1", "devices", did, "requests", rid]) => {
            r.phone_get(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                check_id(did)?,
                check_id(rid)?,
            )
            .await?
        }
        ("POST", ["v1", "devices", did, "requests", rid, "events"]) => {
            let uid = s
                .owner(&headers, method == axum::http::Method::GET, false)
                .await?
                .uid;
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
        ("GET", ["v1", "requests", rid]) => {
            r.get(s.agent_read(&headers).await?, check_id(rid)?).await?
        }
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
            r.form_get(Auth::Agent(s.agent_read(&headers).await?), check_id(rid)?)
                .await?
        }
        ("GET", ["v2", "requests", rid, "result"]) => {
            r.form_result(s.agent_read(&headers).await?, check_id(rid)?)
                .await?
        }
        ("POST", ["v2", "requests", rid, "cancel"]) => {
            r.form_cancel(bearer(&headers)?, check_id(rid)?).await?
        }
        ("GET", ["v2", "devices", did, "inbox"]) => {
            r.inbox(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                check_id(did)?,
            )
            .await?
        }
        ("GET", ["v2", "devices", did, "requests", rid]) => {
            r.form_get(
                Auth::Phone {
                    uid: s
                        .owner(&headers, method == axum::http::Method::GET, false)
                        .await?
                        .uid,
                    device: check_id(did)?,
                },
                check_id(rid)?,
            )
            .await?
        }
        ("POST", ["v2", "devices", did, "requests", rid, "events"]) => {
            let uid = s
                .owner(&headers, method == axum::http::Method::GET, false)
                .await?
                .uid;
            let did = check_id(did)?;
            let rid = check_id(rid)?;
            r.observe(uid, did, rid, input).await?
        }
        ("POST", ["v2", "devices", did, "requests", rid, "submissions"]) => {
            let uid = s
                .owner(&headers, method == axum::http::Method::GET, false)
                .await?
                .uid;
            r.submit(uid, check_id(did)?, check_id(rid)?, input).await?
        }
        ("PUT", ["v2", "grants", gid, "forms"]) => {
            strict(&input, &["approved"])?;
            let approved = input["approved"]
                .as_bool()
                .ok_or(Error::Api(400, "invalid_input"))?;
            r.approve_forms(
                s.owner(&headers, method == axum::http::Method::GET, false)
                    .await?
                    .uid,
                check_id(gid)?,
                approved,
            )
            .await?;
            json!({"ok":true})
        }
        ("POST", ["v2", "webhooks"]) => {
            status = 201;
            r.register_webhook(bearer(&headers)?, input).await?
        }
        ("GET", ["v2", "webhooks"]) => r.webhooks(s.agent_read(&headers).await?, None).await?,
        ("DELETE", ["v2", "webhooks", hid]) => {
            r.webhooks(bearer(&headers)?, Some(check_id(hid)?)).await?
        }
        ("GET", ["v2", "events"]) => r.events(s.agent_read(&headers).await?, cursor()?).await?,
        ("GET", ["v2", "events", "stream"]) => {
            return stream(
                s.clone(),
                s.agent_read(&headers).await?,
                cursor()?,
                parts
                    .extensions
                    .get::<axum::extract::ConnectInfo<crate::newtransport::Connection>>()
                    .map(|connection| connection.0.clone()),
            )
            .await;
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
            let context = WorkerContext::from_headers(
                s.options.project_id.as_deref(),
                header(&headers, "traceparent"),
                header(&headers, "x-cloud-trace-context"),
            );
            *worker_context = context.clone();
            if *operation == "delivery" {
                r.deletion_dispatch(s.options.auth.clone()).await?;
                r.dispatch_with_context(context.as_ref()).await?;
            } else {
                r.telemetry_maintenance_with_context(s.options.auth.clone(), context.as_ref())
                    .await?;
            }
            json!({"ok":true})
        }
        ("POST", ["mcp"] | ["mcp", "services", _]) => {
            let secret = bearer(&headers)?;
            r.check_agent(&secret).await?;
            let messages = input
                .as_array()
                .map(|messages| messages.as_slice())
                .unwrap_or_else(|| std::slice::from_ref(&input));
            for message in messages {
                if message["method"] == "tools/call"
                    && [
                        "get_sms_code_request",
                        "inspect_request",
                        "get_request_result",
                        "poll_request_events",
                    ]
                    .contains(&text(&message["params"], "name"))
                {
                    s.agent_read(&headers).await?;
                }
            }
            let request =
                Request::from_parts(parts, Body::from(serde_json::to_vec(&input).unwrap()));
            return Ok(crate::mcp::handle(r.clone(), secret, request, input).await);
        }
        (_, ["mcp"] | ["mcp", "services", _]) => return Err(Error::Api(405, "method_not_allowed")),
        _ => return Err(Error::Api(404, "not_found")),
    };
    if let Some(event) =
        crate::telemetry::onboarding_outcome(&path, method.as_str(), status, &output)
    {
        r.delivery.record(event).await;
    }
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
                return Err(Error::External);
            };
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).map_err(|_| Error::External)
}
fn android_link_target(package: Option<&str>) -> Result<(&'static str, &'static str)> {
    match package.unwrap_or("com.bluegrain.smsrelay") {
        "com.bluegrain.smsrelay" => Ok(("com.bluegrain.smsrelay", "smsrelay")),
        "com.bluegrain.smsrelay.staging" => {
            Ok(("com.bluegrain.smsrelay.staging", "smsrelay-staging"))
        }
        _ => Err(Error::Api(503, "app_links_not_configured")),
    }
}
fn signing_fingerprints(legacy: Option<&str>, additional: Option<&Value>) -> Result<Vec<String>> {
    ensure(
        additional.is_none_or(Value::is_array),
        503,
        "app_links_not_configured",
    )?;
    let values = additional
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .cloned()
        .chain(
            legacy
                .filter(|value| !value.is_empty())
                .map(|value| json!(value)),
        );
    let format = regex::Regex::new(r"^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$").unwrap();
    let mut fingerprints = Vec::new();
    for value in values {
        let value = value
            .as_str()
            .filter(|value| format.is_match(value))
            .ok_or(Error::Api(503, "app_links_not_configured"))?
            .to_ascii_uppercase();
        if !fingerprints.contains(&value) {
            fingerprints.push(value);
        }
    }
    ensure(!fingerprints.is_empty(), 503, "app_links_not_configured")?;
    Ok(fingerprints)
}
struct StreamAdmission {
    relay: Relay,
    lease: Option<Value>,
}
impl StreamAdmission {
    async fn release(mut self) {
        if let Some(lease) = self.lease.take() {
            let _ = self.relay.access_release(lease).await;
        }
    }
}
impl Drop for StreamAdmission {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            let relay = self.relay.clone();
            tokio::spawn(async move {
                let _ = relay.access_release(lease).await;
            });
        }
    }
}
async fn stream(
    s: App,
    secret: String,
    cursor: Option<String>,
    connection: Option<crate::newtransport::Connection>,
) -> Result<Response> {
    let page = s.relay.events(secret.clone(), cursor.clone()).await?;
    let relay = s.relay.clone();
    let key = secret.clone();
    let grant = s
        .relay
        .store
        .tx(move |tx| {
            let (relay, key) = (relay.clone(), key.clone());
            Box::pin(async move { Ok(relay.agent(tx, &key).await?.0) })
        })
        .await?;
    let lease = s
        .relay
        .access_stream(
            text(&grant, "ownerId").into(),
            text(&grant, "id").into(),
            s.options.sse_duration.as_millis().min(i64::MAX as u128) as i64,
        )
        .await?;
    let remaining = (num(&lease, "deadline") - s.relay.now()).max(0) as u64;
    let admission = StreamAdmission {
        relay: s.relay.clone(),
        lease: Some(lease),
    };
    let end = tokio::time::Instant::now() + Duration::from_millis(remaining);
    let transport = connection.map(|connection| connection.stream_deadline(end));
    let response_deadline = transport.clone();
    let feed = tokio::select! {
        feed = s.streams.subscribe(secret.clone()) => match feed {
            Ok(feed) => feed,
            Err(_) => { admission.release().await; return Ok(stream_response(Response::new(finish_stream(Body::empty(), transport)), response_deadline)); }
        },
        _ = tokio::time::sleep_until(end) => { admission.release().await; return Ok(stream_response(Response::new(finish_stream(Body::empty(), transport)), response_deadline)); },
    };
    let body = event_body(
        page,
        cursor,
        end,
        SharedFeed {
            relay: s.relay,
            secret,
            feed,
        },
        admission.release(),
        transport,
    );
    Ok(stream_response(
        (
            [
                ("Content-Type", "text/event-stream"),
                ("Cache-Control", "no-cache, no-store"),
                ("X-Accel-Buffering", "no"),
            ],
            body,
        )
            .into_response(),
        response_deadline,
    ))
}
fn stream_response(
    mut response: Response,
    deadline: Option<crate::newtransport::StreamDeadline>,
) -> Response {
    if let Some(deadline) = deadline {
        response.extensions_mut().insert(deadline);
    }
    response
}
async fn feed_page(
    feed: &crate::event_streams::FeedSubscription,
    relay: &Relay,
    secret: &str,
    next: &Option<String>,
) -> Result<Value> {
    let sequence = next
        .as_ref()
        .and_then(|cursor| cursor.get(cursor.len().saturating_sub(16)..))
        .and_then(|sequence| sequence.parse::<i64>().ok())
        .unwrap_or(0);
    let events = feed.tail(sequence, relay.now());
    if !events.is_empty() && feed.oldest().is_some_and(|oldest| sequence < oldest - 1) {
        relay.events(secret.into(), next.clone()).await
    } else {
        Ok(json!({"events": events, "cursor": next}))
    }
}
trait EventFeed: Send + 'static {
    fn failed(&self) -> bool;
    fn ready(&self) -> bool;
    fn wait_ready(&self) -> futures::future::BoxFuture<'_, Result<()>>;
    fn revision(&self) -> u64;
    fn closed(&self) -> futures::future::BoxFuture<'static, ()>;
    fn changed(&mut self) -> futures::future::BoxFuture<'_, Result<()>>;
    fn page(
        &self,
        next: Option<String>,
        replay: bool,
    ) -> futures::future::BoxFuture<'_, Result<Value>>;
}
struct SharedFeed {
    relay: Relay,
    secret: String,
    feed: crate::event_streams::FeedSubscription,
}
impl EventFeed for SharedFeed {
    fn failed(&self) -> bool {
        self.feed.failed()
    }
    fn ready(&self) -> bool {
        self.feed.ready()
    }
    fn wait_ready(&self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(self.feed.wait_ready())
    }
    fn revision(&self) -> u64 {
        self.feed.revision()
    }
    fn closed(&self) -> futures::future::BoxFuture<'static, ()> {
        Box::pin(self.feed.closed())
    }
    fn changed(&mut self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(self.feed.changed())
    }
    fn page(
        &self,
        next: Option<String>,
        replay: bool,
    ) -> futures::future::BoxFuture<'_, Result<Value>> {
        Box::pin(async move {
            if replay {
                self.relay.events(self.secret.clone(), next).await
            } else {
                feed_page(&self.feed, &self.relay, &self.secret, &next).await
            }
        })
    }
}
fn finish_stream(body: Body, transport: Option<crate::newtransport::StreamDeadline>) -> Body {
    match transport {
        Some(transport) => {
            transport.stop();
            transport.body(body)
        }
        None => body,
    }
}
// Real feeds and regression stimuli use the same pump and independent supervisor.
// A pending database read cannot suppress the deadline or disconnect signal.
fn event_body<Feed, Release>(
    mut page: Value,
    mut next: Option<String>,
    end: tokio::time::Instant,
    mut feed: Feed,
    release: Release,
    transport: Option<crate::newtransport::StreamDeadline>,
) -> Body
where
    Feed: EventFeed,
    Release: std::future::Future<Output = ()> + Send + 'static,
{
    use futures::StreamExt;
    let (tx, rx) = tokio::sync::mpsc::channel::<std::result::Result<String, Infallible>>(128);
    let failed = feed.closed();
    let supervisor_transport = transport.clone();
    tokio::spawn(async move {
        let pump = async {
            if feed.wait_ready().await.is_err()
                || tx.try_send(Ok("retry: 1000\n\n".into())).is_err()
            {
                return;
            }
            loop {
                if !feed.ready() && feed.wait_ready().await.is_err() {
                    return;
                }
                let revision = feed.revision();
                for event in arr(&page, "events") {
                    if feed.failed() || (!feed.ready() && feed.wait_ready().await.is_err()) {
                        return;
                    }
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
                if arr(&page, "events").len() == 100 {
                    match feed.page(next.clone(), true).await {
                        Ok(value) => page = value,
                        Err(_) => return,
                    }
                    continue;
                }
                match feed.page(next.clone(), false).await {
                    Ok(value) => page = value,
                    Err(_) => return,
                }
                if !arr(&page, "events").is_empty() {
                    continue;
                }
                if (!feed.ready() && feed.wait_ready().await.is_err())
                    || tx.try_send(Ok(": heartbeat\n\n".into())).is_err()
                {
                    return;
                }
                if feed.revision() == revision {
                    tokio::select! {
                        result=feed.changed()=>{ if result.is_err(){return;} },
                        _=tokio::time::sleep(Duration::from_secs(1))=>{}
                    }
                }
                match feed.page(next.clone(), false).await {
                    Ok(value) => page = value,
                    Err(_) => return,
                }
            }
        };
        tokio::select! {
            _=pump=>{}, _=failed=>{}, _=tokio::time::sleep_until(end)=>{}, _=tx.closed()=>{}
        }
        if let Some(transport) = supervisor_transport {
            transport.stop();
        }
        drop(tx);
        drop(feed);
        release.await;
    });
    let body = Body::from_stream(
        tokio_stream::wrappers::ReceiverStream::new(rx).take_until(tokio::time::sleep_until(end)),
    );
    match transport {
        Some(transport) => transport.body(body),
        None => body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct ProbeGate(AtomicBool);
    impl Serving for ProbeGate {
        fn assert_serving(&self) -> futures::future::BoxFuture<'_, Result<()>> {
            Box::pin(async { ensure(!self.0.load(Ordering::SeqCst), 503, "recovery_in_progress") })
        }
    }
    struct ProbeAuth;
    impl Authentication for ProbeAuth {
        fn owner<'a>(&'a self, _: &'a str) -> futures::future::BoxFuture<'a, Result<Identity>> {
            Box::pin(async { panic!("probes must not authenticate an owner") })
        }
        fn worker<'a>(&'a self, _: &'a str) -> futures::future::BoxFuture<'a, Result<()>> {
            Box::pin(async { panic!("probes must not authenticate a worker") })
        }
        fn delete<'a>(&'a self, _: &'a str) -> futures::future::BoxFuture<'a, Result<()>> {
            Box::pin(async { panic!("probes must not delete an identity") })
        }
    }

    #[tokio::test]
    async fn startup_probe_waits_for_serving_gate_while_liveness_stays_available() {
        use tower::ServiceExt;
        let gate = Arc::new(ProbeGate(AtomicBool::new(true)));
        let (logger, _events) = tokio::sync::mpsc::unbounded_channel();
        let relay = Relay {
            store: crate::store::Store::new("demo-startup-probe")
                .await
                .unwrap(),
            clock: Arc::new(crate::model::now),
            delivery: Arc::new(Capture(logger)),
        };
        let router = app(
            relay,
            Options {
                project_id: Some("demo-startup-probe".into()),
                auth: Arc::new(ProbeAuth),
                serving: Some(gate.clone()),
                public_url: None,
                apple_app_ids: vec![],
                android_cert: None,
                android_certs: None,
                android_package: None,
                firebase_web_config: None,
                privacy_contact: None,
                origins: vec![],
                trust_proxy_hops: 0,
                sse_duration: Duration::from_secs(100),
            },
        );
        for (blocked, path, status, ok) in [
            (true, "/health", 200, true),
            (true, "/healthz", 200, true),
            (true, "/startup", 503, false),
            (false, "/startup", 200, true),
            (true, "/startup", 503, false),
            (true, "/health", 200, true),
        ] {
            gate.0.store(blocked, Ordering::SeqCst);
            let response = router
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status, "{path}");
            let bytes = axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&bytes).unwrap(),
                json!({"ok":ok})
            );
        }
    }

    #[derive(Default)]
    struct ScriptedFeed {
        reads: Arc<AtomicUsize>,
    }
    impl EventFeed for ScriptedFeed {
        fn failed(&self) -> bool {
            false
        }
        fn ready(&self) -> bool {
            true
        }
        fn wait_ready(&self) -> futures::future::BoxFuture<'_, Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn revision(&self) -> u64 {
            0
        }
        fn closed(&self) -> futures::future::BoxFuture<'static, ()> {
            Box::pin(std::future::pending())
        }
        fn changed(&mut self) -> futures::future::BoxFuture<'_, Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn page(
            &self,
            _: Option<String>,
            _: bool,
        ) -> futures::future::BoxFuture<'_, Result<Value>> {
            let read = self.reads.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                if read == 0 {
                    Ok(json!({"events":[]}))
                } else {
                    std::future::pending().await
                }
            })
        }
    }

    struct RecoveringFeed {
        readiness: tokio::sync::watch::Receiver<bool>,
        replay: tokio::sync::watch::Receiver<Option<Value>>,
        reads: Arc<AtomicUsize>,
    }
    impl EventFeed for RecoveringFeed {
        fn failed(&self) -> bool {
            false
        }
        fn ready(&self) -> bool {
            *self.readiness.borrow()
        }
        fn wait_ready(&self) -> futures::future::BoxFuture<'_, Result<()>> {
            let mut readiness = self.readiness.clone();
            Box::pin(async move {
                loop {
                    if *readiness.borrow_and_update() {
                        return Ok(());
                    }
                    readiness.changed().await.map_err(|_| Error::External)?;
                }
            })
        }
        fn revision(&self) -> u64 {
            0
        }
        fn closed(&self) -> futures::future::BoxFuture<'static, ()> {
            Box::pin(std::future::pending())
        }
        fn changed(&mut self) -> futures::future::BoxFuture<'_, Result<()>> {
            Box::pin(std::future::pending())
        }
        fn page(
            &self,
            _: Option<String>,
            replay: bool,
        ) -> futures::future::BoxFuture<'_, Result<Value>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let mut result = self.replay.clone();
            Box::pin(async move {
                if !replay {
                    return Ok(json!({"events":[]}));
                }
                loop {
                    if let Some(page) = result.borrow_and_update().clone() {
                        return Ok(page);
                    }
                    result.changed().await.map_err(|_| Error::External)?;
                }
            })
        }
    }

    #[tokio::test]
    async fn stream_withholds_pending_replay_until_authorization_watch_is_current_again() {
        use http_body_util::BodyExt;
        let (ready, readiness) = tokio::sync::watch::channel(true);
        let (replay, result) = tokio::sync::watch::channel(None);
        let reads = Arc::new(AtomicUsize::new(0));
        let (released, release_seen) = tokio::sync::oneshot::channel();
        let events = (0..100)
            .map(|id| json!({"id":id.to_string(),"type":"request.created"}))
            .collect::<Vec<_>>();
        let mut body = event_body(
            json!({"events":events}),
            None,
            tokio::time::Instant::now() + Duration::from_secs(60),
            RecoveringFeed {
                readiness,
                replay: result,
                reads: reads.clone(),
            },
            async move {
                let _ = released.send(());
            },
            None,
        );
        // Drain the initial retry and durable page through the real supervisor.
        for _ in 0..101 {
            tokio::time::timeout(Duration::from_secs(1), body.frame())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while reads.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        ready.send_replace(false);
        replay.send_replace(Some(
            json!({"events":[{"id":"resumed","type":"request.created"}]}),
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), body.frame())
                .await
                .is_err(),
            "a completed durable read must not bypass a disconnected authorization watch"
        );
        ready.send_replace(true);
        let frame = tokio::time::timeout(Duration::from_secs(1), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(frame.data_ref().unwrap()).contains("id: resumed\n"));
        drop(body);
        tokio::time::timeout(Duration::from_secs(1), release_seen)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn stream_deadline_remains_independent_while_authorization_watch_is_not_current() {
        let (_ready, readiness) = tokio::sync::watch::channel(false);
        let (_replay, replay) = tokio::sync::watch::channel(None);
        let reads = Arc::new(AtomicUsize::new(0));
        let (released, release_seen) = tokio::sync::oneshot::channel();
        let body = event_body(
            json!({"events":[{"id":"withheld","type":"request.created"}]}),
            None,
            tokio::time::Instant::now() + Duration::from_millis(50),
            RecoveringFeed {
                readiness,
                replay,
                reads: reads.clone(),
            },
            async move {
                let _ = released.send(());
            },
            None,
        );
        let bytes = tokio::time::timeout(Duration::from_secs(1), axum::body::to_bytes(body, 1024))
            .await
            .unwrap()
            .unwrap();
        assert!(bytes.is_empty());
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        tokio::time::timeout(Duration::from_secs(1), release_seen)
            .await
            .unwrap()
            .unwrap();
    }

    struct Capture(tokio::sync::mpsc::UnboundedSender<Value>);
    impl Delivery for Capture {
        fn record(&self, event: Value) -> futures::future::BoxFuture<'_, ()> {
            Box::pin(async move {
                let _ = self.0.send(event);
            })
        }
        fn notify<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: i64,
            _: bool,
        ) -> futures::future::BoxFuture<'a, Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn wake(&self) -> futures::future::BoxFuture<'_, Result<()>> {
            Box::pin(async { Ok(()) })
        }
        fn webhook<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a Value,
        ) -> futures::future::BoxFuture<'a, Result<()>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn failed_worker_response_completion_retains_trusted_context() {
        let (logger, mut events) = tokio::sync::mpsc::unbounded_channel();
        let context = WorkerContext::from_headers(
            Some("demo-sms-relay"),
            Some("00-1234567890abcdef1234567890abcdef-0000000000000001-00"),
            None,
        )
        .unwrap();
        let mut response = json_response(json!({"error":"internal_error"}), 500);
        response.extensions_mut().insert(context.clone());
        let measured = measured_response(
            response,
            Arc::new(Capture(logger)),
            "POST",
            "/internal/delivery",
            Instant::now(),
        );
        axum::body::to_bytes(measured.into_body(), 1024)
            .await
            .unwrap();
        let entry = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry["event"], "http_completed");
        assert_eq!(entry["status_class"], "5xx");
        assert_eq!(entry["logging.googleapis.com/trace"], context.trace());
    }

    #[tokio::test]
    async fn http_completion_preserves_json_headers_body_and_exact_size_hint() {
        let (logger, mut events) = tokio::sync::mpsc::unbounded_channel();
        let response = json_response(json!({"ok":true}), 200);
        let headers = response.headers().clone();
        let length = response.body().size_hint().exact();
        let response = measured_response(
            response,
            Arc::new(Capture(logger)),
            "GET",
            "/health",
            Instant::now(),
        );
        assert_eq!(response.headers(), &headers);
        assert_eq!(response.body().size_hint().exact(), length);
        assert!(!response.body().is_end_stream());
        assert!(events.try_recv().is_err());
        let bytes = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(bytes.as_ref(), b"{\"ok\":true}");
        let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["event"], "http_completed");
        assert_eq!(event["status_class"], "2xx");
        assert_eq!(event["route"], "/health");
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn http_completion_waits_until_the_sse_body_finishes() {
        let (logger, mut events) = tokio::sync::mpsc::unbounded_channel();
        let body = event_body(
            json!({"events":[]}),
            None,
            tokio::time::Instant::now() + Duration::from_millis(100),
            ScriptedFeed::default(),
            async {},
            None,
        );
        let response = measured_response(
            Response::new(body),
            Arc::new(Capture(logger)),
            "GET",
            "/v2/events/stream",
            Instant::now(),
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(events.try_recv().is_err());
        let bytes = tokio::time::timeout(
            Duration::from_secs(1),
            axum::body::to_bytes(response.into_body(), 1024),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("heartbeat"));
        let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(num(&event, "duration_ms") >= 70);
        assert_eq!(event["route"], "/v2/events/stream");
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn stream_deadline_releases_admission_while_event_read_remains_pending() {
        let reads = Arc::new(AtomicUsize::new(0));
        let (released, release_seen) = tokio::sync::oneshot::channel();
        let body = event_body(
            json!({"events":[]}),
            None,
            tokio::time::Instant::now() + Duration::from_millis(100),
            ScriptedFeed {
                reads: reads.clone(),
            },
            async move {
                let _ = released.send(());
            },
            None,
        );
        let bytes = tokio::time::timeout(Duration::from_secs(1), axum::body::to_bytes(body, 1024))
            .await
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("heartbeat"));
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        tokio::time::timeout(Duration::from_secs(1), release_seen)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn stream_disconnect_releases_admission_before_its_deadline() {
        let (released, release_seen) = tokio::sync::oneshot::channel();
        let body = event_body(
            json!({"events":[]}),
            None,
            tokio::time::Instant::now() + Duration::from_secs(60),
            ScriptedFeed::default(),
            async move {
                let _ = released.send(());
            },
            None,
        );
        drop(body);
        tokio::time::timeout(Duration::from_secs(1), release_seen)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn stream_backpressure_stops_production_and_releases_admission() {
        let (released, release_seen) = tokio::sync::oneshot::channel();
        let events = (0..200)
            .map(|id| json!({"id":id.to_string(),"type":"request.created"}))
            .collect::<Vec<_>>();
        let body = event_body(
            json!({"events":events}),
            None,
            tokio::time::Instant::now() + Duration::from_secs(60),
            ScriptedFeed::default(),
            async move {
                let _ = released.send(());
            },
            None,
        );
        // Keep the receiver open without reading, as a stalled HTTP consumer does.
        tokio::time::timeout(Duration::from_secs(1), release_seen)
            .await
            .unwrap()
            .unwrap();
        let bytes =
            tokio::time::timeout(Duration::from_secs(1), axum::body::to_bytes(body, 100_000))
                .await
                .unwrap()
                .unwrap();
        let frames = String::from_utf8_lossy(&bytes);
        assert!(frames.contains("event: request.created"));
        assert!(!frames.contains("id: 199\n"));
    }

    #[tokio::test]
    async fn stalled_tcp_writer_is_closed_after_stream_deadline_and_grace() {
        use crate::newtransport::{Connection, DeadlineListener, connection_info};
        use axum::{extract::ConnectInfo, routing::get};
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpSocket,
        };
        let listener = TcpSocket::new_v4().unwrap();
        listener.set_send_buffer_size(4096).unwrap();
        listener.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let listener = listener.listen(16).unwrap();
        let address = listener.local_addr().unwrap();
        let (connection_seen, connection_received) = tokio::sync::oneshot::channel();
        let connection_seen = Arc::new(std::sync::Mutex::new(Some(connection_seen)));
        let (released, release_seen) = tokio::sync::oneshot::channel();
        let released = Arc::new(std::sync::Mutex::new(Some(released)));
        let route = get(move |ConnectInfo(connection): ConnectInfo<Connection>| {
            let connection_seen = connection_seen.clone();
            let released = released.clone();
            async move {
                let end = tokio::time::Instant::now() + Duration::from_millis(150);
                connection_seen
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap()
                    .send(connection.clone())
                    .ok();
                let events = (0..100).map(|id| json!({"id":id.to_string(),"type":"request.created","padding":"x".repeat(64 * 1024)})).collect::<Vec<_>>();
                let released = released.lock().unwrap().take().unwrap();
                let body = event_body(
                    json!({"events":events}),
                    None,
                    end,
                    ScriptedFeed::default(),
                    async move {
                        let _ = released.send(());
                    },
                    Some(connection.stream_deadline(end)),
                );
                (
                    [
                        ("Content-Type", "text/event-stream"),
                        ("Cache-Control", "no-cache, no-store"),
                    ],
                    body,
                )
                    .into_response()
            }
        });
        let router = Router::new()
            .route("/stream", route)
            .layer(middleware::from_fn(connection_info));
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(
                DeadlineListener(listener),
                router.into_make_service_with_connect_info::<Connection>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        let socket = TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(4096).unwrap();
        let mut client = socket.connect(address).await.unwrap();
        client
            .write_all(b"GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let connection = tokio::time::timeout(Duration::from_secs(2), connection_received)
            .await
            .expect("TCP request must reach the stream handler before testing its deadline")
            .unwrap();
        let mut closed = connection.socket_closed();
        // No client reads until the actual server-side TCP IO has been dropped.
        tokio::time::timeout(Duration::from_millis(700), release_seen)
            .await
            .unwrap()
            .unwrap();
        assert!(
            connection.write_blocked(),
            "test must reach a real kernel write stall"
        );
        tokio::time::timeout(Duration::from_millis(1600), async {
            while !*closed.borrow_and_update() {
                closed.changed().await.unwrap();
            }
        })
        .await
        .expect("stalled TCP connection outlived its deadline plus grace");
        let mut wire = Vec::new();
        tokio::time::timeout(Duration::from_secs(1), client.read_to_end(&mut wire))
            .await
            .unwrap()
            .unwrap();
        assert!(wire.starts_with(b"HTTP/1.1 200"));
        assert!(
            wire.len() < 6 * 1024 * 1024,
            "the stream was interrupted before the pending frames drained"
        );
        let _ = stop.send(());
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn flushed_stream_clears_watchdog_for_next_keepalive_request() {
        use crate::newtransport::{Connection, DeadlineListener, connection_info};
        use axum::{extract::ConnectInfo, routing::get};
        let first = get(
            |ConnectInfo(connection): ConnectInfo<Connection>| async move {
                let end = tokio::time::Instant::now() + Duration::from_millis(30);
                let body = event_body(
                    json!({"events":[]}),
                    None,
                    end,
                    ScriptedFeed::default(),
                    async {},
                    Some(connection.stream_deadline(end)),
                );
                (
                    [("peer-port", connection.peer_addr.port().to_string())],
                    body,
                )
                    .into_response()
            },
        );
        let next = get(
            |ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>| async move {
                tokio::time::sleep(Duration::from_millis(1200)).await;
                ([("peer-port", peer.port().to_string())], "reused").into_response()
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .route("/stream", first)
            .route("/next", next)
            .layer(middleware::from_fn(connection_info));
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(
                DeadlineListener(listener),
                router.into_make_service_with_connect_info::<Connection>(),
            )
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let first = client
            .get(format!("http://{address}/stream"))
            .send()
            .await
            .unwrap();
        let port = first.headers()["peer-port"].clone();
        assert!(first.text().await.unwrap().contains("heartbeat"));
        let next = client
            .get(format!("http://{address}/next"))
            .send()
            .await
            .unwrap();
        assert_eq!(
            next.headers()["peer-port"],
            port,
            "the original TCP connection must be reused"
        );
        assert_eq!(next.text().await.unwrap(), "reused");
        drop(client);
        let _ = stop.send(());
        tokio::time::timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn android_links_isolate_staging_and_retain_production_default() {
        assert_eq!(
            android_link_target(None).unwrap(),
            ("com.bluegrain.smsrelay", "smsrelay")
        );
        assert_eq!(
            android_link_target(Some("com.bluegrain.smsrelay.staging")).unwrap(),
            ("com.bluegrain.smsrelay.staging", "smsrelay-staging")
        );
        for invalid in [
            "",
            "com.bluegrain.smsrelay.other",
            "com.bluegrain.smsrelay\n",
            "<script>",
        ] {
            assert!(android_link_target(Some(invalid)).is_err());
        }
    }
    #[test]
    fn signing_fingerprints_preserve_order_and_reject_partial_configuration() {
        let a = ["AA"; 32].join(":");
        let b = ["BB"; 32].join(":");
        assert_eq!(
            signing_fingerprints(Some(&a), Some(&json!([b, a.to_lowercase()]))).unwrap(),
            vec![b, a.clone()]
        );
        for invalid in [json!(null), json!("invalid"), json!([a, "bad"])] {
            assert!(matches!(
                signing_fingerprints(Some(&a), Some(&invalid)),
                Err(Error::Api(503, "app_links_not_configured"))
            ));
        }
        assert!(signing_fingerprints(None, None).is_err());
    }
}
