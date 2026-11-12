use crate::http::Options;
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::Value;
pub fn page(options: &Options) -> Response {
    render(options, include_str!("../../server/public/onboarding.html"))
}
pub fn owned_services(options: &Options) -> Response {
    render(
        options,
        include_str!("../../server/public/owned-services.html"),
    )
}
fn render(options: &Options, document: &str) -> Response {
    let config = options.firebase_web_config.as_ref().unwrap_or(&Value::Null);
    let project = config["projectId"].as_str().unwrap_or("");
    let valid = ["apiKey", "appId"]
        .iter()
        .all(|p| config[p].as_str().is_some_and(|s| !s.is_empty()))
        && !project.is_empty()
        && project
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && config["authDomain"].as_str() == Some(format!("{project}.firebaseapp.com").as_str());
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let serialized = if valid {
        crate::model::js_json(config, false).replace('<', "\\u003c")
    } else {
        "null".into()
    };
    let html = document
        .replace("__NONCE__", &nonce)
        .replace("__CONFIG__", &serialized);
    let policy = format!(
        "default-src 'none'; script-src 'self' 'nonce-{nonce}' https://www.gstatic.com https://apis.google.com; style-src 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.firebaseapp.com; frame-src https://*.firebaseapp.com https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    );
    (
        if valid {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        [
            ("Content-Type", "text/html; charset=utf-8"),
            ("Content-Security-Policy", policy.as_str()),
            ("Referrer-Policy", "no-referrer"),
            ("Cross-Origin-Opener-Policy", "same-origin-allow-popups"),
        ],
        html,
    )
        .into_response()
}
