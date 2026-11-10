use crate::{
    error::{Result, ensure},
    model::{MINUTE, hash_js, num, text},
    relay::Relay,
    store::Query,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

fn active_leases(document: &Value, now: i64) -> Map<String, Value> {
    document["leases"]
        .as_object()
        .into_iter()
        .flat_map(|leases| leases.iter())
        .filter(|(_, until)| until.as_f64().is_some_and(|until| until > now as f64))
        .map(|(id, until)| (id.clone(), until.clone()))
        .collect()
}

impl Relay {
    /// Shared counters enforce the same budgets across independent instances.
    pub async fn access_read(&self, uid: String, grant: Option<String>) -> Result<()> {
        let relay = self.clone();
        self.store
            .tx(move |tx| {
                let (relay, uid, grant) = (relay.clone(), uid.clone(), grant.clone());
                Box::pin(async move {
                    let window = relay.now().div_euclid(MINUTE);
                    let mut scopes = vec![(format!("owner:{uid}"), 600)];
                    if let Some(grant) = grant.filter(|grant| !grant.is_empty()) {
                        scopes.push((format!("grant:{grant}"), 120));
                    }
                    let mut counters = Vec::with_capacity(scopes.len());
                    for (scope, limit) in scopes {
                        let id = hash_js(&format!("{scope}:{window}"));
                        let count = num(&tx.get("accessRates", &id).await?, "count");
                        ensure(count < limit, 429, "poll_rate_limited")?;
                        counters.push((id, count));
                    }
                    for (id, count) in counters {
                        tx.set(
                            "accessRates",
                            &id,
                            json!({"count":count + 1, "purgeAt":(window + 2) * MINUTE}),
                        )?;
                    }
                    Ok(())
                })
            })
            .await
    }

    /// The committed deadline includes time spent awaiting the transaction commit.
    pub async fn access_stream(
        &self,
        uid: String,
        grant: String,
        lifetime_ms: i64,
    ) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        let scopes = [
            hash_js(&format!("owner:{uid}")),
            hash_js(&format!("grant:{grant}")),
        ];
        let relay = self.clone();
        self.store
            .tx(move |tx| {
                let (relay, id, scopes) = (relay.clone(), id.clone(), scopes.clone());
                Box::pin(async move {
                    let documents = [
                        tx.get("streamLimits", &scopes[0]).await?,
                        tx.get("streamLimits", &scopes[1]).await?,
                    ];
                    let expires_at = relay.now() + lifetime_ms.min(100_000) + 10_000;
                    let mut leases =
                        documents.map(|document| active_leases(&document, relay.now()));
                    ensure(
                        leases[0].len() < 4 && leases[1].len() < 2,
                        429,
                        "stream_limit_reached",
                    )?;
                    for (scope, leases) in scopes.iter().zip(leases.iter_mut()) {
                        let purge_at = leases
                            .values()
                            .filter_map(Value::as_i64)
                            .max()
                            .unwrap_or(expires_at)
                            .max(expires_at)
                            + MINUTE;
                        leases.insert(id.clone(), json!(expires_at));
                        tx.set(
                            "streamLimits",
                            scope,
                            json!({"leases":leases, "purgeAt":purge_at}),
                        )?;
                    }
                    Ok(json!({"id":id,"deadline":expires_at - 10_000,"scopes":scopes}))
                })
            })
            .await
    }

    /// Removing a lease repeatedly preserves every other stream's admission.
    pub async fn access_release(&self, lease: Value) -> Result<()> {
        self.store
            .tx(move |tx| {
                let lease = lease.clone();
                Box::pin(async move {
                    let scopes = lease["scopes"]
                        .as_array()
                        .expect("internal stream admission");
                    let mut documents = Vec::with_capacity(scopes.len());
                    for scope in scopes {
                        let scope = scope.as_str().expect("internal stream scope");
                        documents.push((scope, tx.get("streamLimits", scope).await?));
                    }
                    for (scope, document) in documents {
                        if document.is_null() {
                            continue;
                        }
                        let mut leases =
                            document["leases"].as_object().cloned().unwrap_or_default();
                        leases.remove(text(&lease, "id"));
                        tx.merge("streamLimits", scope, json!({"leases":leases}))?;
                    }
                    Ok(())
                })
            })
            .await
    }

    pub async fn access_cleanup(&self) -> Result<()> {
        for collection in ["accessRates", "streamLimits"] {
            let documents = self
                .store
                .query(
                    Query::new(collection)
                        .cmp("purgeAt", "<=", self.now())
                        .limit(400),
                )
                .await?;
            for document in documents {
                let relay = self.clone();
                self.store
                    .tx(move |tx| {
                        let (relay, document) = (relay.clone(), document.clone());
                        Box::pin(async move {
                            let id = text(&document, "__id");
                            let current = tx.get(collection, id).await?;
                            if !current.is_null() && num(&current, "purgeAt") <= relay.now() {
                                tx.delete(collection, id)?;
                            }
                            Ok(())
                        })
                    })
                    .await?;
            }
        }
        Ok(())
    }
}
