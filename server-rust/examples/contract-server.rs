//! Emulator-only test host. This target is never copied into the runtime image.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use axum::{
    body::Body,
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::Response,
};
use futures::StreamExt;
use serde_json::{Value, json};
use sms_code_relay::{
    error::{Error, Result},
    event_streams::{EventStreams, FeedSubscription},
    google::Identity,
    http::{self, Authentication, Options},
    model::*,
    relay::{Auth, Delivery, Relay},
    store::Store,
};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, watch};
#[derive(Clone)]
struct Callback {
    url: String,
    client: reqwest::Client,
}
impl Callback {
    async fn send(&self, kind: &str, args: Value) -> Result<Value> {
        let response = self
            .client
            .post(&self.url)
            .json(&json!({"kind":kind,"args":args}))
            .send()
            .await
            .map_err(|_| Error::External)?;
        if !response.status().is_success() {
            let failure = response.json::<Value>().await.unwrap_or(Value::Null);
            return Err(if failure["error"] == "auth/user-not-found" {
                Error::Api(404, "auth/user-not-found")
            } else {
                Error::External
            });
        }
        response.json().await.map_err(|_| Error::External)
    }
}
impl Delivery for Callback {
    fn security(&self, action: Value) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.send("security", json!([action])).await?;
            Ok(())
        })
    }
    fn record(&self, event: Value) -> futures::future::BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.send("telemetry", json!([event])).await;
        })
    }

    fn emit<'a>(&'a self, event: &'a str, category: &'a str) -> futures::future::BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = self
                .send(
                    "telemetry",
                    json!([{ "event": event, "category": category }]),
                )
                .await;
        })
    }
    fn notify<'a>(
        &'a self,
        t: &'a str,
        id: &'a str,
        ttl: i64,
        form: bool,
    ) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.send(
                "notify",
                json!([
                    sms_code_relay::js_string::utf8(t),
                    id,
                    ttl,
                    if form { json!("form") } else { Value::Null }
                ]),
            )
            .await?;
            Ok(())
        })
    }
    fn wake(&self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.send("wake", json!([])).await?;
            Ok(())
        })
    }
    fn webhook<'a>(
        &'a self,
        u: &'a str,
        s: &'a str,
        e: &'a Value,
    ) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.send("webhook", json!([sms_code_relay::js_string::utf8(u), s, e]))
                .await?;
            Ok(())
        })
    }
}
impl http::Serving for Callback {
    fn assert_serving(&self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.send("serving", json!([]))
                .await
                .map_err(|_| Error::Api(503, "recovery_in_progress"))?;
            Ok(())
        })
    }
}
impl Authentication for Callback {
    fn owner<'a>(&'a self, t: &'a str) -> futures::future::BoxFuture<'a, Result<Identity>> {
        Box::pin(async move {
            let v = self.send("owner", json!([t])).await?;
            Ok(Identity {
                uid: text(&v, "uid").into(),
                auth_time: v["authTime"].as_f64().unwrap_or(0.0),
            })
        })
    }
    fn worker<'a>(&'a self, t: &'a str) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.send("worker", json!([t])).await?;
            Ok(())
        })
    }
    fn delete<'a>(&'a self, u: &'a str) -> futures::future::BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.send("delete", json!([u])).await?;
            Ok(())
        })
    }
}
#[derive(Clone)]
struct Host {
    store: Store,
    stops: Arc<Mutex<HashMap<String, TestServer>>>,
    feeds: Arc<Mutex<HashMap<String, EventStreams>>>,
    subscriptions: Arc<Mutex<HashMap<String, FeedSubscription>>>,
}
struct TestServer {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}
async fn cancelled(mut stop: watch::Receiver<bool>) {
    if !*stop.borrow_and_update() {
        let _ = stop.changed().await;
    }
}
async fn shutdown_connections(
    State(stop): State<watch::Receiver<bool>>,
    request: Request,
    next: Next,
) -> Response {
    let response = tokio::select! {
        _ = cancelled(stop.clone()) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
        response = next.run(request) => response,
    };
    let (parts, body) = response.into_parts();
    Response::from_parts(
        parts,
        Body::from_stream(body.into_data_stream().take_until(cancelled(stop))),
    )
}
fn callback(v: &Value) -> Arc<Callback> {
    let url = text(v, "callback").to_owned();
    assert!(url.starts_with("http://127.0.0.1:"));
    Arc::new(Callback {
        url,
        client: reqwest::Client::builder()
            .tls_backend_rustls()
            .timeout(Duration::from_secs(15))
            .no_proxy()
            .build()
            .unwrap(),
    })
}
fn relay(h: &Host, v: &Value) -> Relay {
    let now = num(v, "now");
    Relay {
        store: h.store.clone(),
        clock: Arc::new(move || now),
        delivery: callback(v),
    }
}
fn auth(v: &Value) -> Auth {
    if v.get("secret").is_some() {
        Auth::Agent(text(v, "secret").into())
    } else {
        Auth::Phone {
            uid: text(v, "uid").into(),
            device: text(v, "deviceId").into(),
        }
    }
}
async fn call(State(h): State<Host>, Json(v): Json<Value>) -> impl IntoResponse {
    let r = relay(&h, &v);
    let args = arr(&v, "args");
    let a = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
    let t = |i: usize| a(i).as_str().unwrap_or("").to_owned();
    let result: Result<Value> = async {
        match text(&v, "method") {
            "verifyOwner" => {
                let identity = sms_code_relay::google::Google::new("demo-sms-relay".into())
                    .verify_owner(&t(0))
                    .await?;
                Ok(json!({"uid":identity.uid,"authTime":identity.auth_time}))
            }
            "register" => r.register(t(0), t(1), t(2), t(3), a(4) == 1).await,
            "createGrant" => {
                r.create_grant(t(0), t(1), t(2), a(3).as_i64().unwrap())
                    .await
            }
            "listDevices" => r.list_devices(&t(0)).await,
            "listGrants" => r.list_grants(t(0), a(1).as_str().map(str::to_owned)).await,
            "changeDevice" => {
                r.change_device(
                    t(0),
                    t(1),
                    a(2).as_bool().unwrap(),
                    a(3).as_bool().unwrap_or(false),
                )
                .await?;
                Ok(Value::Null)
            }
            "revoke" => {
                r.revoke(t(0), t(1)).await?;
                Ok(Value::Null)
            }
            "deleteAccount" => {
                r.delete_account(t(0)).await?;
                Ok(Value::Null)
            }
            "deletions.request" => r.deletion_request(t(0)).await,
            "deletions.status" => r.deletion_status(t(0)).await,
            "deletions.migrateLegacy" => {
                r.deletion_migrate_legacy().await?;
                Ok(Value::Null)
            }
            "deletions.step" => Ok(json!(r.deletion_step(t(0), callback(&v)).await?)),
            "deletions.dispatch" => {
                r.deletion_dispatch(callback(&v)).await?;
                Ok(Value::Null)
            }
            "access.read" => {
                r.access_read(t(0), a(1).as_str().map(str::to_owned))
                    .await?;
                Ok(Value::Null)
            }
            "access.stream" => {
                r.access_stream(t(0), t(1), a(2).as_i64().unwrap_or(100_000))
                    .await
            }
            "access.release" => {
                r.access_release(a(0)).await?;
                Ok(Value::Null)
            }
            "access.cleanup" => {
                r.access_cleanup().await?;
                Ok(Value::Null)
            }
            "checkAgent" => {
                r.check_agent(&t(0)).await?;
                Ok(Value::Null)
            }
            "create" => r.create(t(0), a(1)).await,
            "get" => r.get(t(0), t(1)).await,
            "phoneGet" => r.phone_get(t(0), t(1), t(2)).await,
            "transition" => {
                let mut input = json!({"status":a(2),"reason":a(3)});
                for (k, i) in [("code", 4), ("listenerStartedAt", 5), ("source", 6)] {
                    if !a(i).is_null() {
                        input[k] = a(i);
                    }
                }
                r.transition(auth(&a(0)), t(1), input).await
            }
            "history" => r.history(t(0), a(1).as_str().map(str::to_owned)).await,
            "deliver" => {
                r.deliver_sms(t(0)).await?;
                Ok(Value::Null)
            }
            "maintenance" => {
                r.maintenance().await?;
                Ok(Value::Null)
            }
            "maintenance.scan" => {
                let processed = Arc::new(Mutex::new(Vec::<String>::new()));
                let output = processed.clone();
                let poison = Arc::new(a(5).as_array().cloned().unwrap_or_default().into_iter().filter_map(|id|id.as_str().map(str::to_owned)).collect::<std::collections::HashSet<_>>());
                let cursor_override = a(6); let cursor_store=r.store.clone(); let cursor_name=t(0);
                let overwritten=Arc::new(std::sync::atomic::AtomicBool::new(false));
                let count = r.maintenance_page(&t(0),sms_code_relay::store::Query::new(&t(1)),a(2).as_str(),
                    a(3).as_u64().unwrap_or(100) as u32,a(4).as_u64().unwrap_or(1) as usize,
                    move |id| { let (processed,poison,cursor_store,cursor_name,cursor_override,overwritten)=(processed.clone(),poison.clone(),cursor_store.clone(),cursor_name.clone(),cursor_override.clone(),overwritten.clone()); async move {
                        if cursor_override.is_object() && !overwritten.swap(true,std::sync::atomic::Ordering::AcqRel) {
                            cursor_store.tx(move |tx| { let (name,value)=(cursor_name.clone(),cursor_override.clone()); Box::pin(async move { tx.set("maintenancePages",&name,value) }) }).await?;
                        }
                        if poison.contains(&id) { return Err(Error::Api(500,"synthetic_page_failure")); }
                        processed.lock().await.push(id); Ok(())
                    }}).await?;
                let ids=output.lock().await.clone();
                Ok(json!({"count":count,"processed":ids}))
            }
            "maintenance.purge" => Ok(json!(r.maintenance_purge(&t(0),a(1).as_i64().unwrap_or(r.now())).await?)),
            "streamSubscribe" => {
                let key = text(&v,"callback").to_owned();
                let streams = {
                    let mut feeds = h.feeds.lock().await;
                    feeds.entry(key.clone()).or_insert_with(|| {
                        let mut relay = r.clone(); relay.clock = live_clock(key);
                        EventStreams::new(relay)
                    }).clone()
                };
                let subscription = streams.subscribe(t(0)).await?;
                let id = uuid::Uuid::new_v4().to_string();
                h.subscriptions.lock().await.insert(id.clone(),subscription);
                Ok(json!({"subscriptionId":id,"activeFeeds":streams.active_feeds()}))
            }
            "streamSnapshot" => {
                let subscriptions = h.subscriptions.lock().await;
                let subscription = subscriptions.get(&t(0)).ok_or(Error::Api(404,"unknown_subscription"))?;
                let active = h.feeds.lock().await.get(text(&v,"callback")).map(EventStreams::active_feeds).unwrap_or(0);
                Ok(json!({"failed":subscription.failed(),"revision":subscription.revision(),"oldest":subscription.oldest(),"events":subscription.tail(0,r.now()),"activeFeeds":active}))
            }
            "streamStop" => {
                h.subscriptions.lock().await.remove(&t(0));
                let active = h.feeds.lock().await.get(text(&v,"callback")).map(EventStreams::active_feeds).unwrap_or(0);
                Ok(json!({"activeFeeds":active}))
            }
            "telemetryBacklogs" => {
                r.telemetry_backlogs().await?;
                Ok(Value::Null)
            }
            "connections.start" => r.connection_start(t(0), a(1)).await,
            "connections.poll" => r.connection_poll(t(0)).await,
            "connections.owner" => {
                r.connection_owner(t(0), t(1), a(2).as_str().map(str::to_owned))
                    .await
            }
            "forms.approve" => {
                r.approve_forms(t(0), t(1), a(2).as_bool().unwrap()).await?;
                Ok(Value::Null)
            }
            "forms.create" => r.form_create(t(0), a(1)).await,
            "forms.get" => r.form_get(auth(&a(0)), t(1)).await,
            "forms.inbox" => r.inbox(t(0), t(1)).await,
            "forms.cancel" => r.form_cancel(t(0), t(1)).await,
            "forms.observe" => r.observe(t(0), t(1), t(2), a(3)).await,
            "forms.submit" => r.submit(t(0), t(1), t(2), a(3)).await,
            "forms.result" => r.form_result(t(0), t(1)).await,
            "forms.events" => r.events(t(0), a(1).as_str().map(str::to_owned)).await,
            "forms.registerWebhook" => r.register_webhook(t(0), a(1)).await,
            "forms.webhooks" => r.webhooks(t(0), a(1).as_str().map(str::to_owned)).await,
            "forms.deliver" => {
                r.deliver_form(t(0)).await?;
                Ok(Value::Null)
            }
            "forms.dispatch" => {
                r.dispatch().await?;
                Ok(Value::Null)
            }
            "forms.maintenance" => {
                r.form_maintenance().await?;
                Ok(Value::Null)
            }
            _ => Err(Error::Api(400, "unknown_test_method")),
        }
    }
    .await;
    match result {
        Ok(value) => Json(json!({"value":value})).into_response(),
        Err(Error::Api(status, reason)) => {
            Json(json!({"error":reason,"status":status})).into_response()
        }
        Err(e) => {
            eprintln!("test_storage_failed: {e:?}");
            Json(json!({"error":"internal_error","status":500})).into_response()
        }
    }
}
fn live_clock(clock_url: String) -> Arc<dyn Fn() -> i64 + Send + Sync> {
    // Every read observes the live injected clock, including SSE background work.
    // Reuse one blocking client and its connection on a dedicated thread; neither
    // client creation nor its blocking runtime may run on Tokio worker threads.
    let (clock, requests) = std::sync::mpsc::channel::<std::sync::mpsc::SyncSender<i64>>();
    std::thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        for reply in requests {
            let now = client
                .post(&clock_url)
                .json(&json!({"kind":"now","args":[]}))
                .send()
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<i64>()
                .unwrap();
            let _ = reply.send(now);
        }
    });
    Arc::new(move || {
        let (reply, response) = std::sync::mpsc::sync_channel(1);
        clock.send(reply).expect("test clock thread stopped");
        response.recv().expect("test clock request failed")
    })
}
async fn start(State(h): State<Host>, Json(v): Json<Value>) -> Json<Value> {
    let mut r = relay(&h, &v);
    let clock_url = text(&v, "callback").to_owned();
    r.clock = live_clock(clock_url);
    let o = &v["options"];
    let options = Options {
        auth: callback(&v),
        serving: v["hasServing"]
            .as_bool()
            .unwrap_or(false)
            .then(|| callback(&v) as Arc<dyn http::Serving>),
        public_url: o["publicUrl"].as_str().map(str::to_owned),
        android_cert: o["androidCertSha256"].as_str().map(str::to_owned),
        android_certs: o.get("androidCertSha256s").cloned(),
        firebase_web_config: o.get("firebaseWebConfig").cloned(),
        privacy_contact: o["privacyContact"].as_str().map(str::to_owned),
        origins: arr(o, "origins")
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect(),
        trust_proxy_hops: num(o, "trustProxyHops") as usize,
        sse_duration: Duration::from_millis(o["sseDurationMs"].as_u64().unwrap_or(100_000)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = watch::channel(false);
    let shutdown = rx.clone();
    let id = uuid::Uuid::new_v4().to_string();
    let task = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            http::app(r, options)
                .layer(middleware::from_fn_with_state(rx, shutdown_connections))
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(cancelled(shutdown))
        .await;
    });
    h.stops
        .lock()
        .await
        .insert(id.clone(), TestServer { stop: tx, task });
    Json(json!({"id":id,"port":port}))
}
async fn stop(State(h): State<Host>, Json(v): Json<Value>) -> Json<Value> {
    if let Some(mut server) = h.stops.lock().await.remove(text(&v, "id")) {
        let _ = server.stop.send(true);
        if tokio::time::timeout(Duration::from_secs(2), &mut server.task)
            .await
            .is_err()
        {
            server.task.abort();
            let _ = server.task.await;
        }
    }
    Json(json!({"ok":true}))
}
#[tokio::main]
async fn main() {
    assert!(
        std::env::var("FIRESTORE_EMULATOR_HOST").is_ok(),
        "test host requires emulator"
    );
    let store = Store::new("demo-sms-relay").await.unwrap();
    let h = Host {
        store,
        stops: Arc::new(Mutex::new(HashMap::new())),
        feeds: Arc::new(Mutex::new(HashMap::new())),
        subscriptions: Arc::new(Mutex::new(HashMap::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!("{}", listener.local_addr().unwrap().port());
    axum::serve(
        listener,
        Router::new()
            .route("/call", post(call))
            .route("/start", post(start))
            .route("/stop", post(stop))
            .with_state(h),
    )
    .await
    .unwrap();
}
