use sms_code_relay::{
    google::Google,
    http::{Options, app},
    model,
    relay::Relay,
    store::Store,
};
use std::{sync::Arc, time::Duration};
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!("startup_failed");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let project = std::env::var("GOOGLE_CLOUD_PROJECT")?;
    if std::env::var_os("K_SERVICE").is_some()
        && (std::env::var_os("FIRESTORE_EMULATOR_HOST").is_some()
            || std::env::var_os("FIREBASE_AUTH_EMULATOR_HOST").is_some())
    {
        return Err("emulators_not_allowed_on_cloud_run".into());
    }
    let google = Arc::new(Google::new(project.clone()));
    let store = Store::new(&project).await?;
    let relay = Relay {
        store,
        clock: Arc::new(model::now),
        delivery: google.clone(),
    };
    let router = app(
        relay,
        Options {
            auth: google,
            public_url: std::env::var("SERVICE_URL").ok(),
            android_cert: std::env::var("ANDROID_SIGNING_SHA256").ok(),
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
        .parse::<u16>()?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    println!("sms_relay_listening");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
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
