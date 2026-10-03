//! Test support for this crate's unit tests, its integration tests and CI.
//!
//! It exists because three real prerequisites are needed to test this processor —
//! an `ffmpeg`, an `ffprobe`, and the committed synthetic fixture — and a test
//! that quietly skips when they are missing is exactly the zero-test pass this
//! repository forbids. So [`require_ffmpeg`] fails with a sentence naming the
//! prerequisite instead of returning `None` and passing.
//!
//! It is compiled into the binary rather than hidden behind a feature because a
//! feature-gated harness makes `cargo test` and `cargo test --all-features` two
//! different test runs, and the one CI runs is whichever somebody remembered.
//! Nothing in the encode path calls anything here; it is a few lines of path
//! resolution and one `/proc` read.

use std::path::PathBuf;

/// The `ffmpeg` to spawn in tests: `$MEDIA_TEST_FFMPEG`, then `$MEDIA_FFMPEG_PATH`,
/// then `ffmpeg` on `PATH`.
///
/// The override exists so the Docker-based lane can point the same suite at the
/// image's own FFmpeg rather than at the host's.
pub fn ffmpeg() -> PathBuf {
    std::env::var_os("MEDIA_TEST_FFMPEG")
        .or_else(|| std::env::var_os("MEDIA_FFMPEG_PATH"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

/// The `ffprobe` to spawn in tests. Same override names as [`ffmpeg`].
pub fn ffprobe() -> PathBuf {
    std::env::var_os("MEDIA_TEST_FFPROBE")
        .or_else(|| std::env::var_os("MEDIA_FFPROBE_PATH"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("ffprobe"))
}

/// Resolve a tool, or fail with the command that installs the missing one.
pub fn require(tool: &std::path::Path) -> PathBuf {
    if tool.components().count() > 1 && tool.exists() {
        return tool.to_path_buf();
    }
    // A bare name is resolved by the OS at spawn time; asking the OS is the only
    // honest check, and `command -v` is that check without spawning the tool.
    let probe = std::process::Command::new("/bin/sh")
        .args(["-c", &format!("command -v {}", tool.display())])
        .output();
    let found = probe
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default();
    if found.is_empty() {
        panic!(
            "this test needs {} on PATH. Install FFmpeg (Debian/Ubuntu: apt-get install ffmpeg, \
             macOS: brew install ffmpeg) or set MEDIA_TEST_FFMPEG / MEDIA_TEST_FFPROBE. \
             The suite does not skip: an unproven encode lane is a false pass.",
            tool.display()
        );
    }
    PathBuf::from(found)
}

/// The committed synthetic fixture, `fixtures/media/sample-v1.mp4`.
pub fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join("media")
        .join("sample-v1.mp4")
}

/// A path the suite owns and can assert is empty afterwards.
pub fn scratch_dir(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "starter-media-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    std::fs::create_dir_all(&root).expect("scratch directory");
    root
}

/// This process's live children, read from `/proc`.
///
/// Linux only: children of the calling thread, including unreaped children.
/// This cannot prove reaping of children spawned by another thread. Callers
/// observing a server worker must track the child's PID directly instead.
/// Returns an empty vector if the calling thread's `/proc` entry is unreadable.
#[cfg(target_os = "linux")]
pub fn child_pids() -> Vec<u32> {
    // `/proc/thread-self` resolves for the *calling thread*, which is what makes
    // this usable from a test binary: `cargo test` runs tests in parallel
    // threads of one process, so "/proc/self/task/*/children" would report every
    // other test's subprocess and make a reaping assertion meaningless.
    let Ok(text) = std::fs::read_to_string("/proc/thread-self/children") else {
        return Vec::new();
    };
    text.split_whitespace()
        .filter_map(|field| field.parse().ok())
        .collect()
}

/// Whether a pid still exists. Linux only, same reasoning as [`child_pids`].
#[cfg(target_os = "linux")]
pub fn process_exists(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// Poll until `condition` holds or the budget runs out.
///
/// Bounded, never unbounded: a test that waits forever for a condition that will
/// not arrive is a test that reports nothing and passes a CI job by timing out.
pub fn wait_until(mut condition: impl FnMut() -> bool, budget_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
    while std::time::Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    condition()
}

/// A raw HTTP/1.1 request, written byte by byte, returning the raw response.
///
/// Deliberately not a client library: this harness exists so the suite speaks the
/// same bytes a Durable Object would, including "hang up before the response".
pub fn http_raw(address: &str, request: &[u8], read_response: bool) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(address)?;
    stream.write_all(request)?;
    stream.flush()?;
    if !read_response {
        // Shut down the write side only, so the server observes a disconnect
        // rather than a half-open connection it is still entitled to write to.
        let _ = stream.shutdown(std::net::Shutdown::Write);
        return Ok(Vec::new());
    }
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    Ok(response)
}

/// Send a request, hold the connection open for `hold_ms`, then drop it.
///
/// `hold_ms` exists because a disconnect test needs the request to *arrive*
/// before the socket goes away: dropping immediately can cancel an encode before
/// its child process has even been spawned, which proves nothing about cleanup.
/// The hold is a real sleep of a bounded, small number of milliseconds.
pub fn http_send_then_drop(address: &str, request: &[u8], hold_ms: u64) -> std::io::Result<()> {
    use std::io::Write;
    let mut stream = std::net::TcpStream::connect(address)?;
    stream.write_all(request)?;
    stream.flush()?;
    std::thread::sleep(std::time::Duration::from_millis(hold_ms));
    drop(stream);
    Ok(())
}

/// Split a raw HTTP response into its status line, headers and body.
pub fn parse_response(raw: &[u8]) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap_or(raw.len());
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let body = raw.get(split + 4..).map(<[u8]>::to_vec).unwrap_or_default();
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    (status, headers, body)
}

/// The header value for `name`, case-insensitively.
pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_required_tools_are_present_or_the_test_says_why() {
        // If this test fails, every other test in the suite is measuring
        // nothing. The message names the prerequisite.
        require(&ffmpeg());
        require(&ffprobe());
    }

    #[test]
    fn a_missing_tool_fails_loudly_instead_of_skipping() {
        let missing = PathBuf::from("starter-media-not-a-real-tool");
        let result = std::panic::catch_unwind(|| require(&missing));
        assert!(result.is_err(), "a missing tool must not resolve");
    }

    #[test]
    fn the_committed_fixture_is_there_and_small() {
        let fixture = fixture();
        let metadata = std::fs::metadata(&fixture).expect("committed fixture");
        assert!(metadata.len() > 0);
        assert!(
            metadata.len() < crate::protocol::MAX_INPUT_BYTES,
            "fixture {} bytes is not under the input ceiling",
            metadata.len()
        );
    }

    #[test]
    fn scratch_directories_are_distinct_per_call() {
        let first = scratch_dir("distinct");
        let second = scratch_dir("distinct");
        assert_ne!(first, second);
        std::fs::remove_dir_all(&first).ok();
        std::fs::remove_dir_all(&second).ok();
    }

    #[test]
    fn raw_responses_split_into_status_headers_and_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nX-Try: yes\r\n\r\nabc";
        let (status, headers, body) = parse_response(raw);
        assert_eq!(status, 200);
        assert_eq!(header(&headers, "content-length"), Some("3"));
        assert_eq!(header(&headers, "x-try"), Some("yes"));
        assert_eq!(body, b"abc");
    }

    #[test]
    fn wait_until_reports_a_condition_that_never_arrives_as_false() {
        // A negative control for the polling helper itself: without it, a helper
        // that always returns true would make every lifecycle test pass.
        assert!(!wait_until(|| false, 60));
        assert!(wait_until(|| true, 60));
    }
}
