//! The HTTP surface, against a real server, real FFmpeg and real sockets.
//!
//! Each test starts its own server on port 0 and talks to it over a TCP socket,
//! so what is exercised is the same code a Cloudflare Container's Durable Object
//! client exercises: request bytes in, response bytes out, headers parsed the
//! way a caller parses them.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use starter_media::encode::{Encoder, Tools};
use starter_media::harness;
use starter_media::http::{Server, ServerConfig};
use starter_media::preset::DEMO_180P_V1;
use starter_media::protocol::{
    HEADER_ATTEMPT, HEADER_OUTPUT_CODEC, HEADER_OUTPUT_DIMENSIONS, HEADER_OUTPUT_DURATION_MS,
    HEADER_OUTPUT_SHA256, HEADER_PRESET, HEADER_PROTOCOL, MAX_INPUT_BYTES,
};

/// A running server on an ephemeral port, with the temp root it was given.
struct RunningServer {
    address: String,
    scratch: PathBuf,
    shutdown: starter_media::http::ShutdownSignal,
    port: u16,
}

impl RunningServer {
    fn start(name: &str, ffmpeg: Option<&Path>) -> Self {
        let scratch = harness::scratch_dir(name);
        let encoder = Encoder::with_runner(
            Tools {
                ffmpeg: ffmpeg
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| harness::require(&harness::ffmpeg())),
                ffprobe: harness::require(&harness::ffprobe()),
            },
            Arc::new(starter_media::process::SystemProcessRunner::new(
                starter_media::clock::system_clock(),
            )),
        )
        .with_temp_root(&scratch);
        let shutdown = starter_media::http::ShutdownSignal::new();
        let server = Server::bind(
            "127.0.0.1:0",
            Arc::new(encoder),
            "test-release".to_string(),
            ServerConfig {
                shutdown: shutdown.clone(),
                ..ServerConfig::default()
            },
        )
        .expect("bind an ephemeral port");
        let address = server.local_addr().expect("address").to_string();
        let port = server.local_addr().expect("address").port();
        std::thread::spawn(move || {
            let _ = server.serve();
        });
        // The listener is already bound before `serve` runs, so a connect cannot
        // race the bind; waiting for a successful connect makes the failure mode
        // of a broken server an obvious refusal instead of a flake.
        assert!(
            harness::wait_until(|| std::net::TcpStream::connect(&address).is_ok(), 2_000),
            "server never accepted a connection on {address}"
        );
        Self {
            address,
            scratch,
            shutdown,
            port,
        }
    }

    fn get(&self, path: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let request = format!("GET {path} HTTP/1.1\r\nhost: localhost\r\n\r\n").into_bytes();
        let raw = harness::http_raw(&self.address, &request, true).expect("request");
        harness::parse_response(&raw)
    }

    fn post(&self, body: &[u8], headers: &[(&str, &str)]) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut head = format!(
            "POST /encode HTTP/1.1\r\nhost: localhost\r\ncontent-length: {}\r\n",
            body.len()
        );
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        let mut request = head.into_bytes();
        request.extend_from_slice(body);
        let raw = harness::http_raw(&self.address, &request, true).expect("request");
        harness::parse_response(&raw)
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        self.shutdown.is_requested();
        // Ask the accept loop to stop, then clean the scratch root. The server
        // thread exits on its own; the test does not join it, because the test is
        // about the request, and this binary is about to exit anyway.
        self.shutdown.cancel_all();
        std::fs::remove_dir_all(&self.scratch).ok();
    }
}

fn encode_headers(attempt: &str) -> Vec<(&'static str, &str)> {
    vec![
        (HEADER_PROTOCOL, "sample-v1"),
        (HEADER_PRESET, "demo-180p-v1"),
        (HEADER_ATTEMPT, attempt),
    ]
}

#[test]
fn health_reports_the_release_protocol_preset_and_the_bounds_it_enforces() {
    let server = RunningServer::start("http-health", None);
    let (status, headers, body) = server.get("/health");
    assert_eq!(status, 200);
    assert_eq!(
        harness::header(&headers, "content-type"),
        Some("application/json")
    );

    let document: starter_media::protocol::HealthDocument =
        serde_json::from_slice(&body).expect("health is the declared shape");
    assert_eq!(document.release, "test-release");
    assert_eq!(document.protocol, "sample-v1");
    assert_eq!(document.fixture, "sample-v1");
    assert_eq!(document.presets.len(), 1);
    assert_eq!(document.presets[0].id, "demo-180p-v1");
    assert_eq!(document.presets[0].width, 320);
    assert_eq!(document.presets[0].height, 180);
    assert_eq!(document.limits.max_input_bytes, MAX_INPUT_BYTES);
    assert_eq!(
        document.limits.max_output_bytes,
        starter_media::protocol::MAX_OUTPUT_BYTES
    );
    assert_eq!(document.limits.encode_deadline_ms, 120_000);
    assert_eq!(document.limits.max_encode_threads, 2);
    assert_eq!(document.limits.max_concurrent_encodes, 1);

    // The FFmpeg this process would spawn is named, so a wrong PATH is visible
    // without spending an encode.
    assert!(harness::header(&headers, "x-media-ffmpeg").is_some());
}

#[test]
fn a_successful_encode_returns_real_bytes_a_second_ffprobe_accepts() {
    let server = RunningServer::start("http-encode-success", None);
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");

    let started = Instant::now();
    let (status, headers, body) = server.post(&input, &encode_headers("attempt-http-1"));
    assert_eq!(status, 200, "body was {}", String::from_utf8_lossy(&body));
    assert_eq!(harness::header(&headers, "content-type"), Some("video/mp4"));
    assert_eq!(
        harness::header(&headers, HEADER_PROTOCOL),
        Some("sample-v1")
    );
    assert_eq!(
        harness::header(&headers, HEADER_ATTEMPT),
        Some("attempt-http-1")
    );
    assert_eq!(harness::header(&headers, HEADER_OUTPUT_CODEC), Some("h264"));
    assert_eq!(
        harness::header(&headers, HEADER_OUTPUT_DIMENSIONS),
        Some("320x180")
    );
    let duration_ms: u64 = harness::header(&headers, HEADER_OUTPUT_DURATION_MS)
        .expect("duration header")
        .parse()
        .expect("numeric duration");
    assert!(
        (DEMO_180P_V1.min_duration_ms..=DEMO_180P_V1.max_duration_ms).contains(&duration_ms),
        "duration {duration_ms}ms"
    );

    // The declared length is the body that arrived.
    let declared: usize = harness::header(&headers, "content-length")
        .expect("content-length")
        .parse()
        .expect("numeric length");
    assert_eq!(declared, body.len());
    assert!(
        body.len() > 1_000,
        "an encode of three seconds is not empty"
    );
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "an encode took too long"
    );

    // Write the exact response bytes to disk and let a *separate* FFprobe
    // process, invoked here in the test, judge the file.
    let scratch = harness::scratch_dir("http-encode-output");
    let path = scratch.join("response.mp4");
    std::fs::write(&path, &body).expect("write");
    let summary = starter_media::probe::validate(
        &path,
        &DEMO_180P_V1,
        &starter_media::process::SystemProcessRunner::new(starter_media::clock::system_clock()),
        &harness::require(&harness::ffprobe()),
    )
    .expect("the bytes this server sent are a valid MP4");
    assert_eq!(summary.video_codec, "h264");
    assert_eq!((summary.width, summary.height), (320, 180));

    // The advertised hash is the hash of the bytes that were sent.
    let hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut hasher = hasher;
    sha2::Digest::update(&mut hasher, &body);
    let hex: String = sha2::Digest::finalize(hasher)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        harness::header(&headers, HEADER_OUTPUT_SHA256),
        Some(hex.as_str())
    );
    assert_ne!(
        &body[..],
        &input[..],
        "the response is not the input echoed"
    );
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn a_refused_request_answers_with_a_code_and_no_subprocess_output() {
    let server = RunningServer::start("http-refusals", None);
    /// name, body, headers, expected status, expected wire code
    type Refusal = (
        &'static str,
        Vec<u8>,
        Vec<(&'static str, &'static str)>,
        u16,
        &'static str,
    );
    let cases: Vec<Refusal> = vec![
        (
            "no preset",
            b"not media".to_vec(),
            vec![(HEADER_ATTEMPT, "attempt-1")],
            400,
            "unsupported_preset",
        ),
        (
            "unknown preset",
            b"not media".to_vec(),
            vec![(HEADER_ATTEMPT, "attempt-1"), (HEADER_PRESET, "demo-4k-v1")],
            400,
            "unsupported_preset",
        ),
        (
            "wrong protocol",
            b"not media".to_vec(),
            vec![
                (HEADER_ATTEMPT, "attempt-1"),
                (HEADER_PROTOCOL, "sample-v2"),
            ],
            400,
            "protocol_mismatch",
        ),
        (
            "missing attempt id",
            b"not media".to_vec(),
            vec![(HEADER_PRESET, "demo-180p-v1")],
            400,
            "invalid_attempt_id",
        ),
        (
            "hostile attempt id",
            b"not media".to_vec(),
            vec![(HEADER_ATTEMPT, "attempt 1; injected")],
            400,
            "invalid_attempt_id",
        ),
        (
            "empty body",
            vec![],
            vec![
                (HEADER_ATTEMPT, "attempt-1"),
                (HEADER_PRESET, "demo-180p-v1"),
            ],
            400,
            "input_empty",
        ),
        (
            "undecodable media",
            b"this is not media".to_vec(),
            vec![
                (HEADER_ATTEMPT, "attempt-1"),
                (HEADER_PRESET, "demo-180p-v1"),
            ],
            400,
            "invalid_media",
        ),
    ];
    for (name, body, headers, expected_status, expected_code) in cases {
        let (status, response_headers, response_body) = server.post(&body, &headers);
        assert_eq!(status, expected_status, "{name}");
        assert_eq!(
            harness::header(&response_headers, "content-type"),
            Some("application/json"),
            "{name}"
        );
        let document: starter_media::protocol::ErrorDocument =
            serde_json::from_slice(&response_body)
                .expect("{name}: error body is the declared shape");
        assert_eq!(document.error.code, expected_code, "{name}");
        let rendered = String::from_utf8_lossy(&response_body).into_owned();
        assert!(
            !rendered.contains("ffmpeg"),
            "{name}: leaked tool output: {rendered}"
        );
        assert!(
            !rendered.contains("tmp"),
            "{name}: leaked a path: {rendered}"
        );
    }
}

#[test]
fn an_oversized_content_length_is_refused_before_the_body_is_read() {
    let server = RunningServer::start("http-oversized", None);
    // A declared length above the ceiling, with no body following it. The server
    // must refuse on the header alone: if it waited for bytes, this request would
    // hang instead of answering.
    let head = format!(
        "POST /encode HTTP/1.1\r\nhost: localhost\r\nx-attempt-id: attempt-big\r\nx-preset: demo-180p-v1\r\ncontent-length: {}\r\n\r\n",
        MAX_INPUT_BYTES + 1
    );
    let raw = harness::http_raw(&server.address, head.as_bytes(), true).expect("request");
    let (status, _, body) = harness::parse_response(&raw);
    assert_eq!(status, 400);
    let document: starter_media::protocol::ErrorDocument =
        serde_json::from_slice(&body).expect("json");
    assert_eq!(document.error.code, "payload_too_large");
    assert!(!document.error.retryable);
}

#[test]
fn a_chunked_body_is_refused_rather_than_buffered() {
    let server = RunningServer::start("http-chunked", None);
    let head = "POST /encode HTTP/1.1\r\nhost: localhost\r\nx-attempt-id: attempt-chunked\r\n\
                x-preset: demo-180p-v1\r\ntransfer-encoding: chunked\r\n\r\n";
    let raw = harness::http_raw(&server.address, head.as_bytes(), true).expect("request");
    let (status, _, body) = harness::parse_response(&raw);
    assert_eq!(status, 400);
    let document: starter_media::protocol::ErrorDocument =
        serde_json::from_slice(&body).expect("json");
    assert_eq!(document.error.code, "unsupported_transfer_encoding");
}

#[test]
fn an_unknown_route_is_a_404_rather_than_a_hang() {
    let server = RunningServer::start("http-unknown-route", None);
    let (status, _, _) = server.get("/admin");
    assert_eq!(status, 404);
    let request =
        b"DELETE /encode HTTP/1.1\r\nhost: localhost\r\ncontent-length: 0\r\n\r\n".to_vec();
    let raw = harness::http_raw(&server.address, &request, true).expect("request");
    let (status, _, _) = harness::parse_response(&raw);
    assert_eq!(status, 404);
    // The server is still serving after refusing.
    let (status, _, _) = server.get("/health");
    assert_eq!(status, 200);
    assert_ne!(server.port, 0);
}

#[test]
fn a_disconnect_during_an_encode_cancels_ffmpeg_and_the_server_stays_healthy() {
    // The fake FFmpeg writes a marker, then sleeps long enough that only
    // cancellation can end it. The request is sent, the socket is dropped, and
    // the assertion is that the marker file appears (so the encode really
    // started) and that the process really went away (so it was cancelled).
    let scratch = harness::scratch_dir("http-disconnect");
    let started_marker = scratch.join("ffmpeg-started");
    let fake = scratch.join("fake-ffmpeg.sh");
    let temp_root = scratch.join("temp");
    std::fs::create_dir_all(&temp_root).expect("temp root");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\nprintf started > {}\nwhile : ; do sleep 0.2; done\n",
            started_marker.display()
        ),
    )
    .expect("write the fake tool");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    let encoder = Encoder::with_runner(
        Tools {
            ffmpeg: fake.clone(),
            ffprobe: harness::require(&harness::ffprobe()),
        },
        Arc::new(starter_media::process::SystemProcessRunner::new(
            starter_media::clock::system_clock(),
        )),
    )
    .with_temp_root(&temp_root);
    let shutdown = starter_media::http::ShutdownSignal::new();
    let server = Server::bind(
        "127.0.0.1:0",
        Arc::new(encoder),
        "test-release".to_string(),
        ServerConfig {
            shutdown: shutdown.clone(),
            ..ServerConfig::default()
        },
    )
    .expect("bind");
    let address = server.local_addr().expect("address").to_string();
    let port = server.local_addr().expect("address").port();
    std::thread::spawn(move || {
        let _ = server.serve();
    });
    assert!(harness::wait_until(
        || std::net::TcpStream::connect(&address).is_ok(),
        2_000
    ));

    // Send the request, then hang up without waiting for a response.
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let head = format!(
        "POST /encode HTTP/1.1\r\nhost: localhost\r\nx-attempt-id: attempt-disconnect\r\n\
         x-preset: demo-180p-v1\r\nx-protocol: sample-v1\r\ncontent-length: {}\r\n\r\n",
        input.len()
    );
    let mut request = head.into_bytes();
    request.extend_from_slice(&input);
    // Hold the socket for long enough that the encode really starts, then hang
    // up: the request arrives, and only then does the caller disappear.
    harness::http_send_then_drop(&address, &request, 750).expect("request");

    assert!(
        harness::wait_until(|| started_marker.exists(), 10_000),
        "the fake ffmpeg never started, so nothing was cancelled"
    );
    let temp_entries = || -> Vec<PathBuf> {
        std::fs::read_dir(&temp_root)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    };
    assert!(
        harness::wait_until(|| temp_entries().is_empty(), 20_000),
        "the cancelled encode left files behind: {:?}",
        temp_entries()
    );
    // The fake tool's loop is gone: a cancelled encode killed and reaped it.
    assert!(
        harness::wait_until(
            || harness::child_pids()
                .into_iter()
                .all(|pid| !harness::process_exists(pid) || pid == std::process::id()),
            10_000
        ),
        "a subprocess outlived the cancelled request"
    );
    // And the server is still serving.
    let raw = harness::http_raw(
        &address,
        b"GET /health HTTP/1.1\r\nhost: localhost\r\n\r\n",
        true,
    )
    .expect("health after a disconnect");
    let (status, _, _) = harness::parse_response(&raw);
    assert_eq!(status, 200);
    assert_ne!(port, 0);
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn a_second_encode_is_refused_while_one_is_in_flight() {
    let scratch = harness::scratch_dir("http-single-flight");
    let started_marker = scratch.join("ffmpeg-started");
    let fake = scratch.join("fake-ffmpeg.sh");
    let temp_root = scratch.join("temp");
    std::fs::create_dir_all(&temp_root).expect("temp root");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\nprintf started > {}\nwhile : ; do sleep 0.2; done\n",
            started_marker.display()
        ),
    )
    .expect("write the fake tool");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    let encoder = Encoder::with_runner(
        Tools {
            ffmpeg: fake.clone(),
            ffprobe: harness::require(&harness::ffprobe()),
        },
        Arc::new(starter_media::process::SystemProcessRunner::new(
            starter_media::clock::system_clock(),
        )),
    )
    .with_temp_root(&temp_root);
    let shutdown = starter_media::http::ShutdownSignal::new();
    let server = Server::bind(
        "127.0.0.1:0",
        Arc::new(encoder),
        "test-release".to_string(),
        ServerConfig {
            shutdown: shutdown.clone(),
            ..ServerConfig::default()
        },
    )
    .expect("bind");
    let address = server.local_addr().expect("address").to_string();
    std::thread::spawn(move || {
        let _ = server.serve();
    });
    assert!(harness::wait_until(
        || std::net::TcpStream::connect(&address).is_ok(),
        2_000
    ));

    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let make_request = |attempt: &str| {
        let head = format!(
            "POST /encode HTTP/1.1\r\nhost: localhost\r\nx-attempt-id: {attempt}\r\n\
             x-preset: demo-180p-v1\r\nx-protocol: sample-v1\r\ncontent-length: {}\r\n\r\n",
            input.len()
        );
        let mut request = head.into_bytes();
        request.extend_from_slice(&input);
        request
    };

    // First request, sent from a thread that never reads the response.
    let first = make_request("attempt-first");
    let address_for_first = address.clone();
    let inflight = std::thread::spawn(move || {
        // Held open on purpose: this request must stay in flight for the second
        // one to meet a busy container.
        harness::http_send_then_drop(&address_for_first, &first, 3_000).expect("first request");
    });
    assert!(
        harness::wait_until(|| started_marker.exists(), 10_000),
        "the first encode never started"
    );

    // Second request while the first holds the only slot: an immediate, truthful
    // refusal rather than a queue behind a container with one encode of CPU.
    let raw =
        harness::http_raw(&address, &make_request("attempt-second"), true).expect("second request");
    let (status, _, body) = harness::parse_response(&raw);
    assert_eq!(status, 429);
    let document: starter_media::protocol::ErrorDocument =
        serde_json::from_slice(&body).expect("json");
    assert_eq!(document.error.code, "busy");
    assert!(
        document.error.retryable,
        "a busy container is worth retrying"
    );

    // Once the first request's caller disappears, the slot frees up.
    inflight.join().expect("first request thread");
    shutdown.cancel_all();
    assert!(
        harness::wait_until(
            || {
                std::fs::read_dir(&temp_root)
                    .map(|entries| entries.count() == 0)
                    .unwrap_or(true)
            },
            20_000
        ),
        "the first encode left files after cancellation"
    );
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn the_sigterm_handler_cancels_an_in_flight_encode_and_exits() {
    // This one runs the real binary as its own process, because a signal cannot
    // be delivered to the test process without also ending the test.
    let scratch = harness::scratch_dir("http-sigterm");
    let started_marker = scratch.join("ffmpeg-started");
    let fake = scratch.join("fake-ffmpeg.sh");
    let temp_root = scratch.join("temp");
    std::fs::create_dir_all(&temp_root).expect("temp root");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\nprintf started > {}\nwhile : ; do sleep 0.2; done\n",
            started_marker.display()
        ),
    )
    .expect("write the fake tool");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    // A free port chosen by binding and releasing: the server binds it itself, so
    // a taken port is reported rather than silently shifting the test.
    let port = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("probe port");
        probe.local_addr().expect("addr").port()
    };
    let binary = env!("CARGO_BIN_EXE_starter-media");
    let mut child = std::process::Command::new(binary)
        .args([
            "serve",
            "--port",
            &port.to_string(),
            "--tmpdir",
            temp_root.to_str().expect("path"),
        ])
        .env("MEDIA_FFMPEG_PATH", &fake)
        .env("MEDIA_FFPROBE_PATH", harness::require(&harness::ffprobe()))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn the server binary");

    let address = format!("127.0.0.1:{port}");
    assert!(
        harness::wait_until(|| std::net::TcpStream::connect(&address).is_ok(), 15_000),
        "the server binary never listened"
    );

    // Start an encode, then hold the socket open from a thread so the request is
    // not cancelled by a disconnect before the signal arrives.
    let input = std::fs::read(harness::fixture()).expect("fixture bytes");
    let head = format!(
        "POST /encode HTTP/1.1\r\nhost: localhost\r\nx-attempt-id: attempt-sigterm\r\n\
         x-preset: demo-180p-v1\r\nx-protocol: sample-v1\r\ncontent-length: {}\r\n\r\n",
        input.len()
    );
    let mut request = head.into_bytes();
    request.extend_from_slice(&input);
    let address_for_request = address.clone();
    let inflight = std::thread::spawn(move || {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(&address_for_request).expect("connect");
        stream.write_all(&request).expect("write request");
        let mut response = Vec::new();
        // Hold the connection and read whatever eventually arrives.
        let _ = stream.read_to_end(&mut response);
        response
    });
    assert!(
        harness::wait_until(|| started_marker.exists(), 20_000),
        "the encode never started, so SIGTERM proved nothing"
    );
    assert!(
        std::fs::read_dir(&temp_root).expect("temp root").count() > 0,
        "an in-flight encode owns a temp directory"
    );

    // SIGTERM: the container runtime's stop signal.
    assert_eq!(
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) },
        0
    );

    let status = harness::wait_until(|| matches!(child.try_wait(), Ok(Some(_))), 30_000);
    assert!(status, "the process ignored SIGTERM");
    let status = child.wait().expect("wait for the server");
    assert!(
        status.success(),
        "shutdown should be a clean exit, got {status}"
    );

    // The child subprocess did not outlive the process, and no request files are
    // left in the container's temp root.
    assert!(
        harness::wait_until(
            || std::fs::read_dir(&temp_root)
                .map(|e| e.count() == 0)
                .unwrap_or(true),
            20_000
        ),
        "SIGTERM left files in the temp root"
    );
    let _ = inflight.join();
    std::fs::remove_dir_all(&scratch).ok();
}

#[test]
fn a_refusal_sent_before_the_body_arrives_still_reaches_the_client() {
    // The regression this exists for. This server refuses a request on its
    // *headers* — an oversized declared length, a missing preset — while the
    // client is still uploading. Closing that socket without reading what is in
    // flight makes the kernel send RST, and the client never sees the status it
    // was owed: `curl` printed "connection reset by peer" and an empty body for a
    // request the server had answered correctly.
    //
    // The control is deliberately slow: the body is written in small chunks with
    // pauses, so the response is guaranteed to be written while the upload is
    // still in progress.
    let server = RunningServer::start("http-refusal-during-upload", None);
    // Above the 5 MiB ceiling, so the refusal happens on the header alone.
    let declared: usize = (MAX_INPUT_BYTES as usize) + 1024 * 1024;
    let address = server.address.clone();

    let reader = std::thread::spawn(move || {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(&address).expect("connect");
        stream
            .write_all(
                format!(
                    "POST /encode HTTP/1.1\r\nhost: localhost\r\nx-attempt-id: attempt-slow-upload\r\n\
                     x-preset: demo-180p-v1\r\ncontent-length: {declared}\r\n\r\n"
                )
                .as_bytes(),
            )
            .expect("write head");
        let chunk = vec![0_u8; 256 * 1024];
        let mut written = 0;
        while written < declared {
            let take = chunk.len().min(declared - written);
            if stream.write_all(&chunk[..take]).is_err() {
                break;
            }
            written += take;
            // Give the server room to answer while the upload is unfinished.
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        response
    });

    let raw = reader.join().expect("client thread");
    let (status, headers, body) = harness::parse_response(&raw);
    assert_eq!(
        status,
        400,
        "the refusal never reached the client; raw response was {} bytes",
        raw.len()
    );
    assert_eq!(
        harness::header(&headers, "content-type"),
        Some("application/json")
    );
    let document: starter_media::protocol::ErrorDocument =
        serde_json::from_slice(&body).expect("error body");
    assert_eq!(document.error.code, "payload_too_large");
}
