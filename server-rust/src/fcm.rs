use crate::error::{Error, Result};
use serde_json::{Value, json};
use std::{future::Future, io::Write, time::Duration};
use tokio::time::{Instant, timeout_at};
use uuid::Uuid;

pub(crate) const DEADLINE: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

pub(crate) fn payload(token: &str, id: &str, ttl: i64, form: bool, now: i64) -> Value {
    let mut data = json!({"requestId":id});
    if form {
        data["kind"] = json!("form");
    }
    json!({"message":{"token":crate::js_string::utf8(token),"data":data,
        "android":{"priority":"HIGH","ttl":format!("{}.{:03}s",ttl.max(0)/1000,ttl.max(0)%1000),"collapse_key":id},
        "apns":{"headers":{"apns-push-type":"alert","apns-priority":"10","apns-expiration":((now+ttl)/1000).to_string(),"apns-collapse-id":id},
        "payload":{"aps":{"alert":{"title":"Request Relay","body":"Open Inbox to review a request."},"sound":"default"}}}}})
}

struct Attempt {
    id: Uuid,
    started: Instant,
    form: bool,
    http_attempts: u8,
    completed: bool,
}
impl Attempt {
    fn emit(&self, phase: &str, result: Option<&Result<()>>) {
        let mut event = json!({"event":"fcm_send","phase":phase,"attempt_id":self.id.to_string(),
            "kind":if self.form {"form"} else {"sms"},"http_attempts":self.http_attempts,
            "duration_ms":self.started.elapsed().as_secs_f64()*1000.0});
        if let Some(result) = result {
            event["outcome"] = json!(if result.is_ok() { "accepted" } else { "failed" });
            if let Err(error) = result {
                event["category"] = json!(crate::telemetry::category(error));
            }
        }
        if let Some(event) = crate::telemetry::entry(event) {
            let _ = writeln!(std::io::stdout(), "{event}");
        }
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        // Dropping a handler cancels the request and cooperative auth. Already
        // blocking credential I/O may finish later. Retain a local terminal record.
        if !self.completed {
            self.emit("completed", Some(&Err(Error::Provider("timeout"))));
        }
    }
}

struct CancelAuth(futures::future::AbortHandle);
impl Drop for CancelAuth {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// One HTTP attempt with a shared deadline. Poll auth off the deadline executor:
/// supported credential providers can synchronously wait for gcloud. Cancellation
/// drops cooperative auth; an already-blocked credential operation can finish
/// later, but its task only returns a token and never owns a provider POST.
pub(crate) async fn send(
    client: &reqwest::Client,
    access: impl Future<Output = Result<String>> + Send + 'static,
    url: &str,
    body: Value,
    form: bool,
    duration: Duration,
) -> Result<()> {
    let mut attempt = Attempt {
        id: Uuid::new_v4(),
        started: Instant::now(),
        form,
        http_attempts: 0,
        completed: false,
    };
    let deadline = attempt.started + duration;
    attempt.emit("started", None);
    let (abort, registration) = futures::future::AbortHandle::new_pair();
    let _cancel_auth = CancelAuth(abort);
    let runtime = tokio::runtime::Handle::current();
    let access = tokio::task::spawn_blocking(move || {
        runtime.block_on(futures::future::Abortable::new(access, registration))
    });
    let result = timeout_at(deadline, async {
        let token = access
            .await
            .map_err(|_| Error::External)?
            .map_err(|_| Error::Provider("timeout"))??;
        if Instant::now() >= deadline {
            return Err(Error::Provider("timeout"));
        }
        attempt.http_attempts = 1;
        attempt.emit("http_started", None);
        if Instant::now() >= deadline {
            return Err(Error::Provider("timeout"));
        }
        let mut response = client
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(super::google::provider_transport)?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(super::google::provider_transport)?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(Error::Provider("internal"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if !status.is_success() || value.get("error").is_some() {
            return Err(super::google::provider_response(status.as_u16(), &value));
        }
        if !value["name"].is_string() {
            return Err(Error::Provider("internal"));
        }
        Ok(())
    })
    .await
    .unwrap_or(Err(Error::Provider("timeout")));
    attempt.completed = true;
    attempt.emit("completed", Some(&result));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, Bytes},
        http::{Response, StatusCode},
        response::IntoResponse,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    async fn receiver(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://{address}/fcm"), server)
    }
    fn client() -> reqwest::Client {
        crate::google::Google::new("test-project".into()).client
    }
    async fn token() -> Result<String> {
        Ok("private-test-token".into())
    }
    fn timeout(result: &Result<()>) -> bool {
        matches!(result, Err(Error::Provider("timeout")))
    }

    #[test]
    fn android_apns_and_non_sms_data_preserve_wire_values() {
        let body = payload("token", "request-id", 60_123, true, 1_000_000);
        assert_eq!(
            body,
            json!({"message":{"token":"token","data":{"requestId":"request-id","kind":"form"},
            "android":{"priority":"HIGH","ttl":"60.123s","collapse_key":"request-id"},
            "apns":{"headers":{"apns-push-type":"alert","apns-priority":"10","apns-expiration":"1060","apns-collapse-id":"request-id"},
            "payload":{"aps":{"alert":{"title":"Request Relay","body":"Open Inbox to review a request."},"sound":"default"}}}}})
        );
        assert_eq!(
            payload("token", "id", 0, false, 1000)["message"]["data"],
            json!({"requestId":"id"})
        );
        assert!(DEADLINE < Duration::from_secs(60));
    }
    #[tokio::test]
    async fn retry_after_one_hour_is_not_a_retry_timer() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let router = Router::new().fallback(move || { count.fetch_add(1, Ordering::SeqCst); async {
            (StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "3600")], axum::Json(json!({"error":{"details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNAVAILABLE"}]}})))
        }});
        let (url, server) = receiver(router).await;
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            send(&client(), token(), &url, json!({}), false, DEADLINE),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(Error::Provider("unavailable"))));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
    #[tokio::test]
    async fn late_auth_is_dropped_and_never_starts_a_provider_post() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let auth_completed = Arc::new(AtomicUsize::new(0));
        let completed = auth_completed.clone();
        let router = Router::new().fallback(move || {
            count.fetch_add(1, Ordering::SeqCst);
            async { axum::Json(json!({"name":"accepted"})) }
        });
        let (url, server) = receiver(router).await;
        let access = async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            completed.fetch_add(1, Ordering::SeqCst);
            Ok("late-token".into())
        };
        let result = send(
            &client(),
            access,
            &url,
            json!({}),
            false,
            Duration::from_millis(40),
        )
        .await;
        assert!(timeout(&result));
        tokio::time::sleep(Duration::from_millis(180)).await;
        assert_eq!(auth_completed.load(Ordering::SeqCst), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        server.abort();
    }
    struct Release(Option<std::sync::mpsc::Sender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    struct AuthDropped(Option<tokio::sync::oneshot::Sender<()>>);
    impl Drop for AuthDropped {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    #[tokio::test]
    async fn running_blocking_credentials_cannot_hold_deadline_executor_or_send_late() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (url, server) = receiver(Router::new().fallback(move || {
            count.fetch_add(1, Ordering::SeqCst);
            async { axum::Json(json!({"name":"accepted"})) }
        }))
        .await;
        let completed = Arc::new(AtomicUsize::new(0));
        let auth_completed = completed.clone();
        let (entered, running) = tokio::sync::oneshot::channel();
        let (finished, finished_auth) = tokio::sync::oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let release_on_failure = Release(Some(release));
        let auth = async move {
            let _ = entered.send(());
            // Models gcp_auth's synchronous Command::output() inside an async poll.
            let _ = blocked.recv_timeout(Duration::from_secs(2));
            auth_completed.fetch_add(1, Ordering::SeqCst);
            let _ = finished.send(());
            Ok("late-real-credential-result".into())
        };
        let c = client();
        let pending = send(&c, auth, &url, json!({}), false, Duration::from_millis(40));
        tokio::pin!(pending);
        // Poll once to enqueue auth, then observe actual entry before polling the
        // send deadline again. No assumption that its worker starts within 40 ms.
        assert!(futures::poll!(pending.as_mut()).is_pending());
        let entered = tokio::time::timeout(Duration::from_secs(1), running).await;
        let result = tokio::time::timeout(Duration::from_millis(500), pending.as_mut()).await;
        let completed_before_release = completed.load(Ordering::SeqCst);
        drop(release_on_failure);
        let finished = tokio::time::timeout(Duration::from_secs(1), finished_auth).await;
        server.abort();
        assert!(
            matches!(entered, Ok(Ok(()))),
            "fixture must observe running auth"
        );
        assert!(result.as_ref().is_ok_and(timeout));
        assert_eq!(
            completed_before_release, 0,
            "local timeout settles while running auth is blocked"
        );
        assert!(matches!(finished, Ok(Ok(()))));
        assert_eq!(completed.load(Ordering::SeqCst), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn queued_auth_is_cancelled_without_polling_or_requiring_completion() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let (occupied, running) = tokio::sync::oneshot::channel();
            let (release, blocked) = std::sync::mpsc::channel();
            let release_on_failure = Release(Some(release));
            let blocker = tokio::task::spawn_blocking(move || {
                let _ = occupied.send(());
                let _ = blocked.recv_timeout(Duration::from_secs(2));
            });
            let occupied = tokio::time::timeout(Duration::from_secs(1), running).await;
            let polled = Arc::new(AtomicUsize::new(0));
            let count = polled.clone();
            let (dropped, mut observed_drop) = tokio::sync::oneshot::channel();
            let guard = AuthDropped(Some(dropped));
            let auth = async move {
                let _guard = guard;
                count.fetch_add(1, Ordering::SeqCst);
                Ok("never-polled-token".into())
            };
            let result = tokio::time::timeout(
                Duration::from_millis(500),
                send(
                    &client(),
                    auth,
                    "http://127.0.0.1:1/fcm",
                    json!({}),
                    false,
                    Duration::from_millis(40),
                ),
            )
            .await;
            let before_release = polled.load(Ordering::SeqCst);
            drop(release_on_failure);
            let blocker_finished = tokio::time::timeout(Duration::from_secs(1), blocker).await;
            let dropped = tokio::time::timeout(Duration::from_secs(1), &mut observed_drop).await;
            assert!(matches!(occupied, Ok(Ok(()))));
            assert!(result.as_ref().is_ok_and(timeout));
            assert!(matches!(blocker_finished, Ok(Ok(()))));
            assert!(
                matches!(dropped, Ok(Ok(()))),
                "queued auth must be dropped when worker is released"
            );
            assert_eq!(before_release, 0);
            assert_eq!(
                polled.load(Ordering::SeqCst),
                0,
                "aborted queued auth must never be polled"
            );
        });
    }
    #[tokio::test]
    async fn shared_deadline_rejects_a_valid_response_after_auth_uses_the_budget() {
        let router = Router::new().fallback(|| async {
            tokio::time::sleep(Duration::from_millis(90)).await;
            axum::Json(json!({"name":"accepted-with-a-fresh-http-budget"}))
        });
        let (url, server) = receiver(router).await;
        let access = async {
            tokio::time::sleep(Duration::from_millis(80)).await;
            Ok("token".into())
        };
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            send(
                &client(),
                access,
                &url,
                json!({}),
                false,
                Duration::from_millis(150),
            ),
        )
        .await
        .unwrap();
        assert!(timeout(&result));
        server.abort();
    }
    #[tokio::test]
    async fn hung_response_body_is_in_the_same_deadline() {
        let router = Router::new().fallback(|| async {
            let stream = futures::stream::once(async {
                Ok::<_, std::io::Error>(Bytes::from_static(b"{\"name\":"))
            });
            use futures::StreamExt;
            Response::new(Body::from_stream(stream.chain(futures::stream::pending())))
        });
        let (url, server) = receiver(router).await;
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            send(
                &client(),
                token(),
                &url,
                json!({}),
                false,
                Duration::from_millis(80),
            ),
        )
        .await
        .unwrap();
        assert!(timeout(&result));
        server.abort();
    }
    #[tokio::test]
    async fn cancelled_handler_drops_running_cooperative_auth_without_completion_or_post() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (url, server) = receiver(Router::new().fallback(move || {
            count.fetch_add(1, Ordering::SeqCst);
            async { axum::Json(json!({"name":"accepted"})) }
        }))
        .await;
        let completed = Arc::new(AtomicUsize::new(0));
        let auth_completed = completed.clone();
        let (entered, running) = tokio::sync::oneshot::channel();
        let (release, blocked) = tokio::sync::oneshot::channel();
        let (dropped, mut observed_drop) = tokio::sync::oneshot::channel();
        let guard = AuthDropped(Some(dropped));
        let task = tokio::spawn(async move {
            send(
                &client(),
                async move {
                    let _guard = guard;
                    let _ = entered.send(());
                    let _ = blocked.await;
                    auth_completed.fetch_add(1, Ordering::SeqCst);
                    Ok("token".into())
                },
                &url,
                json!({}),
                false,
                DEADLINE,
            )
            .await
        });
        let entered = tokio::time::timeout(Duration::from_secs(1), running).await;
        task.abort(); // External handler cancellation, far before the ten-second send budget.
        let cancelled = tokio::time::timeout(Duration::from_secs(1), task).await;
        let dropped_before_release =
            tokio::time::timeout(Duration::from_millis(500), &mut observed_drop).await;
        let completed_before_release = completed.load(Ordering::SeqCst);
        let release_result = release.send(());
        // If cancellation regresses, release and settle the detached producer
        // BEFORE asserting failure, so even a failing fixture cannot hang shutdown.
        let cleanup = if dropped_before_release.is_err() {
            Some(tokio::time::timeout(Duration::from_secs(1), &mut observed_drop).await)
        } else {
            None
        };
        server.abort();
        assert!(matches!(entered, Ok(Ok(()))));
        assert!(matches!(cancelled, Ok(Err(error)) if error.is_cancelled()));
        assert!(
            matches!(dropped_before_release, Ok(Ok(()))),
            "external abort must DROP cooperative auth"
        );
        assert!(
            release_result.is_err(),
            "auth receiver must already be dropped"
        );
        assert!(cleanup.is_none_or(|value| matches!(value, Ok(Ok(())))));
        assert_eq!(completed_before_release, 0);
        assert_eq!(completed.load(Ordering::SeqCst), 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn malformed_oversized_and_redirect_responses_are_not_acceptance() {
        for mode in ["malformed", "oversized", "redirect"] {
            let router = Router::new().fallback(move || async move {
                match mode {
                    "oversized" => axum::Json(json!({"name":"x".repeat(MAX_RESPONSE_BYTES + 1)}))
                        .into_response(),
                    "redirect" => (
                        StatusCode::TEMPORARY_REDIRECT,
                        [("location", "/different")],
                        "{}",
                    )
                        .into_response(),
                    _ => axum::Json(json!({})).into_response(),
                }
            });
            let (url, server) = receiver(router).await;
            assert!(
                send(&client(), token(), &url, json!({}), false, DEADLINE)
                    .await
                    .is_err()
            );
            server.abort();
        }
    }
    #[tokio::test]
    async fn accepted_response_and_provider_categories_remain_distinct() {
        for (status, code, category) in [
            (200, "", None),
            (404, "UNREGISTERED", Some("destination")),
            (429, "QUOTA_EXCEEDED", Some("quota")),
            (503, "UNAVAILABLE", Some("unavailable")),
        ] {
            let router = Router::new().fallback(move || async move {
                (StatusCode::from_u16(status).unwrap(), axum::Json(if code.is_empty() { json!({"name":"accepted"}) } else { json!({"error":{"details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":code}]}}) }))
            });
            let (url, server) = receiver(router).await;
            let result = send(&client(), token(), &url, json!({}), false, DEADLINE).await;
            assert_eq!(
                result.as_ref().err().map(crate::telemetry::category),
                category
            );
            server.abort();
        }
    }
}
