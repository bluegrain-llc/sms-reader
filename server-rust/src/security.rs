use crate::{
    error::{Error, Result, ensure},
    google::Google,
    model::{now, text},
    store::Store,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinHandle;
use uuid::Uuid;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub fn validate_bucket(bucket: &str) -> Result<()> {
    ensure(
        regex::Regex::new(r"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$")
            .unwrap()
            .is_match(bucket),
        500,
        "invalid_recovery_bucket",
    )
}

fn safe_integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|value| {
        value.is_finite() && value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER
    })
}

fn manifest(value: &Value, project: &str) -> Result<()> {
    ensure(
        value.as_object().is_some_and(|value| {
            value.len() == 3
                && ["version", "project", "createdAt"]
                    .iter()
                    .all(|key| value.contains_key(*key))
        }) && value["version"].as_f64() == Some(1.0)
            && value["project"].is_string()
            && safe_integer(&value["createdAt"]),
        503,
        "invalid_security_ledger_manifest",
    )?;
    ensure(value["project"] == project, 503, "ledger_project_mismatch")
}

fn bucket_policy(value: &Value) -> Result<()> {
    let retention = &value["retentionPolicy"];
    let period = retention["retentionPeriod"]
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .or_else(|| retention["retentionPeriod"].as_f64());
    ensure(
        retention["isLocked"] == true && period.is_some_and(|period| period >= (7 * 86400) as f64),
        503,
        "ledger_retention_not_locked",
    )?;
    ensure(
        value["iamConfiguration"]["uniformBucketLevelAccess"]["enabled"] == true
            && value["iamConfiguration"]["publicAccessPrevention"] == "enforced",
        503,
        "ledger_access_policy_unsafe",
    )
}

fn intent(mut action: Value, at: i64) -> Result<Value> {
    let object = action
        .as_object_mut()
        .ok_or(Error::Api(400, "invalid_input"))?;
    object.insert("version".into(), json!(1));
    object.insert("id".into(), json!(Uuid::new_v4().to_string()));
    object.insert("at".into(), json!(at));
    let valid = object.keys().all(|key| {
        [
            "version", "id", "at", "ownerId", "kind", "target", "grantId",
        ]
        .contains(&key.as_str())
    }) && ["ownerId", "target"].iter().all(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| (1..=128).contains(&crate::js_string::count(value)))
    }) && [
        "account.delete",
        "grant.revoke",
        "forms.deny",
        "device.pause",
        "device.delete",
        "webhook.delete",
    ]
    .contains(&text(&action, "kind"))
        && action.get("grantId").is_none_or(|value| {
            value
                .as_str()
                .is_some_and(|value| crate::js_string::count(value) <= 128)
        })
        && at >= 0
        && safe_integer(&action["at"]);
    ensure(valid, 400, "invalid_input")?;
    Ok(action)
}

fn object_url(bucket: &str, name: Option<&str>, upload: bool) -> url::Url {
    let mut url = url::Url::parse(if upload {
        "https://storage.googleapis.com/upload/storage/v1/b/"
    } else {
        "https://storage.googleapis.com/storage/v1/b/"
    })
    .unwrap();
    {
        let mut path = url.path_segments_mut().unwrap();
        path.pop_if_empty().push(bucket);
        if name.is_some() || upload {
            path.push("o");
        }
        if !upload && let Some(name) = name {
            path.push(name);
        }
    }
    if upload {
        url.query_pairs_mut()
            .append_pair("uploadType", "media")
            .append_pair("name", name.expect("upload object name"))
            .append_pair("ifGenerationMatch", "0");
    } else if name.is_some() {
        url.query_pairs_mut().append_pair("alt", "media");
    }
    url
}

fn transport_error(error: reqwest::Error) -> Error {
    Error::Provider(if error.is_timeout() {
        "timeout"
    } else {
        "unavailable"
    })
}

async fn request(google: &Google, url: url::Url, data: Option<&Value>) -> Result<Value> {
    let access = tokio::time::timeout(Duration::from_secs(10), google.access())
        .await
        .map_err(|_| Error::Provider("timeout"))??;
    let mut request = if data.is_some() {
        google.client.post(url)
    } else {
        google.client.get(url)
    };
    request = request.timeout(Duration::from_secs(10)).bearer_auth(access);
    if let Some(data) = data {
        request = request
            .header("Content-Type", "application/json")
            .body(crate::model::js_json(data, false));
    }
    let response = request.send().await.map_err(transport_error)?;
    if !response.status().is_success() {
        return Err(Error::Provider(match response.status().as_u16() {
            429 => "quota",
            502 | 503 => "unavailable",
            504 => "timeout",
            _ => "internal",
        }));
    }
    response.json().await.map_err(transport_error)
}

/// Validate independent immutable storage before acknowledging a denial in Firestore.
pub async fn record(google: &Google, action: Value) -> Result<()> {
    let bucket = google
        .security_bucket
        .as_deref()
        .filter(|bucket| !bucket.is_empty())
        .ok_or(Error::Api(503, "security_ledger_not_configured"))?;
    validate_bucket(bucket)?;
    ensure(
        !google.project.is_empty(),
        503,
        "security_ledger_project_missing",
    )?;
    let marker = request(
        google,
        object_url(bucket, Some("manifest.json"), false),
        None,
    )
    .await?;
    manifest(&marker, &google.project)?;
    let info = request(google, object_url(bucket, None, false), None).await?;
    bucket_policy(&info)?;
    let at = now();
    let intent = intent(action, at)?;
    let name = format!("intents/{at:016}-{}.json", text(&intent, "id"));
    let response = request(google, object_url(bucket, Some(&name), true), Some(&intent)).await?;
    ensure(
        response["generation"]
            .as_str()
            .is_some_and(|generation| !generation.is_empty()),
        503,
        "recovery_write_unconfirmed",
    )
}

/// A single control-document watch gates each process without per-request reads.
pub struct RecoveryGate {
    blocked: AtomicBool,
    closed: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl RecoveryGate {
    fn waiting() -> Self {
        Self {
            blocked: AtomicBool::new(true),
            closed: AtomicBool::new(false),
            task: Mutex::new(None),
        }
    }
    pub fn start(store: Store, google: Arc<Google>) -> Arc<Self> {
        let gate = Arc::new(Self::waiting());
        let weak = Arc::downgrade(&gate);
        let task = tokio::spawn(async move {
            let result = Self::observe_control(weak.clone(), store, google).await;
            if result.is_err() {
                if let Some(gate) = weak.upgrade() {
                    gate.blocked.store(true, Ordering::SeqCst);
                }
                use std::io::Write;
                let _ = writeln!(std::io::stderr(), "recovery_gate_unavailable");
            }
        });
        *gate.task.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
        gate
    }
    async fn observe_control(gate: Weak<Self>, store: Store, google: Arc<Google>) -> Result<()> {
        let mut backoff = Duration::from_millis(100);
        let watch = loop {
            if gate
                .upgrade()
                .is_none_or(|gate| gate.closed.load(Ordering::SeqCst))
            {
                return Ok(());
            }
            let setup = tokio::time::timeout(Duration::from_secs(30), async {
                tokio::time::timeout(Duration::from_secs(10), google.access())
                    .await
                    .map_err(|_| Error::Provider("timeout"))??;
                // Ignore preflight data: only CURRENT from the subsequent watch opens serving.
                store.get("recoveryControl", "state").await?;
                store.watch_document("recoveryControl", "state").await
            })
            .await
            .unwrap_or(Err(Error::Provider("timeout")));
            match setup {
                Ok(watch) => break watch,
                Err(_) => {
                    if let Some(gate) = gate.upgrade() {
                        gate.blocked.store(true, Ordering::SeqCst);
                    }
                    eprintln!("recovery_gate_unavailable retry=true");
                    tokio::time::sleep(backoff).await;
                    backoff = backoff.saturating_mul(2).min(Duration::from_secs(30));
                }
            }
        };
        Self::observe_watch(gate, watch).await
    }
    async fn observe_watch(
        gate: Weak<Self>,
        mut watch: crate::event_streams::WatchHandle,
    ) -> Result<()> {
        loop {
            let snapshot = watch.updates.borrow().clone();
            let Some(active_gate) = gate.upgrade() else {
                return Ok(());
            };
            active_gate.observe(
                snapshot.current,
                snapshot.failed,
                snapshot
                    .docs
                    .first()
                    .is_some_and(|doc| doc["blocked"] == true),
            );
            if active_gate.closed.load(Ordering::SeqCst) {
                return Ok(());
            }
            if snapshot.failed {
                return Err(Error::Api(503, "recovery_watch_unavailable"));
            }
            drop(active_gate);
            if watch.updates.changed().await.is_err() {
                if let Some(gate) = gate.upgrade() {
                    gate.blocked.store(true, Ordering::SeqCst);
                }
                return Err(Error::Api(503, "recovery_watch_unavailable"));
            }
        }
    }
    fn observe(&self, current: bool, failed: bool, blocked: bool) {
        if !self.closed.load(Ordering::SeqCst) {
            self.blocked
                .store(failed || !current || blocked, Ordering::SeqCst);
        }
    }
    pub fn assert_open(&self) -> Result<()> {
        ensure(
            !self.closed.load(Ordering::SeqCst) && !self.blocked.load(Ordering::SeqCst),
            503,
            "recovery_in_progress",
        )
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.blocked.store(true, Ordering::SeqCst);
        if let Some(task) = self
            .task
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            task.abort();
        }
    }
}
impl crate::http::Serving for RecoveryGate {
    fn assert_serving(&self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.assert_open() })
    }
}
impl Drop for RecoveryGate {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn recovery_gate_runs_real_watch_reconnects_and_only_reopens_at_current() {
        use crate::event_streams::{ListenStream, watch_with_connector};
        use firestore::gcloud_sdk::{
            google::firestore::v1::{ListenResponse, TargetChange},
            tonic::Status,
        };
        use firestore::{FirestoreListenEvent, FirestoreListenerTargetChangeType};
        let (attempts, mut connections) = tokio::sync::mpsc::unbounded_channel();
        let watch = watch_with_connector(
            move || {
                let attempts = attempts.clone();
                Box::pin(async move {
                    let (writer, reader) = tokio::sync::mpsc::unbounded_channel();
                    attempts.send(writer).unwrap();
                    Ok(
                        Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(reader))
                            as ListenStream,
                    )
                })
            },
            1,
            Duration::from_millis(1),
        );
        let gate = Arc::new(RecoveryGate::waiting());
        let weak = Arc::downgrade(&gate);
        let observer = tokio::spawn(async move { RecoveryGate::observe_watch(weak, watch).await });
        let current = || {
            Ok(ListenResponse {
                response_type: Some(FirestoreListenEvent::TargetChange(TargetChange {
                    target_change_type: FirestoreListenerTargetChangeType::Current as i32,
                    ..Default::default()
                })),
            })
        };
        let first = tokio::time::timeout(Duration::from_secs(1), connections.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(gate.assert_open().is_err());
        first.send(current()).unwrap();
        wait_gate(&gate, true).await;
        first.send(Err(Status::unavailable("transient"))).unwrap();
        wait_gate(&gate, false).await;
        let second = tokio::time::timeout(Duration::from_secs(1), connections.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(gate.assert_open().is_err());
        // NO_CHANGE without CURRENT cannot reopen a fresh transport.
        second
            .send(Ok(ListenResponse {
                response_type: Some(FirestoreListenEvent::TargetChange(TargetChange {
                    target_change_type: FirestoreListenerTargetChangeType::NoChange as i32,
                    ..Default::default()
                })),
            }))
            .unwrap();
        assert!(gate.assert_open().is_err());
        second.send(current()).unwrap();
        wait_gate(&gate, true).await;
        second
            .send(Err(Status::permission_denied("permanent")))
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), observer)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(gate.assert_open().is_err());
        assert!(
            tokio::time::timeout(Duration::from_secs(1), connections.recv())
                .await
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn recovery_gate_close_cancels_transport_and_pending_reconnect() {
        use crate::event_streams::{ListenStream, watch_with_connector};
        use firestore::gcloud_sdk::tonic::Status;
        for during_backoff in [false, true] {
            let (attempts, mut connections) = tokio::sync::mpsc::unbounded_channel();
            let watch = watch_with_connector(
                move || {
                    let attempts = attempts.clone();
                    Box::pin(async move {
                        let (writer, reader) = tokio::sync::mpsc::unbounded_channel();
                        attempts.send(writer).unwrap();
                        Ok(
                            Box::pin(tokio_stream::wrappers::UnboundedReceiverStream::new(reader))
                                as ListenStream,
                        )
                    })
                },
                1,
                Duration::from_secs(30),
            );
            let gate = Arc::new(RecoveryGate::waiting());
            let weak = Arc::downgrade(&gate);
            let task = tokio::spawn(async move {
                let _ = RecoveryGate::observe_watch(weak, watch).await;
            });
            *gate.task.lock().unwrap() = Some(task);
            let writer = tokio::time::timeout(Duration::from_secs(1), connections.recv())
                .await
                .unwrap()
                .unwrap();
            if during_backoff {
                writer.send(Err(Status::unavailable("transient"))).unwrap();
                tokio::time::timeout(Duration::from_secs(1), writer.closed())
                    .await
                    .unwrap();
            }
            gate.close();
            tokio::time::timeout(Duration::from_secs(1), writer.closed())
                .await
                .unwrap();
            assert!(gate.assert_open().is_err());
            assert!(
                tokio::time::timeout(Duration::from_secs(1), connections.recv())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
    }
    async fn wait_gate(gate: &RecoveryGate, open: bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while gate.assert_open().is_ok() != open {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[test]
    fn ledger_rejects_cross_project_extra_fields_and_unsafe_bucket_policies() {
        let marker = json!({"version":1,"project":"demo-sms-relay","createdAt":0});
        manifest(&marker, "demo-sms-relay").unwrap();
        assert!(manifest(&marker, "other-project").is_err());
        for bad in [
            json!({"version":1,"project":"demo-sms-relay","createdAt":0,"extra":true}),
            json!({"version":1,"project":"demo-sms-relay","createdAt":0.5}),
        ] {
            assert!(manifest(&bad, "demo-sms-relay").is_err());
        }
        let policy = json!({"retentionPolicy":{"isLocked":true,"retentionPeriod":"604800"},"iamConfiguration":{"uniformBucketLevelAccess":{"enabled":true},"publicAccessPrevention":"enforced"}});
        bucket_policy(&policy).unwrap();
        for (path, bad) in [
            ("/retentionPolicy/isLocked", json!(false)),
            ("/retentionPolicy/retentionPeriod", json!("604799")),
            (
                "/iamConfiguration/uniformBucketLevelAccess/enabled",
                json!(false),
            ),
            (
                "/iamConfiguration/publicAccessPrevention",
                json!("inherited"),
            ),
        ] {
            let mut unsafe_policy = policy.clone();
            *unsafe_policy.pointer_mut(path).unwrap() = bad;
            assert!(bucket_policy(&unsafe_policy).is_err());
        }
    }
    #[test]
    fn denial_intents_enforce_scope_lengths_and_create_only_object_names() {
        let action = json!({"ownerId":"owner","kind":"grant.revoke","target":"grant"});
        let event = intent(action.clone(), 0).unwrap();
        assert!(Uuid::parse_str(text(&event, "id")).is_ok());
        assert!(intent(action.clone(), -1).is_err());
        for (key, bad) in [
            ("ownerId", json!("")),
            ("target", json!("x".repeat(129))),
            ("kind", json!("account.restore")),
            ("extra", json!(true)),
        ] {
            let mut invalid = action.clone();
            invalid[key] = bad;
            assert!(intent(invalid, 0).is_err());
        }
        let url = object_url(
            "demo-ledger",
            Some("intents/0000000000000000-id.json"),
            true,
        );
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(query["ifGenerationMatch"], "0");
        assert_eq!(query["name"], "intents/0000000000000000-id.json");
        assert!(
            object_url("demo-ledger", Some("manifest.json"), false)
                .as_str()
                .contains("/o/manifest.json?alt=media")
        );
    }
    #[test]
    fn recovery_gate_requires_current_watch_and_cannot_reopen_after_close() {
        let gate = RecoveryGate::waiting();
        assert!(gate.assert_open().is_err());
        gate.observe(false, false, false);
        assert!(gate.assert_open().is_err());
        gate.observe(true, false, false);
        gate.assert_open().unwrap();
        gate.observe(true, false, true);
        assert!(gate.assert_open().is_err());
        gate.observe(true, false, false);
        gate.assert_open().unwrap();
        gate.observe(true, true, false);
        assert!(gate.assert_open().is_err());
        gate.close();
        gate.observe(true, false, false);
        assert!(gate.assert_open().is_err());
    }
}
