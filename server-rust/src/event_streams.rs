//! Shared, bounded Firestore tails and fail-closed authorization for SSE clients.
use crate::{
    error::{Error, Result, ensure},
    forms_model::public_event,
    model::{flag, hash, num, text},
    relay::Relay,
    store::{Query, Store},
};
use firestore::{
    FirestoreCollectionDocuments, FirestoreListenEvent, FirestoreListenerTargetChangeType,
    FirestoreTargetType,
};
use futures::StreamExt;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

#[derive(Clone, Default)]
pub struct WatchSnapshot {
    pub docs: Vec<Value>,
    pub current: bool,
    pub failed: bool,
    pub revision: u64,
}
/// Dropping this handle closes the response and request sides of its Listen RPC.
pub struct WatchHandle {
    pub updates: watch::Receiver<WatchSnapshot>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Store {
    pub async fn watch_document(&self, collection: &str, id: &str) -> Result<WatchHandle> {
        self.watch_target(
            FirestoreTargetType::Documents(FirestoreCollectionDocuments::new(
                collection.into(),
                vec![crate::js_string::utf8(id)],
            )),
            1,
        )
        .await
    }
    pub async fn watch_query(&self, query: Query) -> Result<WatchHandle> {
        let bound = query.limit.unwrap_or(100) as usize;
        self.watch_target(
            FirestoreTargetType::Query(crate::store::query_params(&query)),
            bound,
        )
        .await
    }
    async fn watch_target(&self, target: FirestoreTargetType, bound: usize) -> Result<WatchHandle> {
        let db = self.native_db().await?.clone();
        use firestore::gcloud_sdk::google::firestore::v1::{
            ListenRequest, Target, listen_request, target,
        };
        let target_type = match target {
            FirestoreTargetType::Query(query) => target::TargetType::Query(target::QueryTarget {
                parent: query
                    .parent
                    .as_ref()
                    .unwrap_or_else(|| db.get_documents_path())
                    .clone(),
                query_type: Some(target::query_target::QueryType::StructuredQuery(
                    query.try_into()?,
                )),
            }),
            FirestoreTargetType::Documents(documents) => {
                target::TargetType::Documents(target::DocumentsTarget {
                    documents: documents
                        .documents
                        .into_iter()
                        .map(|id| {
                            format!(
                                "{}/{}/{}",
                                db.get_documents_path(),
                                documents.collection,
                                id
                            )
                        })
                        .collect(),
                })
            }
        };
        let request = ListenRequest {
            database: db.get_database_path().clone(),
            target_change: Some(listen_request::TargetChange::AddTarget(Target {
                target_id: 1,
                target_type: Some(target_type),
                ..Default::default()
            })),
            ..Default::default()
        };
        let (close_requests, requests_closed) = tokio::sync::oneshot::channel::<()>();
        let requests = futures::stream::once(async move { request })
            .chain(futures::stream::pending())
            .take_until(async {
                let _ = requests_closed.await;
            });
        let (publisher, updates) = watch::channel(WatchSnapshot::default());
        let task = tokio::spawn(async move {
            let _close_requests = close_requests;
            let mut snapshot = WatchSnapshot::default();
            let mut documents = BTreeMap::new();
            let result: Result<()> = async {
                let mut responses = db
                    .client()
                    .get()
                    .listen(firestore::gcloud_sdk::tonic::Request::new(requests))
                    .await
                    .map_err(firestore::errors::FirestoreError::from)?
                    .into_inner();
                while let Some(response) = responses.next().await {
                    let Some(event) = response
                        .map_err(firestore::errors::FirestoreError::from)?
                        .response_type
                    else {
                        continue;
                    };
                    let publish = match event {
                        FirestoreListenEvent::DocumentChange(change) => {
                            let document = change.document.ok_or(Error::External)?;
                            if change.target_ids.contains(&1) {
                                let value = crate::store::decode_document(&document)?;
                                documents.insert(document.name, value);
                                // A limit replacement may add the new page before removing the old.
                                ensure(
                                    documents.len() <= bound.saturating_mul(2).max(1),
                                    503,
                                    "event_watch_unavailable",
                                )?;
                            } else if change.removed_target_ids.contains(&1) {
                                documents.remove(&document.name);
                            }
                            false
                        }
                        FirestoreListenEvent::DocumentDelete(change) => {
                            documents.remove(&change.document);
                            false
                        }
                        FirestoreListenEvent::DocumentRemove(change) => {
                            documents.remove(&change.document);
                            false
                        }
                        FirestoreListenEvent::TargetChange(change) => {
                            ensure(change.cause.is_none(), 503, "event_watch_unavailable")?;
                            match FirestoreListenerTargetChangeType::try_from(
                                change.target_change_type,
                            ) {
                                Ok(FirestoreListenerTargetChangeType::Current) => {
                                    snapshot.current = true;
                                    true
                                }
                                Ok(FirestoreListenerTargetChangeType::NoChange) => {
                                    snapshot.current && change.read_time.is_some()
                                }
                                Ok(FirestoreListenerTargetChangeType::Add) => false,
                                Ok(FirestoreListenerTargetChangeType::Reset) => {
                                    // A limit query can reset when its result set changes. Suppress
                                    // its stale snapshot until a fresh CURRENT barrier arrives.
                                    documents.clear();
                                    snapshot.current = false;
                                    true
                                }
                                _ => {
                                    return Err::<(), Error>(Error::Api(
                                        503,
                                        "event_watch_unavailable",
                                    ));
                                }
                            }
                        }
                        FirestoreListenEvent::Filter(filter) => {
                            ensure(
                                filter.count >= 0 && filter.count as usize == documents.len(),
                                503,
                                "event_watch_unavailable",
                            )?;
                            false
                        }
                    };
                    if publish {
                        ensure(documents.len() <= bound, 503, "event_watch_unavailable")?;
                        snapshot.docs = documents.values().cloned().collect();
                        snapshot.revision += 1;
                        publisher.send_replace(snapshot.clone());
                    }
                }
                Err(Error::Api(503, "event_watch_unavailable"))
            }
            .await;
            if result.is_err() {
                snapshot.failed = true;
                snapshot.current = false;
                publisher.send_replace(snapshot);
            }
        });
        Ok(WatchHandle { updates, task })
    }
}
#[derive(Clone, Default)]
struct FeedSnapshot {
    ready: bool,
    failed: bool,
    revision: u64,
    events: Vec<Value>,
}
struct Feed {
    updates: watch::Sender<FeedSnapshot>,
    cancel: watch::Sender<bool>,
    subscribers: AtomicUsize,
}
#[derive(Clone)]
pub struct EventStreams {
    relay: Relay,
    feeds: Arc<Mutex<HashMap<String, Arc<Feed>>>>,
}
pub struct FeedSubscription {
    key: String,
    feed: Arc<Feed>,
    feeds: Arc<Mutex<HashMap<String, Arc<Feed>>>>,
    updates: watch::Receiver<FeedSnapshot>,
}
impl Drop for FeedSubscription {
    fn drop(&mut self) {
        if self.feed.subscribers.fetch_sub(1, Ordering::AcqRel) == 1 {
            let mut feeds = self.feeds.lock().unwrap();
            if feeds
                .get(&self.key)
                .is_some_and(|current| Arc::ptr_eq(current, &self.feed))
            {
                feeds.remove(&self.key);
            }
            let _ = self.feed.cancel.send(true);
        }
    }
}
impl EventStreams {
    pub fn new(relay: Relay) -> Self {
        Self {
            relay,
            feeds: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    pub fn active_feeds(&self) -> usize {
        self.feeds.lock().unwrap().len()
    }
    pub async fn subscribe(&self, secret: String) -> Result<FeedSubscription> {
        let relay = self.relay.clone();
        let credential = secret.clone();
        let grant = self
            .relay
            .store
            .tx(move |tx| {
                let (relay, credential) = (relay.clone(), credential.clone());
                Box::pin(async move { Ok(relay.form_agent(tx, &credential).await?.0) })
            })
            .await?;
        let key = hash(&secret);
        let feed = {
            let mut feeds = self.feeds.lock().unwrap();
            let feed = feeds
                .entry(key.clone())
                .or_insert_with(|| {
                    let (updates, _) = watch::channel(FeedSnapshot::default());
                    let (cancel, cancellation) = watch::channel(false);
                    let feed = Arc::new(Feed {
                        updates,
                        cancel,
                        subscribers: AtomicUsize::new(0),
                    });
                    tokio::spawn(run_feed(
                        self.relay.clone(),
                        grant.clone(),
                        feed.clone(),
                        cancellation,
                    ));
                    feed
                })
                .clone();
            feed.subscribers.fetch_add(1, Ordering::Relaxed);
            feed
        };
        let mut subscription = FeedSubscription {
            key,
            updates: feed.updates.subscribe(),
            feed,
            feeds: self.feeds.clone(),
        };
        loop {
            let snapshot = subscription.updates.borrow_and_update().clone();
            ensure(!snapshot.failed, 503, "event_watch_unavailable")?;
            if snapshot.ready {
                return Ok(subscription);
            }
            subscription
                .updates
                .changed()
                .await
                .map_err(|_| Error::Api(503, "event_watch_unavailable"))?;
        }
    }
}
impl FeedSubscription {
    pub fn closed(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let mut updates = self.updates.clone();
        async move {
            loop {
                if updates.borrow_and_update().failed || updates.changed().await.is_err() {
                    return;
                }
            }
        }
    }
    pub fn failed(&self) -> bool {
        self.updates.borrow().failed
    }
    pub fn revision(&self) -> u64 {
        self.updates.borrow().revision
    }
    pub fn oldest(&self) -> Option<i64> {
        let snapshot = self.updates.borrow();
        if !snapshot.ready || snapshot.failed {
            return None;
        }
        snapshot.events.first().map(|event| num(event, "sequence"))
    }
    pub fn tail(&self, sequence: i64, now: i64) -> Vec<Value> {
        let snapshot = self.updates.borrow();
        if !snapshot.ready || snapshot.failed {
            return Vec::new();
        }
        snapshot
            .events
            .iter()
            .filter(|event| num(event, "sequence") > sequence && num(event, "purgeAt") > now)
            .cloned()
            .map(public_event)
            .collect()
    }
    pub async fn changed(&mut self) -> Result<()> {
        self.updates
            .changed()
            .await
            .map_err(|_| Error::Api(503, "event_watch_unavailable"))?;
        ensure(!self.failed(), 503, "event_watch_unavailable")
    }
}
async fn cancelled(mut cancel: watch::Receiver<bool>) {
    if !*cancel.borrow_and_update() {
        let _ = cancel.changed().await;
    }
}
async fn run_feed(relay: Relay, grant: Value, feed: Arc<Feed>, cancel: watch::Receiver<bool>) {
    let task = async {
        let mut account = relay
            .store
            .watch_document("accounts", text(&grant, "ownerId"))
            .await?;
        let mut authorization = relay
            .store
            .watch_document("grants", text(&grant, "id"))
            .await?;
        let mut events = relay
            .store
            .watch_query(
                Query::new("requestEvents")
                    .eq("grantId", grant["id"].clone())
                    .order("sequence", true)
                    .limit(100),
            )
            .await?;
        let mut ready_by = tokio::time::Instant::now() + Duration::from_secs(10);
        let expiry = tokio::time::sleep(Duration::from_millis(
            (num(&grant, "expiresAt") - relay.now()).clamp(1, 2_147_483_647) as u64,
        ));
        tokio::pin!(expiry);
        let mut snapshot = FeedSnapshot::default();
        let mut last_events = 0;
        loop {
            let owner = account.updates.borrow_and_update().clone();
            let access = authorization.updates.borrow_and_update().clone();
            let tail = events.updates.borrow_and_update().clone();
            ensure(
                !owner.failed && !access.failed && !tail.failed,
                503,
                "event_watch_unavailable",
            )?;
            if owner.current {
                ensure(
                    !owner
                        .docs
                        .first()
                        .is_some_and(|owner| flag(owner, "deleting")),
                    503,
                    "event_watch_unavailable",
                )?;
            }
            if access.current {
                let current = access
                    .docs
                    .first()
                    .ok_or(Error::Api(503, "event_watch_unavailable"))?;
                ensure(
                    current["ownerId"] == grant["ownerId"]
                        && relay.valid_grant(current)
                        && flag(current, "formsApproved"),
                    503,
                    "event_watch_unavailable",
                )?;
            }
            let was_ready = snapshot.ready;
            snapshot.ready = owner.current && access.current && tail.current;
            if was_ready && !snapshot.ready {
                ready_by = tokio::time::Instant::now() + Duration::from_secs(10);
            }
            if tail.revision != last_events {
                snapshot.events = tail.docs;
                snapshot.events.sort_by_key(|event| num(event, "sequence"));
                snapshot.revision += 1;
                last_events = tail.revision;
            }
            feed.updates.send_replace(snapshot.clone());
            tokio::select! {
                result = account.updates.changed() => { result.map_err(|_| Error::External)?; },
                result = authorization.updates.changed() => { result.map_err(|_| Error::External)?; },
                result = events.updates.changed() => { result.map_err(|_| Error::External)?; },
                _ = tokio::time::sleep_until(ready_by), if !snapshot.ready => return Err::<(),Error>(Error::Api(503, "event_watch_unavailable")),
                _ = &mut expiry => return Err::<(),Error>(Error::Api(503, "event_watch_unavailable")),
            }
        }
    };
    tokio::select! { _ = task => { feed.updates.send_modify(|state| state.failed = true); }, _ = cancelled(cancel) => {} }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn subscriptions() -> (FeedSubscription, FeedSubscription, watch::Receiver<bool>) {
        let (updates, _) = watch::channel(FeedSnapshot {
            ready: true,
            ..Default::default()
        });
        let (cancel, cancellation) = watch::channel(false);
        let feed = Arc::new(Feed {
            updates,
            cancel,
            subscribers: AtomicUsize::new(2),
        });
        let feeds = Arc::new(Mutex::new(HashMap::from([("grant".into(), feed.clone())])));
        let subscription = || FeedSubscription {
            key: "grant".into(),
            updates: feed.updates.subscribe(),
            feed: feed.clone(),
            feeds: feeds.clone(),
        };
        (subscription(), subscription(), cancellation)
    }
    #[tokio::test]
    async fn one_disconnect_preserves_shared_feed_and_final_disconnect_cancels_it() {
        let (first, second, mut cancellation) = subscriptions();
        let feeds = first.feeds.clone();
        drop(first);
        assert_eq!(feeds.lock().unwrap().len(), 1);
        assert!(!*cancellation.borrow());
        drop(second);
        assert!(feeds.lock().unwrap().is_empty());
        tokio::time::timeout(Duration::from_millis(100), cancellation.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(*cancellation.borrow());
    }
    #[tokio::test]
    async fn authorization_failure_notifies_every_client_without_emitting_private_fields() {
        let (first, second, _) = subscriptions();
        first.feed.updates.send_modify(|state| { state.events=vec![
            json!({"id":"expired","sequence":1,"purgeAt":9,"ownerId":"private","grantId":"private"}),
            json!({"id":"retained","sequence":2,"purgeAt":20,"ownerId":"private","grantId":"private","type":"request.created"}),
        ]; });
        let tail = first.tail(0, 10);
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0]["id"], "retained");
        assert!(!tail[0].to_string().contains("private"));
        let closed_first = first.closed();
        let closed_second = second.closed();
        first.feed.updates.send_modify(|state| state.failed = true);
        tokio::time::timeout(Duration::from_millis(100), async {
            tokio::join!(closed_first, closed_second);
        })
        .await
        .unwrap();
        assert!(first.failed() && second.failed());
    }
}
