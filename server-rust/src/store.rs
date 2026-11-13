use crate::error::{Error, Result};
use firestore::*;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::OnceCell;
#[derive(Default)]
enum PurgeAt {
    #[default]
    Missing,
    Null,
    Timestamp(FirestoreInstant),
}
impl<'de> Deserialize<'de> for PurgeAt {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        firestore::serialize_as_optional_timestamp::deserialize(deserializer)
            .map(|value| value.map(Self::Timestamp).unwrap_or(Self::Null))
    }
}
#[derive(Deserialize)]
struct Document {
    #[serde(flatten)]
    fields: serde_json::Map<String, Value>,
    #[serde(rename = "purgeAt", default)]
    purge_at: PurgeAt,
}
// The crate omits serde `None` by default, including JSON nulls. Preserve the
// explicit nulls used by JavaScript clients, recursively through maps and arrays.
struct ExplicitNulls<'a>(&'a Value);
impl Serialize for ExplicitNulls<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self.0 {
            Value::Number(n) => {
                if let Some(n) = n.as_i64() {
                    serializer.serialize_i64(n)
                } else if let Some(n) = n.as_u64() {
                    serializer.serialize_u64(n)
                } else if let Some(n) = n.as_f64() {
                    serializer.serialize_f64(n)
                } else {
                    Err(serde::ser::Error::custom("invalid_number"))
                }
            }
            Value::String(s) => serializer.serialize_str(
                &crate::js_string::storage(s)
                    .map_err(|_| serde::ser::Error::custom("invalid_utf16"))?,
            ),
            Value::Null => firestore::serialize_as_null::serialize(&None::<Value>, serializer),
            Value::Array(values) => {
                use serde::ser::SerializeSeq;
                let mut seq = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    seq.serialize_element(&ExplicitNulls(value))?;
                }
                seq.end()
            }
            Value::Object(values) => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    let key = crate::js_string::storage(key)
                        .map_err(|_| serde::ser::Error::custom("invalid_utf16"))?;
                    map.serialize_entry(&key, &ExplicitNulls(value))?;
                }
                map.end()
            }
            value => value.serialize(serializer),
        }
    }
}
struct TimestampValue(FirestoreInstant);
impl Serialize for TimestampValue {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        firestore::serialize_as_timestamp::serialize(&self.0, serializer)
    }
}
impl Serialize for Document {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(
            self.fields.len() + usize::from(!matches!(self.purge_at, PurgeAt::Missing)),
        ))?;
        for (key, value) in &self.fields {
            let key = crate::js_string::storage(key)
                .map_err(|_| serde::ser::Error::custom("invalid_utf16"))?;
            map.serialize_entry(&key, &ExplicitNulls(value))?;
        }
        match self.purge_at {
            PurgeAt::Timestamp(timestamp) => {
                map.serialize_entry("purgeAt", &TimestampValue(timestamp))?
            }
            PurgeAt::Null => map.serialize_entry("purgeAt", &ExplicitNulls(&Value::Null))?,
            PurgeAt::Missing => {}
        }
        map.end()
    }
}
impl Document {
    fn from_value(mut v: Value) -> Self {
        let purge_at = match v.as_object_mut().unwrap().remove("purgeAt") {
            Some(Value::Null) => PurgeAt::Null,
            Some(value) => value
                .as_i64()
                .and_then(|n| FirestoreInstant::from_millisecond(n).ok())
                .map(PurgeAt::Timestamp)
                .unwrap_or_default(),
            None => PurgeAt::Missing,
        };
        Self {
            fields: v.as_object().unwrap().clone(),
            purge_at,
        }
    }
    fn value(self) -> Value {
        let mut v = Value::Object(self.fields);
        for key in [
            "_firestore_id",
            "_firestore_full_id",
            "_firestore_created",
            "_firestore_updated",
        ] {
            v.as_object_mut().unwrap().remove(key);
        }
        match self.purge_at {
            PurgeAt::Timestamp(t) => v["purgeAt"] = json!(t.as_millisecond()),
            PurgeAt::Null => v["purgeAt"] = Value::Null,
            PurgeAt::Missing => {}
        }
        crate::js_string::encode_value(&mut v);
        v
    }
}
#[derive(Clone)]
pub struct Store {
    project: String,
    db: Arc<OnceCell<FirestoreDb>>,
}
pub struct Tx {
    db: FirestoreDb,
    writes: FirestoreTransactionData,
}
#[derive(Clone)]
pub struct Query {
    pub col: String,
    pub filters: Vec<(String, &'static str, Value)>,
    pub order: Vec<(String, bool)>,
    pub cursor: Option<FirestoreQueryCursor>,
    pub limit: Option<u32>,
}
impl Query {
    pub fn new(c: &str) -> Self {
        Self {
            col: c.into(),
            filters: vec![],
            order: vec![],
            cursor: None,
            limit: None,
        }
    }
    pub fn eq(mut self, k: &str, v: impl Into<Value>) -> Self {
        self.filters.push((k.into(), "==", v.into()));
        self
    }
    pub fn cmp(mut self, k: &str, op: &'static str, v: impl Into<Value>) -> Self {
        self.filters.push((k.into(), op, v.into()));
        self
    }
    pub fn order(mut self, k: &str, desc: bool) -> Self {
        self.order.push((k.into(), desc));
        self
    }
    pub fn start_after(mut self, values: Vec<FirestoreValue>) -> Self {
        self.cursor = Some(FirestoreQueryCursor::AfterValue(values));
        self
    }
    pub fn limit(mut self, n: u32) -> Self {
        self.limit = Some(n);
        self
    }
}
pub(crate) fn query_params(q: &Query) -> FirestoreQueryParams {
    let mut params = FirestoreQueryParams::new(q.col.as_str().into());
    params.limit = q.limit;
    params.start_at = q.cursor.clone();
    if !q.filters.is_empty() {
        let filters = q
            .filters
            .clone()
            .into_iter()
            .map(|(k, op, v)| {
                let mut fields =
                    FirestoreDb::serialize_to_doc("", &Document::from_value(json!({k.clone():v})))
                        .expect("query value is serializable")
                        .fields;
                let fv = FirestoreValue::from(fields.remove(&k).unwrap());
                FirestoreQueryFilter::Compare(Some(match op {
                    "==" => FirestoreQueryFilterCompare::Equal(k, fv),
                    "<=" => FirestoreQueryFilterCompare::LessThanOrEqual(k, fv),
                    ">" => FirestoreQueryFilterCompare::GreaterThan(k, fv),
                    _ => unreachable!(),
                }))
            })
            .collect();
        params.filter = Some(FirestoreQueryFilter::Composite(
            FirestoreQueryFilterComposite::new(filters, FirestoreQueryFilterCompositeOperator::And),
        ));
    }
    if !q.order.is_empty() {
        params.order_by = Some(
            q.order
                .clone()
                .into_iter()
                .map(|(k, d)| {
                    FirestoreQueryOrder::new(
                        k,
                        if d {
                            FirestoreQueryDirection::Descending
                        } else {
                            FirestoreQueryDirection::Ascending
                        },
                    )
                })
                .collect(),
        );
    }
    params
}
pub(crate) fn decode_document(
    d: &firestore::gcloud_sdk::google::firestore::v1::Document,
) -> Result<Value> {
    let mut v = FirestoreDb::deserialize_doc_to::<Document>(d)?.value();
    v["__id"] = json!(crate::js_string::encode(d.name.rsplit('/').next().unwrap()));
    Ok(v)
}
async fn query_documents(
    db: &FirestoreDb,
    q: Query,
) -> Result<Vec<firestore::gcloud_sdk::google::firestore::v1::Document>> {
    let params = query_params(&q);
    let mut query = db
        .fluent()
        .select()
        .from(q.col.as_str())
        .filter(|_| params.filter.clone());
    if let Some(cursor) = params.start_at {
        query = query.start_at(cursor);
    }
    if let Some(limit) = params.limit {
        query = query.limit(limit);
    }
    if let Some(order) = params.order_by {
        query = query.order(|_| order.clone());
    }
    Ok(query.query().await?)
}
async fn query(db: &FirestoreDb, q: Query) -> Result<Vec<Value>> {
    query_documents(db, q)
        .await?
        .iter()
        .map(decode_document)
        .collect()
}
async fn get(db: &FirestoreDb, c: &str, id: &str) -> Result<Value> {
    Ok(db
        .fluent()
        .select()
        .by_id_in(c)
        .obj::<Document>()
        .one(&crate::js_string::utf8(id))
        .await?
        .map(Document::value)
        .unwrap_or(Value::Null))
}
fn conditional_delete_writes(
    docs: &[firestore::gcloud_sdk::google::firestore::v1::Document],
) -> Result<Vec<firestore::gcloud_sdk::google::firestore::v1::Write>> {
    use firestore::gcloud_sdk::google::firestore::v1::{Precondition, Write, precondition, write};
    docs.iter()
        .map(|doc| {
            let update = doc.update_time.ok_or(Error::External)?;
            Ok(Write {
                operation: Some(write::Operation::Delete(doc.name.clone())),
                current_document: Some(Precondition {
                    condition_type: Some(precondition::ConditionType::UpdateTime(update)),
                }),
                ..Default::default()
            })
        })
        .collect::<Result<Vec<_>>>()
}
impl Store {
    pub async fn new(project: &str) -> Result<Self> {
        Ok(Self {
            project: project.into(),
            db: Arc::new(OnceCell::new()),
        })
    }
    async fn db(&self) -> Result<&FirestoreDb> {
        self.db
            .get_or_try_init(|| async {
                FirestoreDb::new(&self.project).await.map_err(Error::from)
            })
            .await
    }
    pub(crate) async fn native_db(&self) -> Result<&FirestoreDb> {
        self.db().await
    }
    pub(crate) async fn get_document(
        &self,
        c: &str,
        id: &str,
    ) -> Result<Option<firestore::gcloud_sdk::google::firestore::v1::Document>> {
        Ok(self
            .db()
            .await?
            .fluent()
            .select()
            .by_id_in(c)
            .one(&crate::js_string::utf8(id))
            .await?)
    }
    pub(crate) async fn query_documents(
        &self,
        q: Query,
    ) -> Result<Vec<firestore::gcloud_sdk::google::firestore::v1::Document>> {
        query_documents(self.db().await?, q).await
    }
    pub(crate) async fn delete_documents_if_unchanged(
        &self,
        docs: &[firestore::gcloud_sdk::google::firestore::v1::Document],
    ) -> Result<()> {
        use firestore::gcloud_sdk::google::firestore::v1::CommitRequest;
        let db = self.db().await?;
        let writes = conditional_delete_writes(docs)?;
        let request = CommitRequest {
            database: db.get_database_path().clone(),
            writes,
            ..Default::default()
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            db.client().get().commit(request),
        )
        .await
        .map_err(|_| Error::Provider("timeout"))?
        .map_err(firestore::errors::FirestoreError::from)?;
        Ok(())
    }
    pub async fn get(&self, c: &str, id: &str) -> Result<Value> {
        get(self.db().await?, c, id).await
    }
    pub async fn query(&self, q: Query) -> Result<Vec<Value>> {
        query(self.db().await?, q).await
    }
    pub async fn count(&self, q: Query) -> Result<i64> {
        #[derive(Deserialize)]
        struct Count {
            count: i64,
        }
        let params = query_params(&q);
        let db = self.db().await?;
        let mut query = db
            .fluent()
            .select()
            .from(q.col.as_str())
            .filter(|_| params.filter.clone());
        if let Some(cursor) = params.start_at {
            query = query.start_at(cursor);
        }
        if let Some(limit) = params.limit {
            query = query.limit(limit);
        }
        if let Some(order) = params.order_by {
            query = query.order(|_| order.clone());
        }
        let results: Vec<Count> = query
            .aggregate(|a| a.fields([a.field("count").count()]))
            .obj()
            .query()
            .await?;
        Ok(results.first().map(|r| r.count).unwrap_or(0))
    }
    pub async fn tx<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'a> Fn(&'a mut Tx) -> BoxFuture<'a, Result<T>>,
    {
        let db = self.db().await?;
        let mut previous = None;
        for attempt in 0..5 {
            let options = FirestoreTransactionOptions {
                mode: previous
                    .clone()
                    .map(FirestoreTransactionMode::ReadWriteRetry)
                    .unwrap_or(FirestoreTransactionMode::ReadWrite),
                ..Default::default()
            };
            let native = match db.begin_transaction_with_options(options).await {
                Ok(native) => native,
                Err(e) if retry(&e) && attempt < 4 => {
                    tokio::time::sleep(retry_delay(attempt)).await;
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            previous = Some(native.transaction_id().clone());
            let read_db = db.clone_with_consistency_selector(
                FirestoreConsistencySelector::Transaction(native.transaction_id().clone()),
            );
            let mut tx = Tx {
                db: read_db,
                writes: native.into_data(),
            };
            let result = f(&mut tx).await;
            let rollback_data = tx.writes.clone();
            let native = FirestoreTransaction::from_data(db, tx.writes);
            match result {
                Ok(value) => match native.commit().await {
                    Ok(_) => return Ok(value),
                    Err(e) if retry(&e) && attempt < 4 => {
                        let _ = FirestoreTransaction::from_data(db, rollback_data)
                            .rollback()
                            .await;
                    }
                    Err(e) => return Err(e.into()),
                },
                Err(e) => {
                    let _ = native.rollback().await;
                    if !matches!(&e,Error::Store(s) if retry(s)&&attempt<4) {
                        return Err(e);
                    }
                }
            }
            tokio::time::sleep(retry_delay(attempt)).await;
        }
        unreachable!()
    }
}
fn retry_delay(attempt: u32) -> std::time::Duration {
    // Competing transactions otherwise repeat their reads and lock upgrades in
    // step, exhausting all attempts even after the original locks are released.
    let base = 100 * (1u64 << attempt);
    std::time::Duration::from_millis(rand::random_range(base..=2 * base))
}
fn retry(e: &firestore::errors::FirestoreError) -> bool {
    matches!(e,firestore::errors::FirestoreError::DatabaseError(d) if d.retry_possible)
}
struct NativeWrite(firestore::gcloud_sdk::google::firestore::v1::Write);
impl TryInto<firestore::gcloud_sdk::google::firestore::v1::Write> for NativeWrite {
    type Error = firestore::errors::FirestoreError;
    fn try_into(
        self,
    ) -> std::result::Result<firestore::gcloud_sdk::google::firestore::v1::Write, Self::Error> {
        Ok(self.0)
    }
}
impl Tx {
    pub(crate) fn set_cursor(
        &mut self,
        name: &str,
        version: i64,
        last: Option<&firestore::gcloud_sdk::google::firestore::v1::Document>,
        field: Option<&str>,
    ) -> Result<()> {
        use firestore::gcloud_sdk::google::firestore::v1::{Write, write};
        let id = last.map(|doc| crate::js_string::encode(doc.name.rsplit('/').next().unwrap()));
        let mut doc = FirestoreDb::serialize_to_doc(
            format!(
                "{}/maintenancePages/{}",
                self.db.get_documents_path(),
                crate::js_string::utf8(name)
            ),
            &Document::from_value(json!({"version":version,"id":id})),
        )?;
        if let (Some(last), Some(field)) = (last, field)
            && let Some(value) = last.fields.get(field)
        {
            doc.fields.insert("value".into(), value.clone());
        }
        self.writes.add(NativeWrite(Write {
            operation: Some(write::Operation::Update(doc)),
            ..Default::default()
        }))?;
        Ok(())
    }
    pub async fn get(&self, c: &str, id: &str) -> Result<Value> {
        get(&self.db, c, id).await
    }
    pub async fn query(&self, q: Query) -> Result<Vec<Value>> {
        query(&self.db, q).await
    }
    pub fn set(&mut self, c: &str, id: &str, mut v: Value) -> Result<()> {
        if let Some(m) = v.as_object_mut() {
            m.remove("__id");
        }
        self.writes.update_object(
            c,
            crate::js_string::utf8(id),
            &Document::from_value(v),
            None,
            None,
            vec![],
        )?;
        Ok(())
    }
    pub fn merge(&mut self, c: &str, id: &str, v: Value) -> Result<()> {
        let keys = v
            .as_object()
            .unwrap()
            .keys()
            .map(|k| format!("`{}`", k.replace('`', "\\`")))
            .collect();
        self.writes.update_object(
            c,
            crate::js_string::utf8(id),
            &Document::from_value(v),
            Some(keys),
            None,
            vec![],
        )?;
        Ok(())
    }
    pub fn create(&mut self, c: &str, id: &str, v: Value) -> Result<()> {
        self.writes.update_object(
            c,
            crate::js_string::utf8(id),
            &Document::from_value(v),
            None,
            Some(FirestoreWritePrecondition::Exists(false)),
            vec![],
        )?;
        Ok(())
    }
    pub fn delete(&mut self, c: &str, id: &str) -> Result<()> {
        self.writes
            .delete_by_id(c, crate::js_string::utf8(id), None)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conditional_deletes_retain_exact_update_time_and_refuse_missing_versions() {
        use firestore::gcloud_sdk::{
            google::firestore::v1::{Document as NativeDocument, precondition, write},
            prost_types::Timestamp,
        };
        let update = Timestamp {
            seconds: 1_800_000_000,
            nanos: 123_456_000,
        };
        let doc = NativeDocument {
            name: "projects/test/databases/(default)/documents/results/result".into(),
            update_time: Some(update),
            ..Default::default()
        };
        let writes = conditional_delete_writes(std::slice::from_ref(&doc)).unwrap();
        assert_eq!(writes.len(), 1);
        assert_eq!(
            writes[0].operation,
            Some(write::Operation::Delete(doc.name.clone()))
        );
        assert_eq!(
            writes[0].current_document.as_ref().unwrap().condition_type,
            Some(precondition::ConditionType::UpdateTime(update))
        );
        let unversioned = NativeDocument {
            update_time: None,
            ..doc
        };
        assert!(conditional_delete_writes(&[unversioned]).is_err());
    }

    #[test]
    fn native_metadata_is_separate_from_domain_values() {
        let value = json!({"status":"completed","purgeAt":1_800_000_000_000i64});
        let mut doc = FirestoreDb::serialize_to_doc(
            "documents/results/result",
            &Document::from_value(value.clone()),
        )
        .unwrap();
        doc.update_time = Some(firestore::gcloud_sdk::prost_types::Timestamp {
            seconds: 123,
            nanos: 456_000,
        });
        let decoded = decode_document(&doc).unwrap();
        assert_eq!(
            decoded,
            json!({"status":"completed","purgeAt":value["purgeAt"],"__id":"result"})
        );
        assert_eq!(doc.update_time.unwrap().nanos, 456_000);
    }
    #[test]
    fn document_distinguishes_null_missing_and_timestamp_retention() {
        for value in [
            json!({"status":"pending"}),
            json!({"status":"pending","purgeAt":null}),
            json!({"purgeAt":1_800_000_000_000i64}),
        ] {
            let document = FirestoreDb::serialize_to_doc(
                "documents/test",
                &Document::from_value(value.clone()),
            )
            .unwrap();
            assert_eq!(
                FirestoreDb::deserialize_doc_to::<Document>(&document)
                    .unwrap()
                    .value(),
                value
            );
        }
    }
    #[test]
    fn document_preserves_explicit_nulls_and_timestamp_types() {
        let value = json!({"status":"pending", "reason":null, "phones":{"phone":{"reason":null}}, "values":[null,"x"], "purgeAt":1_800_000_000_000i64});
        let document =
            FirestoreDb::serialize_to_doc("documents/test", &Document::from_value(value.clone()))
                .unwrap();
        assert!(format!("{:?}", document.fields["purgeAt"]).contains("TimestampValue"));
        assert_eq!(
            FirestoreDb::deserialize_doc_to::<Document>(&document)
                .unwrap()
                .value(),
            value
        );
    }
}
