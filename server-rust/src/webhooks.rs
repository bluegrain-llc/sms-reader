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
    error::Error as _,
    future::Future,
    io,
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
    destination_with_lookup(
        raw,
        |host| async move {
            tokio::net::lookup_host((host.as_str(), 443))
                .await
                .map(|addresses| addresses.collect())
        },
        Duration::from_secs(3),
    )
    .await
}
async fn destination_with_lookup<F, Fut>(
    raw: &str,
    lookup: F,
    deadline: Duration,
) -> Result<(url::Url, SocketAddr)>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = io::Result<Vec<SocketAddr>>>,
{
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
        tokio::time::timeout(deadline, lookup(host.to_owned()))
            .await
            .map_err(|_| Error::Provider("timeout"))?
            .map_err(|error| io_error(&error))?
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
        Error::Provider("timeout")
    } else {
        let mut source = error.source();
        while let Some(cause) = source {
            if let Some(error) = cause.downcast_ref::<io::Error>() {
                return io_error(error);
            }
            source = cause.source();
        }
        Error::External
    }
}
fn io_error(error: &io::Error) -> Error {
    match error.kind() {
        io::ErrorKind::ConnectionRefused | io::ErrorKind::ConnectionReset => {
            Error::Provider("unavailable")
        }
        io::ErrorKind::TimedOut => Error::Provider("timeout"),
        _ => Error::External,
    }
}
fn response_status(status: reqwest::StatusCode) -> Result<()> {
    if status.is_success() {
        Ok(())
    } else {
        Err(Error::Provider("rejected"))
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;
    use axum::{body::to_bytes, response::IntoResponse};
    async fn generic_failure(error: Error, category: &str) {
        assert_eq!(crate::telemetry::category(&error), category);
        // HTTP records request_failed for non-API errors, then uses this mapper.
        assert!(!matches!(error, Error::Api(_, _)));
        let response = error.into_response();
        assert_eq!(response.status(), 500);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            serde_json::json!({"error":"internal_error"})
        );
    }
    #[tokio::test]
    async fn delivery_categories_distinguish_rejection_and_transport_timeout() {
        for status in [301, 400, 429, 500] {
            let error =
                response_status(reqwest::StatusCode::from_u16(status).unwrap()).unwrap_err();
            generic_failure(error, "rejected").await;
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
        generic_failure(request_error(error), "timeout").await;
    }
    #[tokio::test]
    async fn dns_checks_every_address_and_keeps_timeout_private() {
        let raw = "https://receiver.example/callback";
        let deadline = Duration::from_millis(20);
        let error = destination_with_lookup(raw, |_| futures::future::pending(), deadline)
            .await
            .unwrap_err();
        generic_failure(error, "timeout").await;
        for addresses in [
            vec![],
            vec!["8.8.8.8:443", "127.0.0.1:443"],
            vec!["[::ffff:127.0.0.1]:443"],
        ] {
            let addresses = addresses
                .into_iter()
                .map(|address| address.parse().unwrap())
                .collect();
            let error = destination_with_lookup(raw, |_| async { Ok(addresses) }, deadline)
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                Error::Api(400, "private_webhook_destination")
            ));
        }
        let (url, address) = destination_with_lookup(
            raw,
            |host| async move {
                assert_eq!(host, "receiver.example");
                Ok(vec![
                    "8.8.8.8:443".parse().unwrap(),
                    "[2606:4700:4700::1111]:443".parse().unwrap(),
                ])
            },
            deadline,
        )
        .await
        .unwrap();
        assert_eq!(url.host_str(), Some("receiver.example"));
        assert_eq!(address, "8.8.8.8:443".parse::<SocketAddr>().unwrap());
    }
    #[tokio::test]
    async fn refused_transport_is_unavailable_without_exposing_the_destination() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap_err();
        generic_failure(request_error(error), "unavailable").await;
        generic_failure(
            io_error(&io::Error::from(io::ErrorKind::ConnectionReset)),
            "unavailable",
        )
        .await;
        generic_failure(
            io_error(&io::Error::from(io::ErrorKind::NotFound)),
            "internal",
        )
        .await;
    }
}
