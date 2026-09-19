//! Opt-in NVENC delivery window. Reserve BEFORE encoding: encoded P-frames must
//! never be replaced by a newer one. Two outstanding IPC messages bound latency
//! while allowing the JS acknowledgement to overlap the next frame's capture.
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const WINDOW: usize = 2;
const ACK_TIMEOUT: Duration = Duration::from_secs(2);
pub static DELIVERY: Gate = Gate::new();

struct State {
    generation: u32,
    next: u32,
    enabled: bool,
    pending: VecDeque<(u32, Instant)>,
    skipped: u32,
    timeouts: u32,
}
pub struct Gate(Mutex<State>);
#[derive(Clone, Copy, Default)]
pub struct Stats {
    pub enabled: bool,
    pub pending: u32,
    pub skipped: u32,
    pub timeouts: u32,
}

/// A reservation is returned even in classic mode, but then no header/ACK is added.
pub struct Permit<'a> {
    gate: &'a Gate,
    ticket: Option<(u32, u32)>,
    submitted_ms: f64,
    sent: bool,
}
impl Gate {
    pub const fn new() -> Self {
        Self(Mutex::new(State {
            generation: 0,
            next: 0,
            enabled: false,
            pending: VecDeque::new(),
            skipped: 0,
            timeouts: 0,
        }))
    }
    pub fn start(&self, generation: u32) {
        *self.0.lock() = State {
            generation,
            next: 0,
            enabled: false,
            pending: VecDeque::new(),
            skipped: 0,
            timeouts: 0,
        };
    }
    pub fn enable(&self, on: bool) {
        let mut s = self.0.lock();
        if s.enabled != on {
            s.pending.clear();
        }
        s.enabled = on;
    }
    pub fn stats(&self) -> Stats {
        let s = self.0.lock();
        Stats {
            enabled: s.enabled,
            pending: s.pending.len() as u32,
            skipped: s.skipped,
            timeouts: s.timeouts,
        }
    }
    pub fn reserve(&self, generation: u32) -> Option<Permit<'_>> {
        self.reserve_at(generation, Instant::now())
    }
    fn reserve_at(&self, generation: u32, now: Instant) -> Option<Permit<'_>> {
        let mut s = self.0.lock();
        if s.generation != generation {
            return None;
        }
        if s.enabled
            && s.pending
                .front()
                .is_some_and(|(_, since)| now.duration_since(*since) >= ACK_TIMEOUT)
        {
            // Missing/old frontend or stalled IPC: revert to the established path.
            // Never strand the stream on an experiment that cannot acknowledge.
            s.enabled = false;
            s.pending.clear();
            s.timeouts += 1;
        }
        let ticket = if s.enabled {
            if s.pending.len() >= WINDOW {
                s.skipped = s.skipped.saturating_add(1);
                return None;
            }
            s.next = s.next.wrapping_add(1);
            let seq = s.next;
            s.pending.push_back((seq, now));
            Some((generation, seq))
        } else {
            None
        };
        Some(Permit {
            gate: self,
            ticket,
            submitted_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64()
                * 1000.0,
            sent: false,
        })
    }
    pub fn ack(&self, generation: u32, sequence: u32) {
        let mut s = self.0.lock();
        if s.generation != generation {
            return;
        }
        if let Some(i) = s.pending.iter().position(|(seq, _)| *seq == sequence) {
            s.pending.remove(i);
        }
    }
}
impl Permit<'_> {
    /// GN v1: original 8 bytes (version byte=1), generation u32, seq u32,
    /// encode-submission wall-clock f64 ms, then unchanged Annex-B. Classic stays byte-exact.
    pub fn packet(mut self, mut packet: Vec<u8>) -> Vec<u8> {
        if let Some((generation, sequence)) = self.ticket {
            let len = packet.len();
            packet.resize(len + 16, 0);
            packet.copy_within(8..len, 24);
            packet[3] = 1;
            packet[8..12].copy_from_slice(&generation.to_le_bytes());
            packet[12..16].copy_from_slice(&sequence.to_le_bytes());
            packet[16..24].copy_from_slice(&self.submitted_ms.to_le_bytes());
        }
        self.sent = true;
        packet
    }
}
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        if !self.sent {
            if let Some((generation, sequence)) = self.ticket {
                self.gate.ack(generation, sequence);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn gate() -> Gate {
        Gate(Mutex::new(State {
            generation: 1,
            next: 0,
            enabled: true,
            pending: VecDeque::new(),
            skipped: 0,
            timeouts: 0,
        }))
    }
    fn frame() -> Vec<u8> {
        vec![b'G', b'N', 1, 0, 0x80, 7, 0x38, 4, 0, 0, 0, 1, 0x65]
    }
    #[test]
    fn limits_before_encode_and_acks_only_matching_tickets() {
        let g = gate();
        let first = g.reserve(1).unwrap().packet(frame());
        let second = g.reserve(1).unwrap().packet(frame());
        assert!(g.reserve(1).is_none());
        assert_eq!(g.stats().pending, 2);
        g.ack(0, 1);
        g.ack(1, 999);
        assert!(g.reserve(1).is_none(), "stale/invalid ACK must not grant credit");
        g.ack(1, 1);
        assert!(g.reserve(1).is_some()); // unsent permit returns its credit on drop
        assert_eq!(g.stats().pending, 1);
        assert_eq!(&first[24..], &frame()[8..]);
        assert_eq!(first[3], 1);
        assert_eq!(u32::from_le_bytes(second[12..16].try_into().unwrap()), 2);
    }
    #[test]
    fn toggle_classic_reset_and_timeout_do_not_wedge_capture() {
        let g = gate();
        let now = Instant::now();
        g.reserve_at(1, now).unwrap().packet(frame());
        assert_eq!(g.reserve_at(1, now + ACK_TIMEOUT).unwrap().packet(frame()), frame());
        assert_eq!(g.stats().timeouts, 1);
        g.enable(true);
        g.reserve(1).unwrap().packet(frame());
        g.enable(false);
        assert_eq!(g.reserve(1).unwrap().packet(frame()), frame());
        g.start(2);
        assert!(g.reserve(1).is_none());
        assert!(!g.stats().enabled);
    }
    #[test]
    fn late_acks_after_toggle_or_restart_cannot_release_new_frames() {
        let g = gate();
        let old = g.reserve(1).unwrap().packet(frame());
        let old_seq = u32::from_le_bytes(old[12..16].try_into().unwrap());
        g.enable(false);
        g.enable(true);
        g.reserve(1).unwrap().packet(frame());
        g.ack(1, old_seq);
        assert_eq!(g.stats().pending, 1, "sequence must not reset on a live toggle");
        g.start(2);
        g.enable(true);
        g.reserve(2).unwrap().packet(frame());
        g.ack(1, 1);
        assert_eq!(g.stats().pending, 1, "previous generation cannot acknowledge this session");
        g.ack(2, 1);
        assert_eq!(g.stats().pending, 0);
    }
    #[test]
    fn slow_consumer_never_accumulates_an_unbounded_ipc_queue() {
        let g = gate();
        let mut outstanding = VecDeque::new();
        let start = Instant::now();
        let mut sent = 0;
        for frame_no in 0..600 {
            if frame_no % 6 == 0 {
                if let Some(seq) = outstanding.pop_front() {
                    g.ack(1, seq);
                }
            }
            if let Some(p) = g.reserve_at(1, start + Duration::from_millis(frame_no * 16)) {
                let bytes = p.packet(frame());
                outstanding.push_back(u32::from_le_bytes(bytes[12..16].try_into().unwrap()));
                sent += 1;
            }
            assert!(g.stats().pending <= WINDOW as u32);
        }
        assert!(g.stats().skipped > 400);
        assert_eq!(g.stats().timeouts, 0);
        eprintln!("600 capture ticks / consumer drains every 6 ticks: sent={sent}, pre-encode skips={}, peak IPC frames <= {WINDOW} (unbounded producer would queue ~500)", g.stats().skipped);
    }
}
