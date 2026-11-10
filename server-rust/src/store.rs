use crate::error::{Error, Result};
use firestore::*;
use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::OnceCell;
#[derive(Deserialize)]
struct Document {
    #[serde(flatten)]
    fields: serde_json::Map<String, Value>,
    #[serde(
        rename = "purgeAt",
        default,
        skip_serializing_if = "Option::is_none",
        with = "firestore::serialize_as_optional_timestamp"
    )]
    purge_at: Option<FirestoreInstant>,
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
                    map.serialize_entry(key, &ExplicitNulls(value))?;
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
            self.fields.len() + usize::from(self.purge_at.is_some()),
        ))?;
        for (key, value) in &self.fields {
            map.serialize_entry(key, &ExplicitNulls(value))?;
        }
        if let Some(timestamp) = self.purge_at {
            map.serialize_entry("purgeAt", &TimestampValue(timestamp))?;
        }
        map.end()
    }
}
impl Document {
    fn from_value(mut v: Value) -> Self {
        let purge_at = v
            .as_object_mut()
            .unwrap()
            .remove("purgeAt")
            .and_then(|p| p.as_i64())
            .and_then(|n| FirestoreInstant::from_millisecond(n).ok());
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
        if let Some(t) = self.purge_at {
            v["purgeAt"] = json!(t.as_millisecond());
        }
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
    pub filters: Vec<(&'static str, &'static str, Value)>,
    pub order: Vec<(&'static str, bool)>,
    pub limit: Option<u32>,
}
impl Query {
    pub fn new(c: &str) -> Self {
        Self {
            col: c.into(),
            filters: vec![],
            order: vec![],
            limit: None,
        }
    }
    pub fn eq(mut self, k: &'static str, v: impl Into<Value>) -> Self {
        self.filters.push((k, "==", v.into()));
        self
    }
    pub fn cmp(mut self, k: &'static str, op: &'static str, v: impl Into<Value>) -> Self {
        self.filters.push((k, op, v.into()));
        self
    }
    pub fn order(mut self, k: &'static str, desc: bool) -> Self {
        self.order.push((k, desc));
        self
    }
    pub fn limit(mut self, n: u32) -> Self {
        self.limit = Some(n);
        self
    }
}
async fn query(db: &FirestoreDb, q: Query) -> Result<Vec<Value>> {
    let mut params = FirestoreQueryParams::new(q.col.as_str().into());
    params.limit = q.limit;
    if !q.filters.is_empty() {
        let filters = q
            .filters
            .into_iter()
            .map(|(k, op, v)| {
                let mut fields =
                    FirestoreDb::serialize_to_doc("", &Document::from_value(json!({k:v})))
                        .expect("query value is serializable")
                        .fields;
                let fv = FirestoreValue::from(fields.remove(k).unwrap());
                FirestoreQueryFilter::Compare(Some(match op {
                    "==" => FirestoreQueryFilterCompare::Equal(k.into(), fv),
                    "<=" => FirestoreQueryFilterCompare::LessThanOrEqual(k.into(), fv),
                    ">" => FirestoreQueryFilterCompare::GreaterThan(k.into(), fv),
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
                .into_iter()
                .map(|(k, d)| {
                    FirestoreQueryOrder::new(
                        k.into(),
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
    let mut query = db
        .fluent()
        .select()
        .from(q.col.as_str())
        .filter(|_| params.filter.clone());
    if let Some(limit) = params.limit {
        query = query.limit(limit);
    }
    if let Some(order) = params.order_by {
        query = query.order(|_| order.clone());
    }
    let docs = query.query().await?;
    docs.into_iter()
        .map(|d| {
            let mut v = FirestoreDb::deserialize_doc_to::<Document>(&d)?.value();
            v["__id"] = json!(d.name.rsplit('/').next().unwrap());
            Ok(v)
        })
        .collect()
}
async fn get(db: &FirestoreDb, c: &str, id: &str) -> Result<Value> {
    Ok(db
        .fluent()
        .select()
        .by_id_in(c)
        .obj::<Document>()
        .one(id)
        .await?
        .map(Document::value)
        .unwrap_or(Value::Null))
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
    pub async fn get(&self, c: &str, id: &str) -> Result<Value> {
        get(self.db().await?, c, id).await
    }
    pub async fn query(&self, q: Query) -> Result<Vec<Value>> {
        query(self.db().await?, q).await
    }
    pub async fn tx<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'a> Fn(&'a mut Tx) -> BoxFuture<'a, Result<T>>,
    {
        let db = self.db().await?;
        for attempt in 0..5 {
            let native = db.begin_transaction().await?;
            let read_db = db.clone_with_consistency_selector(
                FirestoreConsistencySelector::Transaction(native.transaction_id().clone()),
            );
            let mut tx = Tx {
                db: read_db,
                writes: native.into_data(),
            };
            let result = f(&mut tx).await;
            let native = FirestoreTransaction::from_data(db, tx.writes);
            match result {
                Ok(value) => match native.commit().await {
                    Ok(_) => return Ok(value),
                    Err(e) if retry(&e) && attempt < 4 => {}
                    Err(e) => return Err(e.into()),
                },
                Err(e) => {
                    let _ = native.rollback().await;
                    if !matches!(&e,Error::Store(s) if retry(s)&&attempt<4) {
                        return Err(e);
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20 * (1 << attempt))).await;
        }
        unreachable!()
    }
}
fn retry(e: &firestore::errors::FirestoreError) -> bool {
    matches!(e,firestore::errors::FirestoreError::DatabaseError(d) if d.retry_possible)
}
impl Tx {
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
        self.writes
            .update_object(c, id, &Document::from_value(v), None, None, vec![])?;
        Ok(())
    }
    pub fn merge(&mut self, c: &str, id: &str, v: Value) -> Result<()> {
        let keys = v
            .as_object()
            .unwrap()
            .keys()
            .map(|k| format!("`{}`", k.replace('`', "\\`")))
            .collect();
        self.writes
            .update_object(c, id, &Document::from_value(v), Some(keys), None, vec![])?;
        Ok(())
    }
    pub fn create(&mut self, c: &str, id: &str, v: Value) -> Result<()> {
        self.writes.update_object(
            c,
            id,
            &Document::from_value(v),
            None,
            Some(FirestoreWritePrecondition::Exists(false)),
            vec![],
        )?;
        Ok(())
    }
    pub fn delete(&mut self, c: &str, id: &str) -> Result<()> {
        self.writes.delete_by_id(c, id, None)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
