use crate::{
    error::{Error, Result, ensure},
    http::Authentication,
    model::{DAY, HISTORY, MINUTE, flag, hash, num, secret, text},
    relay::Relay,
    store::Query,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const OWNED_COLLECTIONS: [&str; 13] = [
    "devices",
    "grants",
    "managers",
    "managerCallers",
    "connections",
    "connectionCodes",
    "requests",
    "results",
    "audit",
    "formRequests",
    "formResults",
    "requestEvents",
    "deliveryOutbox",
];

fn initial_job(uid: &str, legacy_at: &Value, now: i64) -> Value {
    let accepted_at = legacy_at
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|v| v.min(now as f64))
        .unwrap_or(now as f64);
    json!({
        "ownerId":uid,"status":"pending","createdAt":accepted_at,"updatedAt":now,
        "nextAt":now,"backlogAt":accepted_at,"lease":null,"leaseUntil":0,
        "collectionIndex":0,"batchSize":100,"attempts":0,"purgeAt":null,
    })
}

impl Relay {
    /// A legacy attempt predates the durable worker. Adopt it before queue work.
    pub async fn deletion_migrate_legacy(&self) -> Result<()> {
        self.maintenance_page(
            "legacy-deletion",
            Query::new("deletionAttempts").cmp("nextAt", "<=", self.now()),
            Some("nextAt"),
            8,
            8,
            |id| self.deletion_adopt(id),
        )
        .await?;
        Ok(())
    }

    async fn deletion_adopt(&self, id: String) -> Result<()> {
        let attempt = self.store.get("deletionAttempts", &id).await?;
        if attempt.is_null() {
            return Ok(());
        }
        let uid = text(&attempt, "ownerId").to_owned();
        ensure(
            !uid.is_empty() && hash(&uid) == id,
            500,
            "invalid_legacy_deletion",
        )?;
        // A stalled independent ledger must not hold unrelated accepted work.
        tokio::time::timeout(
            Duration::from_secs(5),
            self.delivery
                .security(json!({"ownerId":uid,"kind":"account.delete","target":uid})),
        )
        .await
        .map_err(|_| Error::Provider("timeout"))??;
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, id, uid) = (s.clone(), id.clone(), uid.clone());
                Box::pin(async move {
                    let current = tx.get("deletionAttempts", &id).await?;
                    if current.is_null() {
                        return Ok(());
                    }
                    ensure(
                        text(&current, "ownerId") == uid,
                        500,
                        "invalid_legacy_deletion",
                    )?;
                    let owner = tx.get("accounts", &uid).await?;
                    let existing = tx.get("deletionJobs", &id).await?;
                    if !flag(&owner, "deletionTelemetryComplete") {
                        let adopted = initial_job(&uid, &current["nextAt"], s.now());
                        if existing.is_null() {
                            tx.create("deletionJobs", &id, adopted)?;
                        } else if text(&existing, "status") != "completed" {
                            tx.merge("deletionJobs",&id,json!({
                            "createdAt":num(&existing,"createdAt").min(num(&adopted,"createdAt")),
                            "backlogAt":num(&existing,"backlogAt").min(num(&adopted,"backlogAt")),
                        }))?;
                        }
                    }
                    tx.set("accounts", &uid, json!({"deleting":true}))?;
                    tx.delete("deletionAttempts", &id)
                })
            })
            .await
    }

    /// Commit the tombstone and status-only credential before acknowledgement.
    pub async fn deletion_request(&self, uid: String) -> Result<Value> {
        self.delivery
            .security(json!({"ownerId":uid,"kind":"account.delete","target":uid}))
            .await?;
        let receipt = secret().replacen("smsr_", "smsd_", 1);
        let receipt_id = hash(&receipt);
        let job_id = hash(&uid);
        let expires_at = self.now() + DAY;
        let s = self.clone();
        let status = self
            .store
            .tx(move |tx| {
                let (s, uid, job_id, receipt_id) =
                    (s.clone(), uid.clone(), job_id.clone(), receipt_id.clone());
                Box::pin(async move {
                    let previous = tx.get("deletionJobs", &job_id).await?;
                    let legacy = tx.get("deletionAttempts", &job_id).await?;
                    let adopted = initial_job(&uid, &legacy["nextAt"], s.now());
                    tx.set("accounts", &uid, json!({"deleting":true}))?;
                    if previous.is_null() {
                        tx.create("deletionJobs", &job_id, adopted)?;
                    } else if !legacy.is_null() && text(&previous, "status") != "completed" {
                        tx.merge(
                            "deletionJobs",
                            &job_id,
                            json!({
                                "createdAt":num(&previous,"createdAt").min(num(&adopted,"createdAt")),
                                "backlogAt":num(&previous,"backlogAt").min(num(&adopted,"backlogAt")),
                            }),
                        )?;
                    }
                    tx.delete("deletionAttempts", &job_id)?;
                    tx.create(
                        "deletionReceipts",
                        &receipt_id,
                        json!({"jobId":job_id,"expiresAt":expires_at,"purgeAt":expires_at}),
                    )?;
                    Ok(previous["status"].as_str().unwrap_or("pending").to_owned())
                })
            })
            .await?;
        self.deletion_wake().await;
        Ok(json!({"ok":true,"status":status,"receipt":receipt,"receiptExpiresAt":expires_at}))
    }

    pub async fn deletion_status(&self, receipt: String) -> Result<Value> {
        ensure(
            receipt.len() == 48
                && receipt.starts_with("smsd_")
                && receipt[5..]
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
            401,
            "invalid_deletion_receipt",
        )?;
        let receipt_id = hash(&receipt);
        let record = self.store.get("deletionReceipts", &receipt_id).await?;
        ensure(
            !record.is_null() && num(&record, "expiresAt") > self.now(),
            401,
            "invalid_deletion_receipt",
        )?;
        let job = self
            .store
            .get("deletionJobs", text(&record, "jobId"))
            .await?;
        ensure(!job.is_null(), 404, "deletion_not_found")?;
        self.access_read(
            text(&job, "ownerId").to_owned(),
            Some(format!("deletion:{receipt_id}")),
        )
        .await?;
        Ok(json!({"status":job["status"]}))
    }

    pub async fn deletion_step(&self, id: String, auth: Arc<dyn Authentication>) -> Result<bool> {
        let lease = Uuid::new_v4().to_string();
        let s = self.clone();
        let (job_id, claim_lease) = (id.clone(), lease.clone());
        let job = self
            .store
            .tx(move |tx| {
                let (s, id, lease) = (s.clone(), job_id.clone(), claim_lease.clone());
                Box::pin(async move {
                    let mut job = tx.get("deletionJobs", &id).await?;
                    if job.is_null()
                        || text(&job, "status") == "completed"
                        || num(&job, "nextAt") > s.now()
                        || num(&job, "leaseUntil") > s.now()
                    {
                        return Ok(Value::Null);
                    }
                    job["status"] = json!("running");
                    job["lease"] = json!(lease);
                    job["leaseUntil"] = json!(s.now() + MINUTE);
                    job["nextAt"] = json!(s.now() + MINUTE);
                    job["updatedAt"] = json!(s.now());
                    job["attempts"] = json!(num(&job, "attempts") + 1);
                    tx.set("deletionJobs", &id, job.clone())?;
                    Ok(job)
                })
            })
            .await?;
        if job.is_null() {
            return Ok(false);
        }
        let batch_size = job["batchSize"].as_i64().unwrap_or(100).clamp(1, 100);
        let collection_index = num(&job, "collectionIndex");
        let collection = usize::try_from(collection_index)
            .ok()
            .and_then(|index| OWNED_COLLECTIONS.get(index).copied());
        let s = self.clone();
        let (step_id, step_lease) = (id.clone(), lease.clone());
        let result: Result<()> = async {
            if let Some(collection) = collection {
                self.store
                    .tx(move |tx| {
                        let (s, id, lease, job) =
                            (s.clone(), step_id.clone(), step_lease.clone(), job.clone());
                        Box::pin(async move {
                            let current = tx.get("deletionJobs", &id).await?;
                            if text(&current, "lease") != lease
                                || num(&current, "leaseUntil") <= s.now()
                            {
                                return Ok(());
                            }
                            let page = tx
                                .query(
                                    Query::new(collection)
                                        .eq("ownerId", text(&job, "ownerId"))
                                        .limit(batch_size as u32),
                                )
                                .await?;
                            for doc in &page {
                                tx.delete(collection, text(doc, "__id"))?;
                            }
                            tx.merge(
                                "deletionJobs",
                                &id,
                                json!({
                                    "collectionIndex":collection_index+i64::from(page.len() < batch_size as usize),
                                    "status":"pending","lease":null,"leaseUntil":0,
                                    "nextAt":s.now(),"updatedAt":s.now(),
                                }),
                            )
                        })
                    })
                    .await?;
            } else {
                match auth.delete(&crate::js_string::utf8(text(&job, "ownerId"))).await {
                    Ok(()) | Err(Error::Api(_, "auth/user-not-found")) => {}
                    Err(error) => return Err(error),
                }
                self.store
                    .tx(move |tx| {
                        let (s, id, lease) = (s.clone(), step_id.clone(), step_lease.clone());
                        Box::pin(async move {
                            let current = tx.get("deletionJobs", &id).await?;
                            if text(&current, "lease") != lease {
                                return Ok(());
                            }
                            tx.merge(
                                "deletionJobs",
                                &id,
                                json!({
                                    "status":"completed","lease":null,"leaseUntil":0,
                                    "updatedAt":s.now(),"nextAt":MAX_SAFE_INTEGER,
                                    "backlogAt":MAX_SAFE_INTEGER,"purgeAt":s.now()+HISTORY,
                                }),
                            )
                        })
                    })
                    .await?;
            }
            Ok(())
        }
        .await;
        if result.is_ok() {
            return Ok(true);
        }
        if let Err(error) = result {
            self.delivery
                .emit("deletion_failed", crate::telemetry::category(&error))
                .await;
        }
        let reduced = if collection.is_some() {
            (batch_size / 2).max(1)
        } else {
            batch_size
        };
        let s = self.clone();
        self.store
            .tx(move |tx| {
                let (s, id, lease) = (s.clone(), id.clone(), lease.clone());
                Box::pin(async move {
                    if text(&tx.get("deletionJobs", &id).await?, "lease") == lease {
                        tx.merge(
                            "deletionJobs",
                            &id,
                            json!({
                                "status":"pending","lease":null,"leaseUntil":0,"batchSize":reduced,
                                "nextAt":s.now()+if reduced < batch_size {0} else {MINUTE},
                                "updatedAt":s.now(),
                            }),
                        )?;
                    }
                    Ok(())
                })
            })
            .await?;
        Ok(false)
    }

    pub async fn deletion_dispatch(&self, auth: Arc<dyn Authentication>) -> Result<()> {
        self.deletion_migrate_legacy().await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
        for _ in 0..40 {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            let jobs = self
                .store
                .query(
                    Query::new("deletionJobs")
                        .cmp("nextAt", "<=", self.now())
                        .order("nextAt", false)
                        .limit(10),
                )
                .await?;
            if jobs.is_empty() {
                break;
            }
            for result in futures::future::join_all(
                jobs.iter()
                    .map(|job| self.deletion_step(text(job, "__id").to_owned(), auth.clone())),
            )
            .await
            {
                result?;
            }
        }
        let remaining = self
            .store
            .query(
                Query::new("deletionJobs")
                    .cmp("nextAt", "<=", self.now())
                    .limit(1),
            )
            .await?;
        if !remaining.is_empty() {
            self.deletion_wake().await;
        }
        for name in ["deletionReceipts", "deletionJobs"] {
            let expired = self
                .store
                .query(Query::new(name).cmp("purgeAt", "<=", self.now()).limit(100))
                .await?;
            if expired.is_empty() {
                continue;
            }
            self.store
                .tx(move |tx| {
                    let expired = expired.clone();
                    Box::pin(async move {
                        for doc in expired {
                            tx.delete(name, text(&doc, "__id"))?;
                        }
                        Ok(())
                    })
                })
                .await?;
        }
        Ok(())
    }

    async fn deletion_wake(&self) {
        if let Err(error) = self.delivery.wake().await {
            self.delivery
                .emit("wakeup_failed", crate::telemetry::category(&error))
                .await;
        }
    }
}
