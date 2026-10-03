//! A minimal HTTP/1.1 server for the container entrypoint.
//!
//! Two routes, and no framework. `axum`/`hyper` would add a dependency tree and
//! a configuration surface to express what this file does in one place: read a
//! bounded head, read a bounded body, refuse everything else, hand the bytes to
//! [`Encoder`], stream the result back. The parts a framework would do for us —
//! and this module does explicitly — are:
//!
//! * **Bounded head** ([`MAX_REQUEST_HEAD_BYTES`]): a client that never sends
//!   `\r\n\r\n` is disconnected rather than allowed to grow a buffer.
//! * **Bounded body**: `Content-Length` above [`MAX_INPUT_BYTES`] is refused
//!   before one body byte is buffered. `Transfer-Encoding: chunked` is refused
//!   outright, because honouring it would mean implementing a length limit for a
//!   framing whose length the client may lie about anyway.
//! * **No pipelining, no keep-alive**: every response is `Connection: close`. A
//!   container that serves one client does not benefit from connection reuse, and
//!   the ambiguity is one less thing to get wrong.
//! * **Disconnect is cancellation**: while an encode runs, a reader thread
//!   watches the socket; EOF sets the cancel token, so FFmpeg is killed instead
//!   of running to its deadline for a caller that has gone away.
//!
//! Concurrency is bounded twice: at most [`MAX_CONNECTIONS`] accepted sockets,
//! and exactly [`MAX_CONCURRENT_ENCODES`] encoding encodes. The second is a gate,
//! not a queue — a second caller gets `429 busy` immediately, which is a
//! truthful answer for a container whose CPU budget is one encode wide.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::encode::{EncodedOutput, Encoder};
use crate::error::{ErrorCode, ProcessorError, Result};
use crate::preset::lookup;
use crate::process::CancelToken;
use crate::protocol::{
    Limits, DRAIN_GRACE_MS, DRAIN_MAX_BYTES, MAX_ATTEMPT_ID_LEN, MAX_CONCURRENT_ENCODES,
    MAX_CONNECTIONS, MAX_INPUT_BYTES, MAX_REQUEST_HEAD_BYTES,
};
use crate::{error_document, health_document};

/// Process-wide shutdown, owned by the signal handler and consulted by every
/// request path.
///
/// Two halves, because "the container stopped" has to mean two things:
///
/// * [`Shutdown::flag`] stops the accept loop. Nothing in-flight depends on it.
/// * [`ShutdownSignal::register`] hands every in-flight encode its [`CancelToken`], so
///   [`ShutdownSignal::cancel_all`] can stop FFmpeg in the middle of a 120-second
///   encode. Checking only the flag would leave a stopping container paying for
///   a full CPU encode whose response nobody will ever read — the exact waste a
///   SIGTERM handler exists to avoid.
#[derive(Clone)]
pub struct ShutdownSignal {
    flag: Arc<AtomicBool>,
    in_flight: Arc<Mutex<Vec<CancelToken>>>,
}

impl ShutdownSignal {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            in_flight: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn flag(&self) -> &Arc<AtomicBool> {
        &self.flag
    }

    pub fn is_requested(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Cancel every registered encode. Safe to call more than once, and safe to
    /// call while requests are starting.
    pub fn cancel_all(&self) {
        if let Ok(registered) = self.in_flight.lock() {
            for token in registered.iter() {
                token.cancel();
            }
        }
    }

    /// Register an encode's cancel token for the lifetime of the returned guard.
    pub fn register(&self, cancel: &CancelToken) -> Registration {
        if let Ok(mut registered) = self.in_flight.lock() {
            registered.push(cancel.clone());
        }
        Registration {
            owner: self.in_flight.clone(),
            cancel: cancel.clone(),
        }
    }
}

impl Default for ShutdownSignal {
    fn default() -> Self {
        Self::new()
    }
}

/// Removes a token from the shutdown registry when dropped, so a long-lived
/// container's registry does not grow one entry per request ever served.
pub struct Registration {
    owner: Arc<Mutex<Vec<CancelToken>>>,
    cancel: CancelToken,
}

impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut registered) = self.owner.lock() {
            registered.retain(|token| token != &self.cancel);
        }
    }
}

/// What the server needs from the outside world. Everything else is internal.
#[derive(Clone)]
pub struct ServerConfig {
    /// Consulted before an encode starts, during the poll loop (through the
    /// registered cancel tokens) and once more before the response is written.
    pub shutdown: ShutdownSignal,
    /// The one encode slot, shared by every connection this server accepts.
    ///
    /// Owned per server rather than per connection or per process: the limit is
    /// a property of the container, so it must be shared by all of that
    /// container's connections — and per-server is also what lets a test binary
    /// run two "containers" in one process without one starving the other.
    /// `try_lock` rather than `lock`: a second caller must learn immediately that
    /// the container is busy, because waiting would mean queueing two encodes
    /// against a one-encode CPU budget, and the queued one would burn its own
    /// deadline waiting for a slot it could never have used.
    pub encode_slot: Arc<Mutex<()>>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            shutdown: ShutdownSignal::new(),
            encode_slot: Arc::new(Mutex::new(())),
        }
    }
}

/// A parsed request line and header block.
#[derive(Debug, Clone)]
pub struct RequestHead {
    pub method: String,
    pub target: String,
    pub headers: BTreeMap<String, String>,
}

impl RequestHead {
    /// Header lookup, case-insensitive. Keys are stored lowercased at parse time.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    /// Whether a header is present at all, regardless of value.
    pub fn has_header(&self, name: &str) -> bool {
        self.headers.contains_key(&name.to_ascii_lowercase())
    }
}

/// Read one request head, bounded in bytes and in line count.
pub fn read_head(reader: &mut impl BufRead) -> Result<RequestHead> {
    let mut bytes = 0_usize;
    let mut lines = 0_usize;
    let mut request_line = None;
    let mut headers = BTreeMap::new();

    loop {
        let mut line = String::new();
        let read = read_line_bounded(reader, &mut line, MAX_REQUEST_HEAD_BYTES - bytes)?;
        bytes += read;
        if read == 0 {
            return Err(ProcessorError::new(ErrorCode::Internal)
                .with_detail("eof before the request head ended"));
        }
        lines += 1;
        if lines > 100 {
            return Err(
                ProcessorError::new(ErrorCode::Internal).with_detail("more than 100 header lines")
            );
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if request_line.is_none() {
            let mut parts = trimmed.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let target = parts.next().unwrap_or_default().to_string();
            if method.is_empty() || target.is_empty() {
                return Err(
                    ProcessorError::new(ErrorCode::Internal).with_detail("malformed request line")
                );
            }
            request_line = Some((method, target));
            continue;
        }
        // Other duplicate headers keep the first value. Two `Content-Length`s or two
        // `Transfer-Encoding`s are a request-smuggling shape, not a preference,
        // and answering with a guess about which one the client meant is how a
        // proxy and a server start to disagree about a body's length.
        let Some((name, value)) = trimmed.split_once(':') else {
            return Err(
                ProcessorError::new(ErrorCode::Internal).with_detail("malformed header line")
            );
        };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(ProcessorError::new(ErrorCode::Internal).with_detail("empty header name"));
        }
        if matches!(name.as_str(), "content-length" | "transfer-encoding")
            && headers.contains_key(&name)
        {
            return Err(ProcessorError::new(ErrorCode::UnsupportedTransferEncoding)
                .with_detail(format!("repeated {name}")));
        }
        headers
            .entry(name)
            .or_insert_with(|| value.trim().to_string());
    }

    let (method, target) = request_line.ok_or_else(|| {
        ProcessorError::new(ErrorCode::Internal).with_detail("missing request line")
    })?;
    Ok(RequestHead {
        method,
        target,
        headers,
    })
}

/// Read one CRLF-terminated line, refusing to exceed the remaining byte budget.
fn read_line_bounded(reader: &mut impl BufRead, out: &mut String, budget: usize) -> Result<usize> {
    let mut raw = Vec::new();
    let mut byte = [0_u8; 1];
    // Byte-at-a-time on the head only: it is at most 16 KiB and arrives once per
    // connection, and it keeps the "no unbounded line" property obvious rather
    // than dependent on a reader's default limit.
    loop {
        let read = reader.read(&mut byte)?;
        if read == 0 {
            break;
        }
        raw.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
        if raw.len() >= budget.max(1) {
            return Err(ProcessorError::new(ErrorCode::PayloadTooLarge)
                .with_detail("request head exceeded its byte budget"));
        }
    }
    let text = String::from_utf8_lossy(&raw).into_owned();
    *out = text;
    Ok(raw.len())
}

/// Validate an `x-attempt-id`: present, bounded, and printable.
///
/// The id is echoed into response headers and into log lines, so a value carrying
/// CR, LF or non-ASCII would let a caller inject a header or a log record. That
/// is why the charset is `[A-Za-z0-9._-]` rather than "whatever the job table
/// happens to hold".
pub fn validate_attempt_id(value: Option<&str>) -> Result<String> {
    let value = value.ok_or_else(|| {
        ProcessorError::new(ErrorCode::InvalidAttemptId).with_detail("header absent")
    })?;
    if value.is_empty() || value.len() > MAX_ATTEMPT_ID_LEN {
        return Err(ProcessorError::new(ErrorCode::InvalidAttemptId)
            .with_detail(format!("length {}", value.len())));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(ProcessorError::new(ErrorCode::InvalidAttemptId)
            .with_detail("character outside [A-Za-z0-9._-]"));
    }
    Ok(value.to_string())
}

/// Read exactly `length` bytes, refusing more than the input ceiling.
pub fn read_body(reader: &mut impl BufRead, length: u64) -> Result<Vec<u8>> {
    if length > Limits::CURRENT.max_input_bytes {
        return Err(ProcessorError::new(ErrorCode::PayloadTooLarge)
            .with_detail(format!("content-length {length} > {MAX_INPUT_BYTES}")));
    }
    let length = usize::try_from(length).map_err(|_| {
        ProcessorError::new(ErrorCode::PayloadTooLarge).with_detail("length is not addressable")
    })?;
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .map_err(|error| ProcessorError::from(error).with_detail("short body"))?;
    Ok(body)
}

/// The server: a bound listener, an encoder, and one encode gate.
pub struct Server {
    listener: TcpListener,
    encoder: Arc<Encoder>,
    release: String,
    config: ServerConfig,
    connections: Arc<AtomicU32>,
}

impl Server {
    /// Bind, or fail loudly on a taken port. Binding to port 0 and printing the
    /// wrong port is how a test ends up "passing" against nothing.
    pub fn bind(
        address: &str,
        encoder: Arc<Encoder>,
        release: String,
        config: ServerConfig,
    ) -> Result<Self> {
        let listener = TcpListener::bind(address).map_err(|error| {
            ProcessorError::new(ErrorCode::Internal).with_detail(format!("bind {address}: {error}"))
        })?;
        // Non-blocking, so the accept loop observes the shutdown flag even with
        // no traffic. A blocking `incoming()` would park in `accept` and only
        // notice a signal when the next connection arrived — which for an idle
        // container is never, and turns a bounded shutdown into a SIGKILL.
        listener.set_nonblocking(true).map_err(|error| {
            ProcessorError::new(ErrorCode::Internal).with_detail(error.to_string())
        })?;
        Ok(Self {
            listener,
            encoder,
            release,
            config,
            connections: Arc::new(AtomicU32::new(0)),
        })
    }

    /// Wait until every accepted connection has finished, or the budget expires.
    ///
    /// A shutdown that returned while an encode was still unwinding would exit the
    /// process before its temp directory was removed — the SIGTERM promise this
    /// crate makes in its README. The budget is what keeps that from becoming an
    /// unbounded wait when a child refuses to die.
    pub fn wait_for_idle(&self, budget: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + budget;
        while std::time::Instant::now() < deadline {
            if self.connections.load(Ordering::SeqCst) == 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        self.connections.load(Ordering::SeqCst) == 0
    }

    /// The address actually bound, for a caller that asked for port 0.
    pub fn local_addr(&self) -> Result<SocketAddr> {
        self.listener.local_addr().map_err(|error| {
            ProcessorError::new(ErrorCode::Internal).with_detail(error.to_string())
        })
    }

    /// Serve until the shutdown flag is set.
    ///
    /// In-flight encodes are bounded by their own deadlines and cancelled by
    /// [`ShutdownSignal::cancel_all`]; the accept loop is not what ends them.
    pub fn serve(&self) -> Result<()> {
        while !self.config.shutdown.is_requested() {
            let stream = match self.listener.accept() {
                Ok((stream, _)) => stream,
                // Nothing to accept yet: the poll interval below is the cost.
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                    continue;
                }
                // A single failed accept — a client that vanished between SYN and
                // accept — must not end the server.
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => {
                    eprintln!("accept: {error}");
                    continue;
                }
            };
            let previous = self.connections.fetch_add(1, Ordering::SeqCst);
            if previous >= MAX_CONNECTIONS {
                self.connections.fetch_sub(1, Ordering::SeqCst);
                // Answer rather than drop: a silent close looks like a network
                // fault to the Durable Object on the other side.
                let _ = reject_connection(stream, "connection limit reached");
                continue;
            }
            let encoder = self.encoder.clone();
            let release = self.release.clone();
            let shutdown = self.config.shutdown.clone();
            let slot = self.config.encode_slot.clone();
            let connections = self.connections.clone();
            thread::spawn(move || {
                handle_connection(stream, &encoder, &release, &shutdown, slot);
                connections.fetch_sub(1, Ordering::SeqCst);
            });
        }
        Ok(())
    }
}

/// Handle one connection: parse, route, respond.
fn handle_connection(
    stream: TcpStream,
    encoder: &Encoder,
    release: &str,
    shutdown: &ShutdownSignal,
    slot: Arc<Mutex<()>>,
) {
    if stream.set_nonblocking(false).is_err()
        || stream
            .set_read_timeout(Some(Duration::from_millis(30_000)))
            .is_err()
    {
        return;
    }
    let _ = stream.set_nodelay(true);
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let Ok(watch_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut writer = write_half;

    let head = match read_head(&mut reader) {
        Ok(head) => head,
        Err(error) => {
            let _ = write_error(&mut writer, &error);
            let _ = TcpStream::shutdown(&writer, std::net::Shutdown::Write);
            let _ = drain_and_discard(&mut reader);
            return;
        }
    };

    let route = head.target.split('?').next().unwrap_or("").to_string();
    let response = match (head.method.as_str(), route.as_str()) {
        ("GET", "/health") => health_response(encoder, release),
        ("POST", "/encode") => {
            encode_response(&mut reader, watch_half, &head, encoder, shutdown, &slot)
        }
        _ => Err(ProcessorError::new(ErrorCode::NotFound)
            .with_detail(format!("{} {route}", head.method))),
    };

    match response {
        Ok(Response::Head {
            status,
            headers,
            body,
        }) => {
            let _ = write_response(&mut writer, status, &headers, &body);
        }
        Ok(Response::Stream {
            status,
            headers,
            output,
        }) => {
            if let Err(error) =
                write_stream_head(&mut writer, status, &headers, output.success.output_bytes)
            {
                eprintln!("encode: response head was not delivered: {error}");
                return;
            }
            if let Err(error) = output.copy_to(&mut writer) {
                // The bytes were produced and validated; the caller went away.
                // Truthful either way: this line says delivery failed, and the
                // job's own record decides retry policy.
                eprintln!(
                    "encode: output delivery failed after {} of {} bytes: {error}",
                    output.success.output_bytes, output.success.output_bytes
                );
            }
            let _ = writer.flush();
        }
        Err(error) => {
            let _ = write_error(&mut writer, &error);
        }
    }
    // Close the connection the way a client can actually read the response.
    //
    // A refusal sent before the body was read — no preset, a wrong protocol, an
    // oversized upload — leaves the peer still sending. Closing on top of unread
    // bytes makes the kernel send RST, and the client loses the response it was
    // owed: `curl` reported "connection reset by peer" with an empty body and no
    // status code. So: shut down the write side to deliver what was written,
    // then drain what the client is still sending, bounded in both time and
    // bytes, and only then drop the socket.
    let _ = TcpStream::shutdown(&writer, std::net::Shutdown::Write);
    let _ = drain_and_discard(&mut reader);
}

/// A response, either fully buffered or streaming a validated file.
enum Response {
    Head {
        status: u16,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    },
    Stream {
        status: u16,
        headers: BTreeMap<String, String>,
        output: EncodedOutput,
    },
}

/// `GET /health`: what this build is, and what it will refuse.
///
/// Liveness only. It does not encode and it does not probe FFmpeg: a poll that
/// spends CPU inside FFmpeg is a load generator, not a health check. The encode
/// path is what proves the tools are present, and it fails truthfully if they are
/// not.
fn health_response(encoder: &Encoder, release: &str) -> Result<Response> {
    let document = health_document(release, &crate::preset::DEMO_180P_V1);
    let body = serde_json::to_vec_pretty(&document)
        .map_err(|error| ProcessorError::new(ErrorCode::Internal).with_detail(error.to_string()))?;
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    headers.insert("cache-control".to_string(), "no-store".to_string());
    // Name the tool this process would spawn, so an operator can tell a wrong
    // PATH from a missing binary without spending an encode to find out.
    headers.insert(
        "x-media-ffmpeg".to_string(),
        encoder.tools().ffmpeg.display().to_string(),
    );
    Ok(Response::Head {
        status: 200,
        headers,
        body,
    })
}

/// `POST /encode`: the whole bounded path.
fn encode_response(
    reader: &mut impl BufRead,
    watch_half: TcpStream,
    head: &RequestHead,
    encoder: &Encoder,
    shutdown: &ShutdownSignal,
    shutdown_slot: &Mutex<()>,
) -> Result<Response> {
    // Refusals happen in this order: framing, then metadata, then body size, then
    // the gate, then work. Each step is cheaper than the next, and the gate is
    // held only for a request that is otherwise admissible.
    if head.has_header("transfer-encoding") {
        return Err(
            ProcessorError::new(ErrorCode::UnsupportedTransferEncoding).with_detail(format!(
                "transfer-encoding: {}",
                head.header("transfer-encoding").unwrap_or("")
            )),
        );
    }
    let content_length: u64 = match head.header("content-length") {
        Some(value) => value.parse().map_err(|_| {
            ProcessorError::new(ErrorCode::PayloadTooLarge)
                .with_detail("unparseable content-length")
        })?,
        None => {
            return Err(ProcessorError::new(ErrorCode::UnsupportedTransferEncoding)
                .with_detail("no content-length"))
        }
    };
    if content_length > Limits::CURRENT.max_input_bytes {
        return Err(ProcessorError::new(ErrorCode::PayloadTooLarge)
            .with_detail(format!("content-length {content_length}")));
    }
    let attempt_id = validate_attempt_id(head.header(crate::protocol::HEADER_ATTEMPT))?;

    // Absent means "the protocol this build implements": an omitted header is
    // not a way to skip the version check, and a present but different value is
    // refused rather than best-effort.
    if let Some(protocol) = head.header(crate::protocol::HEADER_PROTOCOL) {
        if protocol != crate::protocol::PROTOCOL_ID {
            return Err(ProcessorError::new(ErrorCode::ProtocolMismatch)
                .with_detail(format!("requested: {protocol}")));
        }
    }
    let preset_id = head.header(crate::protocol::HEADER_PRESET).ok_or_else(|| {
        ProcessorError::new(ErrorCode::UnsupportedPreset).with_detail("header absent")
    })?;
    let preset = lookup(preset_id)?;

    let body = read_body(reader, content_length)?;
    let cancel = CancelToken::new();
    // Register before checking the flag: either shutdown sees this token or
    // this request sees shutdown. Keep the guard through the entire encode.
    let _registration = shutdown.register(&cancel);

    if shutdown.is_requested() {
        return Err(ProcessorError::new(ErrorCode::Cancelled)
            .with_detail("shutdown requested before the encode"));
    }

    // The gate is taken before the disconnect watcher and the encode, and
    // released by this scope whatever happens next.
    let _slot = shutdown_slot.try_lock().map_err(|_| {
        ProcessorError::new(ErrorCode::Busy)
            .with_detail(format!("{} in flight", MAX_CONCURRENT_ENCODES))
    })?;

    let watcher = DisconnectWatcher::spawn(watch_half, cancel.clone());
    let result = encoder.encode_from_bytes(&body, preset, &attempt_id, cancel.clone());
    // Ending the watcher before releasing the slot: the encode is over, so the
    // socket is no longer interesting, and the watcher thread must not outlive
    // the request that started it.
    watcher.finish();
    drop(_slot);

    if shutdown.is_requested() {
        return Err(ProcessorError::new(ErrorCode::Cancelled)
            .with_detail("shutdown requested during the encode"));
    }
    let output = result?;

    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), "video/mp4".to_string());
    headers.insert("cache-control".to_string(), "no-store".to_string());
    // No `content-length` in this map on purpose. `write_stream_head` writes the
    // length from `output.success.output_bytes`; adding it here too produced two
    // `content-length` lines on the wire, and a client is entitled to prefer the
    // first — which would mean trusting a value this crate did not measure.
    for (name, value) in crate::probe::output_headers(&output.success) {
        headers.insert(name.to_string(), value);
    }
    Ok(Response::Stream {
        status: 200,
        headers,
        output,
    })
}

/// Read and throw away whatever the peer is still sending, within bounds.
///
/// Bounded twice, because an unbounded drain is just a slower way to hang: by
/// wall-clock budget, and by total bytes. A client that keeps sending after the
/// budget gets its socket closed, which is the correct outcome for a request
/// this server has already refused.
fn drain_and_discard(reader: &mut BufReader<TcpStream>) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_millis(DRAIN_GRACE_MS);
    let mut discarded: u64 = 0;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() || discarded >= DRAIN_MAX_BYTES {
            return Ok(());
        }
        reader.get_ref().set_read_timeout(Some(remaining))?;
        let limit = buffer.len().min((DRAIN_MAX_BYTES - discarded) as usize);
        match reader.read(&mut buffer[..limit]) {
            Ok(0) => return Ok(()),
            Ok(read) => discarded += read as u64,
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) =>
            {
                return Ok(())
            }
            Err(error) => return Err(ProcessorError::from(error)),
        }
    }
}

/// Watches the client socket for EOF while an encode runs.
///
/// A container billed per request that keeps encoding for a caller that
/// disconnected is the failure this prevents: the deadline would eventually stop
/// it, but at full CPU cost, and nothing in the response would ever be read.
struct DisconnectWatcher {
    cancel: CancelToken,
    handle: Option<thread::JoinHandle<()>>,
}

impl DisconnectWatcher {
    fn spawn(mut stream: TcpStream, cancel: CancelToken) -> Self {
        let watcher_cancel = cancel.clone();
        let handle = thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
            let mut byte = [0_u8; 1];
            loop {
                if watcher_cancel.is_cancelled() {
                    return;
                }
                match stream.read(&mut byte) {
                    // Clean end of stream: the client closed or half-closed.
                    Ok(0) => {
                        watcher_cancel.cancel();
                        return;
                    }
                    // Data after the request body is not expected; ignore it and
                    // keep watching, because the point is the socket's state.
                    Ok(_) => {}
                    Err(error)
                        if matches!(
                            error.kind(),
                            ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                        ) => {}
                    Err(_) => {
                        // A reset is a disconnect too.
                        watcher_cancel.cancel();
                        return;
                    }
                }
            }
        });
        Self {
            cancel,
            handle: Some(handle),
        }
    }

    /// Stop watching and join the thread.
    ///
    /// The token is set first so the watcher's next poll returns. By this point
    /// the encode has already returned, so this cannot affect an encode: it
    /// exists so a client that keeps its connection open does not leave a thread
    /// polling the socket until the deadline.
    fn finish(mut self) {
        self.cancel.cancel();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Refuse a connection at the accept limit, so the client sees a status rather
/// than a dropped socket.
fn reject_connection(mut stream: TcpStream, reason_text: &str) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    let result = write_error(
        &mut stream,
        &ProcessorError::new(ErrorCode::Busy).with_detail(reason_text),
    );
    let _ = TcpStream::shutdown(&stream, std::net::Shutdown::Write);
    let _ = drain_and_discard(&mut BufReader::new(stream));
    result
}

/// Serialize an error into a response. Only [`error_document`] fields travel:
/// the operator-facing detail cannot reach the wire.
fn write_error(writer: &mut impl Write, error: &ProcessorError) -> std::io::Result<()> {
    let document = error_document(error);
    let payload = serde_json::to_vec(&document).unwrap_or_else(|_| {
        b"{\"error\":{\"code\":\"internal_error\",\"message\":\"internal processor error\",\"retryable\":false}}"
            .to_vec()
    });
    let headers = BTreeMap::from([
        ("content-type".to_string(), "application/json".to_string()),
        // An error is never cacheable: a 429 replayed from a cache is a lie.
        ("cache-control".to_string(), "no-store".to_string()),
    ]);
    write_response(writer, error.code().http_status(), &headers, &payload)
}

fn write_response(
    writer: &mut impl Write,
    status: u16,
    headers: &BTreeMap<String, String>,
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    head.push_str(&format!("content-length: {}\r\n", body.len()));
    for (name, value) in headers {
        // Values here are fixed literals or values that passed
        // `validate_attempt_id`, so none can contain CR or LF.
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("connection: close\r\n\r\n");
    writer.write_all(head.as_bytes())?;
    writer.write_all(body)?;
    writer.flush()
}

fn write_stream_head(
    writer: &mut impl Write,
    status: u16,
    headers: &BTreeMap<String, String>,
    length: u64,
) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    head.push_str(&format!("content-length: {length}\r\n"));
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("connection: close\r\n\r\n");
    writer.write_all(head.as_bytes())?;
    writer.flush()
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn head_text(lines: &[&str]) -> Cursor<Vec<u8>> {
        // The trailing empty line is the blank line that ends the head, so the
        // join must add a CRLF after it too.
        Cursor::new(format!("{}\r\n", lines.join("\r\n")).into_bytes())
    }

    fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        (client, listener.accept().unwrap().0)
    }

    #[test]
    fn draining_an_idle_peer_ends_within_the_grace_period() {
        let (_client, server) = socket_pair();
        server
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        let started = std::time::Instant::now();
        drain_and_discard(&mut BufReader::new(server)).unwrap();
        assert!(started.elapsed() < Duration::from_millis(DRAIN_GRACE_MS + 1000));
    }

    #[test]
    fn connection_limit_refusal_uses_the_canonical_busy_response() {
        let (mut client, server) = socket_pair();
        client
            .write_all(b"POST /encode HTTP/1.1\r\ncontent-length: 4\r\n\r\ndata")
            .unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        reject_connection(server, "private connection limit detail").unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        let (status, headers, body) = crate::harness::parse_response(&response);
        assert_eq!(status, ErrorCode::Busy.http_status());
        assert_eq!(
            crate::harness::header(&headers, "cache-control"),
            Some("no-store")
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::to_value(error_document(&ProcessorError::new(ErrorCode::Busy))).unwrap()
        );
    }

    #[test]
    fn a_head_is_parsed_case_insensitively_and_ordinary_duplicates_keep_the_first() {
        let mut reader = head_text(&[
            "POST /encode HTTP/1.1",
            "X-Preset: demo-180p-v1",
            "x-preset: ignored",
            "Content-Length: 12",
            "",
        ]);
        let head = read_head(&mut reader).expect("head");
        assert_eq!(head.method, "POST");
        assert_eq!(head.target, "/encode");
        assert_eq!(head.header("x-preset"), Some("demo-180p-v1"));
        assert_eq!(head.header("content-length"), Some("12"));
    }

    #[test]
    fn repeated_framing_headers_are_refused_even_when_values_agree() {
        for (first, second) in [
            ("content-length: 12", "Content-Length: 99999"),
            ("Content-Length: 12", "content-length: 12"),
            ("transfer-encoding: chunked", "Transfer-Encoding: identity"),
            ("Transfer-Encoding: chunked", "transfer-encoding: chunked"),
        ] {
            let mut reader = head_text(&["POST /encode HTTP/1.1", first, second, ""]);
            assert_eq!(
                read_head(&mut reader).unwrap_err().code().http_status(),
                400
            );
        }
    }

    #[test]
    fn an_unterminated_or_oversized_head_is_refused_rather_than_buffered_forever() {
        // A client that opens a connection and never sends a blank line must not
        // be able to grow this process's head buffer.
        let mut endless = Cursor::new(vec![b'x'; crate::protocol::MAX_REQUEST_HEAD_BYTES + 1024]);
        let error = read_head(&mut endless).unwrap_err();
        assert_eq!(error.code(), ErrorCode::PayloadTooLarge);
        assert!(error.detail().unwrap().contains("byte budget"));

        // And a head that simply stops mid-line is an EOF, not a partial parse.
        let mut truncated = Cursor::new(b"POST /encode HTTP/1.1\r\nx-a: ".to_vec());
        let error = read_head(&mut truncated).unwrap_err();
        assert!(
            error
                .detail()
                .unwrap()
                .contains("eof before the request head ended"),
            "{error}"
        );
    }

    #[test]
    fn a_body_longer_than_the_ceiling_is_refused_before_it_is_read() {
        let mut reader = Cursor::new(Vec::new());
        let error = read_body(&mut reader, MAX_INPUT_BYTES + 1).unwrap_err();
        assert_eq!(error.code(), ErrorCode::PayloadTooLarge);
    }

    #[test]
    fn attempt_ids_that_could_inject_a_header_or_log_line_are_refused() {
        assert!(validate_attempt_id(Some("attempt-1")).is_ok());
        for hostile in [
            "attempt 1",
            "attempt\nX-Evil: 1",
            "attempt/../1",
            "attémpt",
            "",
        ] {
            let error = validate_attempt_id(Some(hostile)).unwrap_err();
            assert_eq!(
                error.code(),
                ErrorCode::InvalidAttemptId,
                "{hostile:?} was accepted"
            );
        }
        assert_eq!(
            validate_attempt_id(None).unwrap_err().code(),
            ErrorCode::InvalidAttemptId
        );
        assert_eq!(
            validate_attempt_id(Some(&"a".repeat(MAX_ATTEMPT_ID_LEN + 1)))
                .unwrap_err()
                .code(),
            ErrorCode::InvalidAttemptId
        );
        assert_eq!(MAX_ATTEMPT_ID_LEN, 128);
    }

    #[test]
    fn a_short_body_is_an_error_not_a_silent_truncation() {
        let mut reader = Cursor::new(b"abc".to_vec());
        let error = read_body(&mut reader, 10).unwrap_err();
        assert!(error.detail().unwrap().contains("short body"));
    }
}
