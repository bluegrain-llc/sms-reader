use crate::{
    error::{Error, Result},
    model::{num, text},
    relay::Relay,
    store::{Query, decode_document},
    telemetry::category,
};
use firestore::{
    FirestoreValue,
    gcloud_sdk::google::firestore::v1::{Document, Value as NativeValue, value::ValueType},
};
use futures::FutureExt;
use std::{future::Future, panic::AssertUnwindSafe};

fn document_reference(name: String) -> FirestoreValue {
    FirestoreValue::from(NativeValue {
        value_type: Some(ValueType::ReferenceValue(name)),
    })
}

impl Relay {
    /// Each cursor is an advisory scan position; item handlers own correctness.
    pub async fn maintenance_page<F, Fut>(
        &self,
        name: &str,
        query: Query,
        field: Option<&str>,
        size: u32,
        concurrency: usize,
        handle: F,
    ) -> Result<usize>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        self.maintenance_scan(name, query, field, size, |docs| async move {
            for chunk in docs.chunks(concurrency.max(1)) {
                let results = futures::future::join_all(chunk.iter().map(|doc| {
                    let id = doc.name.rsplit('/').next().unwrap().to_owned();
                    let handle = &handle;
                    AssertUnwindSafe(async move { handle(id).await }).catch_unwind()
                }))
                .await;
                for result in results {
                    let failure = match result {
                        Ok(Ok(())) => None,
                        Ok(Err(error)) => Some(category(&error)),
                        Err(_) => Some("internal"),
                    };
                    if let Some(category) = failure {
                        self.delivery.emit("maintenance_failed", category).await;
                    }
                }
            }
            Ok(())
        })
        .await
    }

    async fn maintenance_scan<F, Fut>(
        &self,
        name: &str,
        mut query: Query,
        field: Option<&str>,
        size: u32,
        handle: F,
    ) -> Result<usize>
    where
        F: FnOnce(Vec<Document>) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let state = self.store.get_document("maintenancePages", name).await?;
        let state_value = state.as_ref().map(decode_document).transpose()?;
        let version = state_value.as_ref().map(|v| num(v, "version")).unwrap_or(0);
        // A document-ID tiebreaker makes equal due times deterministic.
        query.order.clear();
        query.cursor = None;
        if let Some(field) = field {
            query = query.order(field, false);
        }
        query = query.order("__name__", false).limit(size);
        let cursor_id = state_value
            .as_ref()
            .map(|v| text(v, "id"))
            .filter(|id| !id.is_empty());
        let mut start = query.clone();
        if let Some(id) = cursor_id {
            let mut values = Vec::new();
            if let Some(_field) = field {
                let value = state
                    .as_ref()
                    .and_then(|doc| doc.fields.get("value"))
                    .ok_or(Error::External)?;
                values.push(FirestoreValue::from(value.clone()));
            }
            let db = self.store.native_db().await?;
            values.push(document_reference(format!(
                "{}/{}/{id}",
                db.get_documents_path(),
                query.col
            )));
            start = start.start_after(values);
        }
        let mut page = self.store.query_documents(start).await?;
        if page.is_empty() && cursor_id.is_some() {
            page = self.store.query_documents(query).await?;
        }
        let count = page.len();
        let last = page.last().cloned();
        handle(page).await?;
        let name = name.to_owned();
        let field = field.map(str::to_owned);
        self.store
            .tx(move |tx| {
                let (name, last, field) = (name.clone(), last.clone(), field.clone());
                Box::pin(async move {
                    let live = tx.get("maintenancePages", &name).await?;
                    if num(&live, "version") == version {
                        tx.set_cursor(&name, version + 1, last.as_ref(), field.as_deref())?;
                    }
                    Ok(())
                })
            })
            .await?;
        Ok(count)
    }

    pub async fn maintenance_purge(&self, collection: &str, now: i64) -> Result<usize> {
        self.maintenance_scan(
            &format!("purge-{collection}"),
            Query::new(collection).cmp("purgeAt", "<=", now),
            Some("purgeAt"),
            400,
            |docs| async move {
                if docs.is_empty() {
                    return Ok(());
                }
                if self
                    .store
                    .delete_documents_if_unchanged(&docs)
                    .await
                    .is_err()
                {
                    // Renewal or an oversized batch must not block healthy records.
                    for chunk in docs.chunks(8) {
                        let results = futures::future::join_all(chunk.iter().map(|doc| {
                            self.store
                                .delete_documents_if_unchanged(std::slice::from_ref(doc))
                        }))
                        .await;
                        for result in results {
                            if let Err(error) = result {
                                self.delivery
                                    .emit("maintenance_failed", category(&error))
                                    .await;
                            }
                        }
                    }
                }
                Ok(())
            },
        )
        .await
    }
}
