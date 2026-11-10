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
                    open_listen(request, move |requests| {
                        Box::pin(async move {
                            Ok(Box::pin(
                                db.client()
                                    .get()
                                    .listen(firestore::gcloud_sdk::tonic::Request::new(requests))
                                    .await?
                                    .into_inner(),
                            ) as ListenStream)
                        })
                    })
                    .await
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

type ListenRequests = tokio_stream::wrappers::UnboundedReceiverStream<
    firestore::gcloud_sdk::google::firestore::v1::ListenRequest,
>;
async fn open_listen<F>(
    request: firestore::gcloud_sdk::google::firestore::v1::ListenRequest,
    rpc: F,
) -> std::result::Result<ListenStream, Status>
where
    F: FnOnce(ListenRequests) -> BoxFuture<'static, std::result::Result<ListenStream, Status>>,
{
    let (requests, receiver) = tokio::sync::mpsc::unbounded_channel();
    requests
        .send(request)
        .map_err(|_| Status::cancelled("watch_closed"))?;
    let responses = rpc(tokio_stream::wrappers::UnboundedReceiverStream::new(
        receiver,
    ))
    .await?;
    Ok(Box::pin(responses.map(move |response| {
        let _keep_request_open = &requests;
        response
    })))
}

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
        let relay = self.relay.clone();
        attach_feed(
            self.feeds.clone(),
            hash(&secret),
            move |feed, cancellation| {
                tokio::spawn(run_feed(relay, grant, feed, cancellation));
            },
        )
        .await
    }
}
async fn attach_feed<F>(
    feeds: Arc<Mutex<HashMap<String, FeedEntry>>>,
    key: String,
    start: F,
) -> Result<FeedSubscription>
where
    F: FnOnce(Arc<Feed>, watch::Receiver<bool>),
{
    let feed = {
        let mut feeds = feeds.lock().unwrap();
        let feed = feeds.entry(key.clone()).or_insert_with(|| {
            let (updates, _) = watch::channel(FeedSnapshot::default());
            let (cancel, cancellation) = watch::channel(false);
            let feed = Arc::new(Feed { updates, cancel });
            start(feed.clone(), cancellation);
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
        feeds: feeds.clone(),
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
    pub fn ready(&self) -> bool {
        let snapshot = self.updates.borrow();
        snapshot.ready && !snapshot.failed
    }
    pub async fn wait_ready(&self) -> Result<()> {
        let mut updates = self.updates.clone();
        loop {
            let state = updates.borrow_and_update().clone();
            ensure(!state.failed, 503, "event_watch_unavailable")?;
            if state.ready {
                return Ok(());
            }
            updates
                .changed()
                .await
                .map_err(|_| Error::Api(503, "event_watch_unavailable"))?;
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
        let account = relay
            .store
            .watch_document("accounts", text(&grant, "ownerId"))
            .await?;
        let authorization = relay
            .store
            .watch_document("grants", text(&grant, "id"))
            .await?;
        let events = relay
            .store
            .watch_query(
                Query::new("requestEvents")
                    .eq("grantId", grant["id"].clone())
                    .order("sequence", true)
                    .limit(100),
            )
            .await?;
        monitor_feed(
            relay,
            grant,
            feed.clone(),
            account,
            authorization,
            events,
            tokio::time::Instant::now() + Duration::from_secs(10),
        )
        .await
    };
    supervise_feed(feed.clone(), cancel, task).await;
}
async fn supervise_feed<F: std::future::Future<Output = Result<()>>>(
    feed: Arc<Feed>,
    cancel: watch::Receiver<bool>,
    task: F,
) {
    tokio::select! { _ = task => {}, _ = cancelled(cancel) => {} }
    feed.updates.send_modify(|state| {
        state.ready = false;
        state.failed = true;
    });
}
async fn monitor_feed(
    relay: Relay,
    grant: Value,
    feed: Arc<Feed>,
    mut account: WatchHandle,
    mut authorization: WatchHandle,
    mut events: WatchHandle,
    ready_by: tokio::time::Instant,
) -> Result<()> {
    let mut initialized = false;
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
        snapshot.ready = owner.current && access.current && tail.current;
        initialized |= snapshot.ready;
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
            _ = tokio::time::sleep_until(ready_by), if !initialized => return Err::<(),Error>(Error::Api(503, "event_watch_unavailable")),
            _ = &mut expiry => return Err::<(),Error>(Error::Api(503, "event_watch_unavailable")),
        }
    }
}

#[cfg(test)]
pub(crate) mod scripted {
    use super::*;
    use firestore::gcloud_sdk::google::firestore::v1::{
        DocumentChange, ListenRequest, TargetChange,
    };
    type ScriptedResponse = (
        std::result::Result<ListenResponse, Status>,
        Option<tokio::sync::oneshot::Sender<()>>,
    );
    pub struct Connection {
        writer: tokio::sync::mpsc::UnboundedSender<ScriptedResponse>,
        pub requests_closed: tokio::sync::oneshot::Receiver<()>,
    }
    impl Connection {
        pub async fn processed(&self, response: std::result::Result<ListenResponse, Status>) {
            self.writer.send((response, None)).unwrap();
            let (processed, completion) = tokio::sync::oneshot::channel();
            self.writer
                .send((
                    change(FirestoreListenerTargetChangeType::Add),
                    Some(processed),
                ))
                .unwrap();
            tokio::time::timeout(Duration::from_secs(1), completion)
                .await
                .unwrap()
                .unwrap();
        }
        pub fn send(&self, response: std::result::Result<ListenResponse, Status>) {
            self.writer.send((response, None)).unwrap();
        }
        pub async fn response_closed(&self) {
            tokio::time::timeout(Duration::from_secs(1), self.writer.closed())
                .await
                .unwrap();
        }
    }
    pub fn change(
        kind: FirestoreListenerTargetChangeType,
    ) -> std::result::Result<ListenResponse, Status> {
        Ok(ListenResponse {
            response_type: Some(FirestoreListenEvent::TargetChange(TargetChange {
                target_change_type: kind as i32,
                ..Default::default()
            })),
        })
    }
    pub fn doc(
        collection: &str,
        id: &str,
        value: Value,
    ) -> std::result::Result<ListenResponse, Status> {
        let document = firestore::FirestoreDb::serialize_to_doc(
            format!("projects/test/databases/(default)/documents/{collection}/{id}"),
            &value,
        )
        .unwrap();
        Ok(ListenResponse {
            response_type: Some(FirestoreListenEvent::DocumentChange(DocumentChange {
                document: Some(document),
                target_ids: vec![1],
                ..Default::default()
            })),
        })
    }
    pub fn watch(
        bound: usize,
        fail_setup: bool,
    ) -> (
        WatchHandle,
        tokio::sync::mpsc::UnboundedReceiver<Connection>,
    ) {
        watch_with_backoff(bound, fail_setup, Duration::from_millis(1))
    }
    pub fn watch_with_backoff(
        bound: usize,
        fail_setup: bool,
        backoff: Duration,
    ) -> (
        WatchHandle,
        tokio::sync::mpsc::UnboundedReceiver<Connection>,
    ) {
        let (attempts, connections) = tokio::sync::mpsc::unbounded_channel();
        let mut first = fail_setup;
        let watch = watch_with_connector(
            move || {
                let attempts = attempts.clone();
                let fail = std::mem::take(&mut first);
                Box::pin(async move {
                    if fail {
                        return Err(Status::unavailable("setup"));
                    }
                    open_listen(ListenRequest::default(), move |mut requests| {
                        Box::pin(async move {
                            assert!(requests.next().await.is_some());
                            let (request_close, requests_closed) = tokio::sync::oneshot::channel();
                            tokio::spawn(async move {
                                assert!(requests.next().await.is_none());
                                let _ = request_close.send(());
                            });
                            let (writer, responses) = tokio::sync::mpsc::unbounded_channel();
                            attempts
                                .send(Connection {
                                    writer,
                                    requests_closed,
                                })
                                .unwrap_or_else(|_| panic!("connection receiver dropped"));
                            Ok(Box::pin(
                                tokio_stream::wrappers::UnboundedReceiverStream::new(responses)
                                    .map(|(response, processed)| {
                                        if let Some(processed) = processed {
                                            let _ = processed.send(());
                                        }
                                        response
                                    }),
                            ) as ListenStream)
                        })
                    })
                    .await
                })
            },
            bound,
            backoff,
        );
        (watch, connections)
    }
    pub async fn next(
        connections: &mut tokio::sync::mpsc::UnboundedReceiver<Connection>,
    ) -> Connection {
        tokio::time::timeout(Duration::from_secs(1), connections.recv())
            .await
            .unwrap()
            .unwrap()
    }
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
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_attach_and_last_drop_use_production_attachment_path() {
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let start = |feed: Arc<Feed>, _: watch::Receiver<bool>| {
            feed.updates.send_modify(|state| state.ready = true);
        };
        let first = attach_feed(registry.clone(), "grant".into(), start)
            .await
            .unwrap();
        let guard = registry.lock().unwrap();
        let (started, dropping) = std::sync::mpsc::sync_channel(0);
        let dropper = std::thread::spawn(move || {
            started.send(()).unwrap();
            drop(first);
        });
        dropping.recv().unwrap();
        let feeds = registry.clone();
        let attaching =
            tokio::spawn(async move { attach_feed(feeds, "grant".into(), start).await });
        drop(guard);
        dropper.join().unwrap();
        let attached = tokio::time::timeout(Duration::from_secs(1), attaching)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(attached.ready());
        assert!(!attached.failed());
        assert_eq!(registry.lock().unwrap()["grant"].subscribers, 1);
        let second = attach_feed(registry.clone(), "grant".into(), start)
            .await
            .unwrap();
        drop(attached);
        assert!(second.ready());
        drop(second);
        assert!(registry.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn listen_retries_setup_failure_and_discards_cached_data_until_fresh_current() {
        use scripted::*;
        let (mut watch, mut connections) = scripted::watch(1, true);
        let mut first = next(&mut connections).await;
        first.processed(doc("control", "state", json!({}))).await;
        assert!(!watch.updates.borrow().current);
        first
            .processed(change(FirestoreListenerTargetChangeType::Current))
            .await;
        wait_snapshot(&mut watch, |state| state.current && state.docs.len() == 1).await;
        assert!(matches!(
            first.requests_closed.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        first.send(Err(Status::unavailable("interrupted")));
        wait_snapshot(&mut watch, |state| !state.current && state.docs.is_empty()).await;
        tokio::time::timeout(Duration::from_secs(1), &mut first.requests_closed)
            .await
            .unwrap()
            .unwrap();
        let mut second = next(&mut connections).await;
        second.processed(doc("control", "state", json!({}))).await;
        // The processing barrier proves the update was consumed before this assertion.
        assert!(!watch.updates.borrow().current);
        assert!(watch.updates.borrow().docs.is_empty());
        second
            .processed(change(FirestoreListenerTargetChangeType::Current))
            .await;
        wait_snapshot(&mut watch, |state| state.current && state.docs.len() == 1).await;
        assert!(matches!(
            second.requests_closed.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        drop(watch);
        second.response_closed().await;
        tokio::time::timeout(Duration::from_secs(1), &mut second.requests_closed)
            .await
            .unwrap()
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), connections.recv())
                .await
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn shared_feed_pauses_both_clients_through_each_reconnect_until_current() {
        use scripted::*;
        let (account, mut accounts) = scripted::watch(1, false);
        let (authorization, mut grants) = scripted::watch(1, false);
        let (events, mut tails) = scripted::watch(100, false);
        let account_rpc = next(&mut accounts).await;
        let grant_rpc = next(&mut grants).await;
        let tail_rpc = next(&mut tails).await;
        let grant = json!({"id":"grant","ownerId":"owner","formsApproved":true,"expiresAt":60_000});
        account_rpc
            .processed(doc("accounts", "owner", json!({})))
            .await;
        grant_rpc
            .processed(doc("grants", "grant", grant.clone()))
            .await;
        tail_rpc
            .processed(doc(
                "requestEvents",
                "event1",
                json!({"id":"event1","sequence":1}),
            ))
            .await;
        for connection in [&account_rpc, &grant_rpc, &tail_rpc] {
            connection
                .processed(change(FirestoreListenerTargetChangeType::Current))
                .await;
        }
        let relay = Relay {
            store: Store::new("test").await.unwrap(),
            clock: Arc::new(|| 0),
            delivery: Arc::new(crate::google::Google::new("test".into())),
        };
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let initial_grant = grant.clone();
        let first = attach_feed(registry.clone(), "grant".into(), move |feed, cancel| {
            let monitor = monitor_feed(
                relay,
                initial_grant,
                feed.clone(),
                account,
                authorization,
                events,
                tokio::time::Instant::now() + Duration::from_millis(20),
            );
            tokio::spawn(supervise_feed(feed, cancel, monitor));
        })
        .await
        .unwrap();
        let second = attach_feed(registry.clone(), "grant".into(), |_, _| {
            panic!("must share feed")
        })
        .await
        .unwrap();
        assert_eq!(first.tail(0, -1).len(), 1);
        // Once initialized, reconnects pause under the original stream/grant deadlines;
        // the initial-snapshot timer must not become a new reconnect timeout.
        tokio::time::sleep(Duration::from_millis(25)).await;
        let mut current = vec![account_rpc, grant_rpc, tail_rpc];
        for (source, connection) in current.iter_mut().enumerate() {
            connection.send(Err(Status::unavailable("transient")));
            wait_feed(&first, false).await;
            assert!(!first.failed() && !second.failed());
            assert!(!second.ready());
            assert!(first.tail(0, -1).is_empty());
            assert!(
                tokio::time::timeout(Duration::from_millis(5), second.wait_ready())
                    .await
                    .is_err()
            );
            let replacement = next(match source {
                0 => &mut accounts,
                1 => &mut grants,
                _ => &mut tails,
            })
            .await;
            replacement
                .processed(match source {
                    0 => doc("accounts", "owner", json!({})),
                    1 => doc("grants", "grant", grant.clone()),
                    _ => doc(
                        "requestEvents",
                        "event2",
                        json!({"id":"event2","sequence":2}),
                    ),
                })
                .await;
            assert!(!first.ready() && !second.ready());
            assert!(first.tail(0, -1).is_empty());
            replacement
                .processed(change(FirestoreListenerTargetChangeType::Current))
                .await;
            tokio::time::timeout(Duration::from_secs(1), first.wait_ready())
                .await
                .unwrap()
                .unwrap();
            assert!(second.ready());
            assert!(!second.failed());
            *connection = replacement;
            assert_eq!(registry.lock().unwrap().len(), 1);
        }
        assert_eq!(first.tail(0, -1)[0]["sequence"], 2);
        current[1].send(Err(Status::unavailable("transient")));
        wait_feed(&first, false).await;
        let revoked = next(&mut grants).await;
        let mut denied = grant;
        denied["revoked"] = json!(true);
        revoked.processed(doc("grants", "grant", denied)).await;
        assert!(!first.ready() && !first.failed());
        revoked
            .processed(change(FirestoreListenerTargetChangeType::Current))
            .await;
        tokio::time::timeout(Duration::from_secs(1), first.closed())
            .await
            .unwrap();
        assert!(second.failed());
        drop(first);
        drop(second);
        assert!(registry.lock().unwrap().is_empty());
        for mut connection in current.into_iter().chain([revoked]) {
            tokio::time::timeout(Duration::from_secs(1), &mut connection.requests_closed)
                .await
                .unwrap()
                .unwrap();
        }
    }
    async fn wait_feed(subscription: &FeedSubscription, ready: bool) {
        let mut updates = subscription.updates.clone();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if updates.borrow_and_update().ready == ready {
                    return;
                }
                updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
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
