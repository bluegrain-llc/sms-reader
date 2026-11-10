use crate::{
    error::{Error, Result, ensure},
    model::{js_json, now, text},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde_json::Value;
use sha2::Sha256;
use std::{
    net::{IpAddr, SocketAddr},
    str::FromStr,
    sync::OnceLock,
    time::Duration,
};
pub fn hook_secret() -> String {
    let mut b = [0; 32];
    rand::rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}
pub fn public_address(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    };
    static BLOCKED: OnceLock<Vec<ipnet::IpNet>> = OnceLock::new();
    !BLOCKED
        .get_or_init(|| {
            serde_json::from_str::<Vec<String>>(include_str!("../compat/non-unicast.json"))
                .unwrap()
                .iter()
                .map(|s| ipnet::IpNet::from_str(s).unwrap())
                .collect()
        })
        .iter()
        .any(|n| n.contains(&ip))
}
pub async fn destination(raw: &str) -> Result<(url::Url, SocketAddr)> {
    let url = url::Url::parse(&crate::js_string::utf8(raw))
        .map_err(|_| Error::Api(400, "invalid_webhook_url"))?;
    ensure(
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none_or(str::is_empty)
            && url.port_or_known_default() == Some(443),
        400,
        "invalid_webhook_url",
    )?;
    let host = url
        .host_str()
        .ok_or(Error::Api(400, "invalid_webhook_url"))?
        .trim_matches(['[', ']']);
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, 443)]
    } else {
        tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host, 443)))
            .await
            .map_err(|_| Error::Api(500, "webhook_dns_timeout"))?
            .map_err(|_| Error::External)?
            .collect::<Vec<_>>()
    };
    ensure(
        !addresses.is_empty() && addresses.iter().all(|a| public_address(a.ip())),
        400,
        "private_webhook_destination",
    )?;
    Ok((url, addresses[0]))
}
pub fn signature(secret: &str, timestamp: &str, body: &str) -> String {
    let mut h = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    h.update(format!("{timestamp}.{body}").as_bytes());
    format!("{:x}", h.finalize().into_bytes())
}
pub async fn send(raw: &str, secret: &str, event: &Value) -> Result<()> {
    let (url, address) = destination(raw).await?;
    let hostname = url.host_str().unwrap().to_owned();
    let body = js_json(event, false);
    let timestamp = (now() / 1000).to_string();
    let client = reqwest::Client::builder()
        .tls_backend_rustls()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .resolve(hostname.trim_matches(['[', ']']), address)
        .build()
        .map_err(|_| Error::External)?;
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Relay-Event-ID", text(event, "id"))
        .header("Relay-Timestamp", &timestamp)
        .header(
            "Relay-Signature",
            format!("v1={}", signature(secret, &timestamp, &body)),
        )
        .body(body)
        .send()
        .await
        .map_err(request_error)?;
    response_status(response.status())
}
fn request_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::Api(500, "webhook_timeout")
    } else {
        Error::External
    }
}
fn response_status(status: reqwest::StatusCode) -> Result<()> {
    ensure(status.is_success(), 500, "webhook_rejected")
}

#[cfg(test)]
mod error_tests {
    use super::*;
    #[tokio::test]
    async fn delivery_categories_distinguish_rejection_and_transport_timeout() {
        for status in [301, 400, 429, 500] {
            let error =
                response_status(reqwest::StatusCode::from_u16(status).unwrap()).unwrap_err();
            assert_eq!(crate::telemetry::category(&error), "rejected");
        }
        assert!(response_status(reqwest::StatusCode::NO_CONTENT).is_ok());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            futures::future::pending::<()>().await;
        });
        let error = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(30))
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap_err();
        server.abort();
        assert_eq!(crate::telemetry::category(&request_error(error)), "timeout");
        assert_eq!(
            crate::telemetry::category(&Error::Api(500, "webhook_dns_timeout")),
            "timeout"
        );
    }
}
