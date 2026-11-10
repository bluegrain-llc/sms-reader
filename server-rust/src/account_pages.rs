use crate::http::Options;
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::Value;

fn escape(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            '&' => "&amp;".to_owned(),
            '<' => "&lt;".to_owned(),
            '>' => "&gt;".to_owned(),
            '"' => "&quot;".to_owned(),
            '\'' => "&#39;".to_owned(),
            _ => c.to_string(),
        })
        .collect()
}
const FALLBACK_CONTACT: &str = "Public operator contact and final backup disclosures have not yet been published. This service remains a private pilot until those release requirements are completed.";
pub fn account_page(path: &str, options: &Options) -> Option<Response> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut status = StatusCode::OK;
    let (html, policy) = match path {
        "/privacy" => (
            include_str!("../compat/privacy.html").replace("{{CONTACT}}", &options.privacy_contact.as_deref().filter(|s| !s.is_empty()).map(escape).unwrap_or_else(|| FALLBACK_CONTACT.to_owned())),
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'".to_owned(),
        ),
        "/account/delete" => {
            let config = options.firebase_web_config.as_ref().unwrap_or(&Value::Null);
            let project = config["projectId"].as_str().unwrap_or("");
            let valid = ["apiKey", "appId"].iter().all(|key| config[key].as_str().is_some_and(|s| !s.is_empty()))
                && !project.is_empty() && project.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && config["authDomain"].as_str() == Some(format!("{project}.firebaseapp.com").as_str());
            let html = if valid {
                include_str!("../compat/account-delete.html").replace("{{CONFIG}}", &crate::model::js_json(config, false).replace('<', "\\u003c")).replace("{{NONCE}}", &nonce)
            } else {
                status = StatusCode::SERVICE_UNAVAILABLE;
                include_str!("../compat/account-delete-unavailable.html").to_owned()
            };
            (html, format!("default-src 'none'; script-src 'nonce-{nonce}' https://www.gstatic.com https://apis.google.com; style-src 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.firebaseapp.com; frame-src https://*.firebaseapp.com https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"))
        },
        _ => return None,
    };
    let mut response = (
        status,
        [
            ("Content-Type", "text/html; charset=utf-8"),
            ("Referrer-Policy", "no-referrer"),
            ("X-Frame-Options", "DENY"),
            ("Content-Security-Policy", policy.as_str()),
        ],
        html,
    )
        .into_response();
    if path == "/account/delete" {
        response.headers_mut().insert(
            "Cross-Origin-Opener-Policy",
            "same-origin-allow-popups".parse().unwrap(),
        );
    }
    Some(response)
}
