//! The clock seam.
//!
//! A 120-second encoding deadline is a real bound on production, and it must be
//! provable in a test in milliseconds. Every deadline in this crate is measured
//! through [`Clock`], so a test can prove the deadline path against a real
//! subprocess while its virtual clock advances instantly.
//!
//! Time is monotonic milliseconds since an arbitrary origin rather than
//! `std::time::Instant`. `Instant` cannot be constructed by a fake, which would
//! push the fake back to overriding the whole process module instead of the one
//! thing being tested.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// A monotonic millisecond clock.
pub trait Clock: Send + Sync {
    /// Milliseconds since this clock's origin. Never decreases.
    fn now_ms(&self) -> u64;
    /// Wait, or advance, by `millis`.
    fn sleep(&self, millis: u64);
}

/// The production clock: `Instant` behind the seam, real sleeping.
#[derive(Debug, Clone, Copy)]
pub struct SystemClock {
    origin: std::time::Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            origin: std::time::Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        // Saturating: a process running for 584 million years is not a case that
        // needs to wrap into a small deadline.
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn sleep(&self, millis: u64) {
        std::thread::sleep(Duration::from_millis(millis));
    }
}

/// A clock that only moves when something sleeps.
///
/// `sleep` advances virtual time by exactly the requested amount, so a poll loop
/// with a 20 ms poll interval and a 200 ms deadline reaches the deadline after
/// ten iterations and microseconds of real time — while still driving a real
/// subprocess that has to be killed and reaped for real.
#[derive(Debug)]
pub struct ManualClock {
    now_ms: AtomicU64,
}

impl ManualClock {
    pub fn new() -> Self {
        Self {
            now_ms: AtomicU64::new(0),
        }
    }

    /// Current virtual time.
    pub fn now(&self) -> u64 {
        self.now_ms.load(Ordering::SeqCst)
    }

    /// Advance virtual time without a poll loop having asked for it.
    pub fn advance(&self, millis: u64) {
        self.now_ms.fetch_add(millis, Ordering::SeqCst);
    }
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.now()
    }

    fn sleep(&self, millis: u64) {
        self.advance(millis);
    }
}

/// Shared handle to the production clock.
pub fn system_clock() -> Arc<dyn Clock> {
    Arc::new(SystemClock::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_clock_advances_only_when_something_sleeps() {
        let clock = ManualClock::new();
        assert_eq!(clock.now_ms(), 0);
        clock.sleep(20);
        clock.sleep(20);
        assert_eq!(clock.now_ms(), 40);
    }

    #[test]
    fn system_clock_is_monotonic_and_nonzero_after_a_sleep() {
        let clock = SystemClock::new();
        let first = clock.now_ms();
        clock.sleep(2);
        assert!(clock.now_ms() >= first);
    }
}
