use sms_code_relay::{
    google::Google,
    http::{Options, app},
    model,
    newtransport::{Connection, DeadlineListener, connection_info},
    relay::Relay,
    security::RecoveryGate,
    store::Store,
};
use std::{sync::Arc, time::Duration};
#[derive(Debug)]
struct StartupFailure {
    phase: &'static str,
    category: &'static str,
}
impl StartupFailure {
    fn internal(phase: &'static str) -> Self {
        Self {
            phase,
            category: "internal",
        }
    }
}
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!(
            "{}",
            serde_json::json!({"event":"startup_failed","component":"relay","severity":"ERROR","phase":error.phase,"category":error.category})
        );
        std::process::exit(1);
    }
}
async fn run() -> Result<(), StartupFailure> {
    let project = std::env::var("GOOGLE_CLOUD_PROJECT")
        .map_err(|_| StartupFailure::internal("GOOGLE_CLOUD_PROJECT"))?;
    if std::env::var_os("K_SERVICE").is_some()
        && (std::env::var_os("FIRESTORE_EMULATOR_HOST").is_some()
            || std::env::var_os("FIREBASE_AUTH_EMULATOR_HOST").is_some())
    {
        return Err(StartupFailure::internal(
            "emulators_not_allowed_on_cloud_run",
        ));
    }
    let google = Arc::new(Google::new(project.clone()));
    if let Some(bucket) = google
        .security_bucket
        .as_deref()
        .filter(|bucket| !bucket.is_empty())
    {
        sms_code_relay::security::validate_bucket(bucket)
            .map_err(|_| StartupFailure::internal("SECURITY_LEDGER_BUCKET"))?;
    }
    let store = Store::new(&project).await.map_err(|error| StartupFailure {
        phase: "firestore_initialization",
        category: sms_code_relay::telemetry::category(&error),
    })?;
    let gate = RecoveryGate::start(store.clone(), google.clone());
    let relay = Relay {
        store,
        clock: Arc::new(model::now),
        delivery: google.clone(),
    };
    let router = app(
        relay,
        Options {
            project_id: Some(project.clone()),
            serving: Some(gate.clone()),
            auth: google,
            public_url: std::env::var("SERVICE_URL").ok(),
            apple_app_ids: std::env::var("APPLE_APP_IDS")
                .unwrap_or_default()
                .split(',')
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .collect(),
            android_cert: std::env::var("ANDROID_SIGNING_SHA256").ok(),
            android_certs: json_option("ANDROID_SIGNING_SHA256S")?,
            android_package: std::env::var("ANDROID_PACKAGE_NAME").ok(),
            firebase_web_config: json_option("FIREBASE_WEB_CONFIG")?,
            privacy_contact: std::env::var("PRIVACY_CONTACT").ok(),
            origins: std::env::var("ALLOWED_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            trust_proxy_hops: 1,
            sse_duration: Duration::from_secs(100),
        },
    );
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse::<u16>()
        .map_err(|_| StartupFailure::internal("PORT"))?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|_| StartupFailure::internal("http_bind"))?;
    println!("sms_relay_listening");
    axum::serve(
        DeadlineListener(listener),
        router
            .layer(axum::middleware::from_fn(connection_info))
            .into_make_service_with_connect_info::<Connection>(),
    )
    .with_graceful_shutdown(async move {
        shutdown().await;
        gate.close();
    })
    .await
    .map_err(|_| StartupFailure::internal("http_serve"))?;
    Ok(())
}
fn json_option(name: &'static str) -> Result<Option<serde_json::Value>, StartupFailure> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| serde_json::from_str(&value).map_err(|_| StartupFailure::internal(name)))
        .transpose()
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal handler");
        tokio::select! {_=sigterm.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
