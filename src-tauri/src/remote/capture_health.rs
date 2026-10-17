//! Independent capture liveness. It must never acquire a graphics, view-session,
//! IPC or WebView lock: those are precisely the dependencies it has to recover.
use std::time::{Duration, Instant};

pub const STALL_MS: u64 = 20_000;
const SUSPEND_GAP_MS: u64 = 5_000;

#[derive(Clone, Copy, Debug, Default)]
pub struct Sample {
    pub running: bool,
    pub paused: bool,
    /// Lifetime primary-stream deliveries; capture restarts must not reset this.
    pub emitted: u64,
}

#[derive(Default)]
pub struct Watchdog {
    last_poll: Option<u64>,
    last_progress: Option<u64>,
    emitted: u64,
}
impl Watchdog {
    pub fn observe(&mut self, sample: Sample, now: u64) -> bool {
        let resumed = self
            .last_poll
            .is_some_and(|last| now.saturating_sub(last) > SUSPEND_GAP_MS);
        self.last_poll = Some(now);
        if !sample.running || sample.paused {
            self.last_progress = None;
            self.emitted = sample.emitted;
            return false;
        }
        if resumed || self.last_progress.is_none() || sample.emitted != self.emitted {
            self.emitted = sample.emitted;
            self.last_progress = Some(now);
            return false;
        }
        now.saturating_sub(self.last_progress.unwrap()) >= STALL_MS
    }
}

/// Runs outside the renderer and capture workers. A process-level recovery can
/// therefore work even when a driver call, IPC command or browser poll hangs.
pub fn supervise(
    sample: impl Fn() -> Sample + Send + 'static,
    recover: impl FnOnce(Sample) + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("capture-health".into())
        .spawn(move || {
            let clock = Instant::now();
            let mut watchdog = Watchdog::default();
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let current = sample();
                if watchdog.observe(current, clock.elapsed().as_millis() as u64) {
                    recover(current);
                    return;
                }
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn active(emitted: u64) -> Sample {
        Sample {
            running: true,
            paused: false,
            emitted,
        }
    }
    #[test]
    fn a_first_frame_that_never_arrives_is_bounded_even_across_capture_restarts() {
        let mut w = Watchdog::default();
        for now in (0..STALL_MS).step_by(1000) {
            // The per-generation produced counter can repeatedly reset to zero;
            // only an actual delivery advances this lifetime counter.
            assert!(!w.observe(active(0), now));
        }
        assert!(w.observe(active(0), STALL_MS));
    }
    #[test]
    fn real_frames_and_static_screen_keepalives_keep_the_host_alive() {
        let mut w = Watchdog::default();
        for now in (0..120_000).step_by(1000) {
            assert!(!w.observe(active(now / 1000), now));
        }
    }
    #[test]
    fn intentional_pause_and_disconnect_get_a_fresh_grace_period() {
        for stopped in [
            Sample {
                paused: true,
                ..active(3)
            },
            Sample::default(),
        ] {
            let mut w = Watchdog::default();
            for now in (0..60_000).step_by(1000) {
                assert!(!w.observe(stopped, now));
            }
            assert!(!w.observe(active(3), 60_000));
            for now in (61_000..80_000).step_by(1000) {
                assert!(!w.observe(active(3), now));
            }
            assert!(w.observe(active(3), 80_000));
        }
    }
    #[test]
    fn windows_sleep_or_cpu_suspension_does_not_cause_an_immediate_restart() {
        let mut w = Watchdog::default();
        assert!(!w.observe(active(1), 0));
        assert!(!w.observe(active(1), 1000));
        assert!(!w.observe(active(1), 600_000));
        for now in (601_000..620_000).step_by(1000) {
            assert!(!w.observe(active(1), now));
        }
        assert!(w.observe(active(1), 620_000));
    }
}
