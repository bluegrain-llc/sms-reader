//! Emulator-only test host. This target is never copied into the runtime image.
use axum::{Json, Router, extract::State, response::IntoResponse, routing::post};
use serde_json::{Value, json};
use sms_code_relay::{
    error::{Error, Result},
    google::Identity,
    http::{self, Authentication, Options},
    model::*,
    relay::{Auth, Delivery, Relay},
    store::Store,
};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, oneshot};
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
            return Err(Error::External);
        }
        response.json().await.map_err(|_| Error::External)
    }
}
impl Delivery for Callback {
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
                json!([t, id, ttl, if form { json!("form") } else { Value::Null }]),
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
            self.send("webhook", json!([u, s, e])).await?;
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
                auth_time: num(&v, "authTime"),
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
    stops: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
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
async fn start(State(h): State<Host>, Json(v): Json<Value>) -> Json<Value> {
    let mut r = relay(&h, &v);
    let clock_url = text(&v, "callback").to_owned();
    // Clock reads must reach the same live injected function as direct calls,
    // including reads made by the SSE task between HTTP requests. Blocking I/O
    // stays on a dedicated thread in this emulator-only target.
    r.clock = Arc::new(move || {
        let url = clock_url.clone();
        std::thread::spawn(move || {
            reqwest::blocking::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap()
                .post(url)
                .json(&json!({"kind":"now","args":[]}))
                .send()
                .unwrap()
                .error_for_status()
                .unwrap()
                .json::<i64>()
                .unwrap()
        })
        .join()
        .unwrap()
    });
    let o = &v["options"];
    let options = Options {
        auth: callback(&v),
        public_url: o["publicUrl"].as_str().map(str::to_owned),
        android_cert: o["androidCertSha256"].as_str().map(str::to_owned),
        origins: arr(o, "origins")
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect(),
        trust_proxy_hops: num(o, "trustProxyHops") as usize,
        sse_duration: Duration::from_millis(o["sseDurationMs"].as_u64().unwrap_or(100_000)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = oneshot::channel();
    let id = uuid::Uuid::new_v4().to_string();
    h.stops.lock().await.insert(id.clone(), tx);
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            http::app(r, options).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = rx.await;
        })
        .await;
    });
    Json(json!({"id":id,"port":port}))
}
async fn stop(State(h): State<Host>, Json(v): Json<Value>) -> Json<Value> {
    if let Some(tx) = h.stops.lock().await.remove(text(&v, "id")) {
        let _ = tx.send(());
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
