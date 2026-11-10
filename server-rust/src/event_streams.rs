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
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

#[derive(Clone, Default)]
pub struct WatchSnapshot {
    pub docs: Vec<Value>,
    pub current: bool,
    pub failed: bool,
    pub interrupted: bool,
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
        Ok(watch_with_connector(
            move || {
                let (db, request) = (db.clone(), request.clone());
                Box::pin(async move {
                    let (close_requests, requests_closed) = tokio::sync::oneshot::channel::<()>();
                    let requests = futures::stream::once(async move { request })
                        .chain(futures::stream::pending())
                        .take_until(async {
                            let _ = requests_closed.await;
                        });
                    let responses = db
                        .client()
                        .get()
                        .listen(firestore::gcloud_sdk::tonic::Request::new(requests))
                        .await?
                        .into_inner();
                    Ok(Box::pin(responses.map(move |response| {
                        let _keep_request_open = &close_requests;
                        response
                    })) as ListenStream)
                })
            },
            bound,
            Duration::from_millis(100),
        ))
    }
}
use firestore::gcloud_sdk::{
    google::firestore::v1::ListenResponse,
    tonic::{Code, Status},
};
use futures::{Stream, future::BoxFuture};
use std::pin::Pin;
pub(crate) type ListenStream =
    Pin<Box<dyn Stream<Item = std::result::Result<ListenResponse, Status>> + Send>>;

fn retryable(code: Code) -> bool {
    matches!(
        code,
        Code::Aborted
            | Code::Cancelled
            | Code::Unknown
            | Code::DeadlineExceeded
            | Code::ResourceExhausted
            | Code::Internal
            | Code::Unavailable
            | Code::Unauthenticated
    )
}

// The same runner is used by real RPCs and transport-controlled regression tests.
// Each attempt starts from an empty cache; only CURRENT makes that attempt usable.
pub(crate) fn watch_with_connector<F>(
    mut connect: F,
    bound: usize,
    initial_backoff: Duration,
) -> WatchHandle
where
    F: FnMut() -> BoxFuture<'static, std::result::Result<ListenStream, Status>> + Send + 'static,
{
    let (publisher, updates) = watch::channel(WatchSnapshot::default());
    let task = tokio::spawn(async move {
        let mut snapshot = WatchSnapshot::default();
        let mut backoff = initial_backoff;
        loop {
            let mut documents = BTreeMap::new();
            let result: std::result::Result<(), Status> = async {
                let mut responses = tokio::time::timeout(Duration::from_secs(10), connect())
                    .await
                    .map_err(|_| Status::deadline_exceeded("watch_setup_timeout"))??;
                while let Some(response) = responses.next().await {
                    let Some(event) = response?.response_type else {
                        continue;
                    };
                    let publish = match event {
                        FirestoreListenEvent::DocumentChange(change) => {
                            let document = change
                                .document
                                .ok_or_else(|| Status::data_loss("missing_document"))?;
                            if change.target_ids.contains(&1) {
                                let value = crate::store::decode_document(&document)
                                    .map_err(|_| Status::data_loss("invalid_document"))?;
                                documents.insert(document.name, value);
                                if documents.len() > bound.saturating_mul(2).max(1) {
                                    return Err(Status::data_loss("watch_limit"));
                                }
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
                            if let Some(cause) = change.cause {
                                return Err(Status::new(
                                    Code::from_i32(cause.code),
                                    "watch_target_failed",
                                ));
                            }
                            match FirestoreListenerTargetChangeType::try_from(
                                change.target_change_type,
                            ) {
                                Ok(FirestoreListenerTargetChangeType::Current) => {
                                    snapshot.current = true;
                                    snapshot.interrupted = false;
                                    backoff = initial_backoff;
                                    true
                                }
                                Ok(FirestoreListenerTargetChangeType::NoChange) => {
                                    snapshot.current && change.read_time.is_some()
                                }
                                Ok(FirestoreListenerTargetChangeType::Add) => false,
                                Ok(FirestoreListenerTargetChangeType::Reset) => {
                                    documents.clear();
                                    snapshot.current = false;
                                    true
                                }
                                _ => {
                                    return Err(Status::failed_precondition(
                                        "watch_target_removed",
                                    ));
                                }
                            }
                        }
                        FirestoreListenEvent::Filter(filter) => {
                            if filter.count < 0 || filter.count as usize != documents.len() {
                                // Rebuild rather than retaining an inconsistent authorization cache.
                                return Err(Status::unavailable("watch_filter_mismatch"));
                            }
                            false
                        }
                    };
                    if publish {
                        if documents.len() > bound {
                            return Err(Status::data_loss("watch_limit"));
                        }
                        snapshot.docs = documents.values().cloned().collect();
                        snapshot.revision += 1;
                        publisher.send_replace(snapshot.clone());
                    }
                }
                Err(Status::unavailable("watch_stream_ended"))
            }
            .await;
            // Never retain data or CURRENT across a disconnected RPC.
            snapshot.docs.clear();
            snapshot.current = false;
            snapshot.interrupted = true;
            snapshot.revision += 1;
            let retry = result.as_ref().is_err_and(|error| retryable(error.code()));
            snapshot.failed = !retry;
            publisher.send_replace(snapshot.clone());
            // Safe and visible at the default logging level; no provider details or identifiers.
            eprintln!("firestore_watch_unavailable retry={retry}");
            if !retry {
                return;
            }
            tokio::time::sleep(backoff).await;
            backoff = backoff.saturating_mul(2).min(Duration::from_secs(30));
        }
    });
    WatchHandle { updates, task }
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
}
struct FeedEntry {
    feed: Arc<Feed>,
    subscribers: usize,
}
#[derive(Clone)]
pub struct EventStreams {
    relay: Relay,
    feeds: Arc<Mutex<HashMap<String, FeedEntry>>>,
}
pub struct FeedSubscription {
    key: String,
    feed: Arc<Feed>,
    feeds: Arc<Mutex<HashMap<String, FeedEntry>>>,
    updates: watch::Receiver<FeedSnapshot>,
}
impl Drop for FeedSubscription {
    fn drop(&mut self) {
        let mut feeds = self.feeds.lock().unwrap();
        let Some(entry) = feeds.get_mut(&self.key) else {
            return;
        };
        if !Arc::ptr_eq(&entry.feed, &self.feed) {
            return;
        }
        entry.subscribers -= 1;
        if entry.subscribers == 0 {
            feeds.remove(&self.key);
            self.feed.updates.send_modify(|state| {
                state.ready = false;
                state.failed = true;
            });
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
            let feed = feeds.entry(key.clone()).or_insert_with(|| {
                let (updates, _) = watch::channel(FeedSnapshot::default());
                let (cancel, cancellation) = watch::channel(false);
                let feed = Arc::new(Feed { updates, cancel });
                tokio::spawn(run_feed(
                    self.relay.clone(),
                    grant.clone(),
                    feed.clone(),
                    cancellation,
                ));
                FeedEntry {
                    feed,
                    subscribers: 0,
                }
            });
            feed.subscribers += 1;
            feed.feed.clone()
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
                !owner.failed
                    && !access.failed
                    && !tail.failed
                    && !owner.interrupted
                    && !access.interrupted
                    && !tail.interrupted,
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
    tokio::select! { _ = task => { feed.updates.send_modify(|state| state.failed = true); }, _ = cancelled(cancel) => { feed.updates.send_modify(|state| { state.ready = false; state.failed = true; }); } }
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
        let feed = Arc::new(Feed { updates, cancel });
        let feeds = Arc::new(Mutex::new(HashMap::from([(
            "grant".into(),
            FeedEntry {
                feed: feed.clone(),
                subscribers: 2,
            },
        )])));
        let subscription = || FeedSubscription {
            key: "grant".into(),
            updates: feed.updates.subscribe(),
            feed: feed.clone(),
            feeds: feeds.clone(),
        };
        (subscription(), subscription(), cancellation)
    }
    #[test]
    fn concurrent_attach_and_last_drop_share_one_registry_critical_section() {
        let (first, second, cancellation) = subscriptions();
        drop(first);
        let registry = second.feeds.clone();
        let feed = second.feed.clone();
        // Hold the exact lock used by attachment while another thread drops the last client.
        let mut entries = registry.lock().unwrap();
        let (started, dropping) = std::sync::mpsc::sync_channel(0);
        let thread = std::thread::spawn(move || {
            started.send(()).unwrap();
            drop(second);
        });
        dropping.recv().unwrap();
        let entry = entries.get_mut("grant").unwrap();
        entry.subscribers += 1;
        let attached = FeedSubscription {
            key: "grant".into(),
            feed: feed.clone(),
            feeds: registry.clone(),
            updates: feed.updates.subscribe(),
        };
        drop(entries);
        thread.join().unwrap();
        assert!(!*cancellation.borrow());
        assert_eq!(registry.lock().unwrap()["grant"].subscribers, 1);
        drop(attached);
        assert!(registry.lock().unwrap().is_empty());
        assert!(*cancellation.borrow());
    }
    #[tokio::test]
    async fn listen_retries_setup_failure_and_discards_cached_data_until_fresh_current() {
        use firestore::gcloud_sdk::google::firestore::v1::{
            Document, DocumentChange, TargetChange,
        };
        let (attempts, mut connections) = tokio::sync::mpsc::unbounded_channel();
        let mut first = true;
        let mut watch = watch_with_connector(
            move || {
                let attempts = attempts.clone();
                let fail_setup = std::mem::take(&mut first);
                Box::pin(async move {
                    if fail_setup {
                        return Err(Status::unavailable("setup"));
                    }
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
        let current = || {
            Ok(ListenResponse {
                response_type: Some(FirestoreListenEvent::TargetChange(TargetChange {
                    target_change_type: FirestoreListenerTargetChangeType::Current as i32,
                    ..Default::default()
                })),
            })
        };
        let document = || {
            Ok(ListenResponse {
                response_type: Some(FirestoreListenEvent::DocumentChange(DocumentChange {
                    document: Some(Document {
                        name: "projects/test/databases/(default)/documents/control/state".into(),
                        ..Default::default()
                    }),
                    target_ids: vec![1],
                    ..Default::default()
                })),
            })
        };
        let first = tokio::time::timeout(Duration::from_secs(1), connections.recv())
            .await
            .unwrap()
            .unwrap();
        first.send(document()).unwrap();
        first.send(current()).unwrap();
        wait_snapshot(&mut watch, |state| state.current && state.docs.len() == 1).await;
        first.send(Err(Status::unavailable("interrupted"))).unwrap();
        wait_snapshot(&mut watch, |state| !state.current && state.docs.is_empty()).await;
        let second = tokio::time::timeout(Duration::from_secs(1), connections.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(!watch.updates.borrow().current);
        second.send(document()).unwrap();
        // A document update is insufficient to validate a new RPC.
        assert!(!watch.updates.borrow().current);
        second.send(current()).unwrap();
        wait_snapshot(&mut watch, |state| state.current && state.docs.len() == 1).await;
        drop(watch);
        tokio::time::timeout(Duration::from_secs(1), second.closed())
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), connections.recv())
                .await
                .unwrap()
                .is_none()
        );
    }
    async fn wait_snapshot(watch: &mut WatchHandle, predicate: impl Fn(&WatchSnapshot) -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if predicate(&watch.updates.borrow_and_update()) {
                    return;
                }
                watch.updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn one_disconnect_preserves_shared_feed_and_final_disconnect_cancels_it() {
        let (first, second, mut cancellation) = subscriptions();
        let feeds = first.feeds.clone();
        let closed = second.closed();
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
        tokio::time::timeout(Duration::from_millis(100), closed)
            .await
            .unwrap();
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
