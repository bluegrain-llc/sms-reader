//! TCP response deadlines, independent of Hyper's body and write polling.
use axum::{
    body::{Body, Bytes, HttpBody},
    extract::connect_info::Connected,
    serve::{IncomingStream, Listener},
};
use std::{
    collections::HashMap,
    io,
    net::{Shutdown, SocketAddr},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{Notify, oneshot},
    time::Instant,
};

#[derive(Default)]
struct Deadlines {
    next: u64,
    responses: HashMap<u64, (Instant, bool)>,
}
struct Control {
    deadlines: Mutex<Deadlines>,
    changed: Notify,
    closed: tokio::sync::watch::Sender<bool>,
    #[cfg(test)]
    write_blocked: std::sync::atomic::AtomicBool,
}
#[derive(Clone)]
pub struct Connection {
    pub peer_addr: SocketAddr,
    control: Arc<Control>,
}
impl Connection {
    #[cfg(test)]
    pub(crate) fn socket_closed(&self) -> tokio::sync::watch::Receiver<bool> {
        self.control.closed.subscribe()
    }
    #[cfg(test)]
    pub(crate) fn write_blocked(&self) -> bool {
        self.control
            .write_blocked
            .load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn stream_deadline(&self, end: Instant) -> StreamDeadline {
        self.deadline(end, Duration::from_secs(1))
    }
    fn deadline(&self, end: Instant, grace: Duration) -> StreamDeadline {
        let mut deadlines = self.control.deadlines.lock().unwrap();
        deadlines.next += 1;
        let id = deadlines.next;
        deadlines.responses.insert(id, (end + grace, false));
        drop(deadlines);
        self.control.changed.notify_one();
        StreamDeadline {
            connection: self.clone(),
            id,
            grace,
        }
    }
}
// One entry per response also handles pipelined requests and concurrent streams.
// A body EOF alone is insufficient: only the IO's successful flush clears it.
#[derive(Clone)]
pub struct StreamDeadline {
    connection: Connection,
    id: u64,
    grace: Duration,
}
impl StreamDeadline {
    pub fn stop(&self) {
        if let Some((end, _)) = self
            .connection
            .control
            .deadlines
            .lock()
            .unwrap()
            .responses
            .get_mut(&self.id)
        {
            *end = (*end).min(Instant::now() + self.grace);
        }
        self.connection.control.changed.notify_one();
    }
    fn complete(&self) {
        if let Some((_, complete)) = self
            .connection
            .control
            .deadlines
            .lock()
            .unwrap()
            .responses
            .get_mut(&self.id)
        {
            *complete = true;
        }
    }
    pub fn body(self, body: Body) -> Body {
        Body::new(DeadlineBody {
            body,
            deadline: self,
        })
    }
}
struct DeadlineBody {
    body: Body,
    deadline: StreamDeadline,
}
impl HttpBody for DeadlineBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(result, Poll::Ready(None)) || self.body.is_end_stream() {
            self.deadline.complete();
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        let complete = self.body.is_end_stream();
        if complete {
            self.deadline.complete();
        }
        complete
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}
impl Drop for DeadlineBody {
    fn drop(&mut self) {
        self.deadline.stop();
    }
}

pub struct DeadlineListener(pub TcpListener);
pub struct ConnectionIo {
    stream: TcpStream,
    connection: Connection,
    _cancel: oneshot::Sender<()>,
}
impl Drop for ConnectionIo {
    fn drop(&mut self) {
        self.connection.control.closed.send_replace(true);
    }
}
impl Listener for DeadlineListener {
    type Io = ConnectionIo;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, peer_addr) = <TcpListener as Listener>::accept(&mut self.0).await;
            let accepted = (|| {
                let stream = stream.into_std()?;
                let shutdown = stream.try_clone()?;
                let stream = TcpStream::from_std(stream)?;
                Ok::<_, io::Error>((stream, shutdown))
            })();
            let Ok((stream, shutdown)) = accepted else {
                eprintln!("connection_setup_failed");
                continue;
            };
            let (closed, _) = tokio::sync::watch::channel(false);
            let control = Arc::new(Control {
                deadlines: Mutex::new(Deadlines::default()),
                changed: Notify::new(),
                closed,
                #[cfg(test)]
                write_blocked: std::sync::atomic::AtomicBool::new(false),
            });
            let connection = Connection {
                peer_addr,
                control: control.clone(),
            };
            let (cancel, mut cancelled) = oneshot::channel();
            tokio::spawn(async move {
                loop {
                    let changed = control.changed.notified();
                    let deadline = control
                        .deadlines
                        .lock()
                        .unwrap()
                        .responses
                        .values()
                        .map(|(end, _)| *end)
                        .min();
                    let expiry = async {
                        match deadline {
                            Some(end) => tokio::time::sleep_until(end).await,
                            None => std::future::pending().await,
                        }
                    };
                    tokio::select! {
                        _ = &mut cancelled => return,
                        _ = changed => {},
                        _ = expiry => {
                            if !control.deadlines.lock().unwrap().responses.values().any(|(end, _)| *end <= Instant::now()) { continue; }
                            // This reaches the kernel even if Hyper is never polled again.
                            let _ = shutdown.shutdown(Shutdown::Both);
                            return;
                        },
                    }
                }
            });
            return (
                ConnectionIo {
                    stream,
                    connection,
                    _cancel: cancel,
                },
                peer_addr,
            );
        }
    }
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.0.local_addr()
    }
}
impl Connected<IncomingStream<'_, DeadlineListener>> for Connection {
    fn connect_info(stream: IncomingStream<'_, DeadlineListener>) -> Self {
        stream.io().connection.clone()
    }
}
// Existing IP/proxy authentication still receives the original socket address.
pub async fn connection_info(
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if let Some(connection) = request
        .extensions()
        .get::<axum::extract::ConnectInfo<Connection>>()
        .cloned()
    {
        request
            .extensions_mut()
            .insert(axum::extract::ConnectInfo(connection.0.peer_addr));
    }
    next.run(request).await
}
impl AsyncRead for ConnectionIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl AsyncWrite for ConnectionIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write(cx, buf);
        #[cfg(test)]
        if result.is_pending() {
            self.connection
                .control
                .write_blocked
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.stream).poll_flush(cx);
        if matches!(result, Poll::Ready(Ok(()))) {
            self.connection
                .control
                .deadlines
                .lock()
                .unwrap()
                .responses
                .retain(|_, (_, complete)| !*complete);
            self.connection.control.changed.notify_one();
        }
        result
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write_vectored(cx, bufs);
        #[cfg(test)]
        if result.is_pending() {
            self.connection
                .control
                .write_blocked
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        result
    }
}
