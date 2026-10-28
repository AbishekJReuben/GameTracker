//! Bounded, process-local pairing budgets. Uses the TCP peer address, never a
//! caller-provided forwarding header. No credentials or addresses are logged.
use std::{collections::VecDeque, net::IpAddr, time::{Duration, Instant}};

const WINDOW: Duration = Duration::from_secs(15 * 60);
const PER_ADDRESS: usize = 5;
const GLOBAL: usize = 30;

#[derive(Default)]
pub struct PairLimit {
    attempts: VecDeque<(Instant, IpAddr)>,
}

impl PairLimit {
    /// Call while holding the shared mutex, before checking the PIN or issuing
    /// a token. Rejected requests do not extend the lockout indefinitely.
    pub fn reserve(&mut self, address: IpAddr, now: Instant) -> Result<(), Duration> {
        while self.attempts.front().is_some_and(|(at, _)| now.saturating_duration_since(*at) >= WINDOW) {
            self.attempts.pop_front();
        }
        let mut wait = Duration::ZERO;
        if self.attempts.len() >= GLOBAL {
            if let Some((at, _)) = self.attempts.front() {
                wait = WINDOW.saturating_sub(now.saturating_duration_since(*at));
            }
        }
        if self.attempts.iter().filter(|(_, ip)| *ip == address).count() >= PER_ADDRESS {
            if let Some((at, _)) = self.attempts.iter().find(|(_, ip)| *ip == address) {
                wait = wait.max(WINDOW.saturating_sub(now.saturating_duration_since(*at)));
            }
        }
        if !wait.is_zero() { return Err(wait); }
        self.attempts.push_back((now, address));
        Ok(())
    }

    pub fn clear(&mut self) { self.attempts.clear(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;
    fn ip(n: u8) -> IpAddr { Ipv4Addr::new(192, 0, 2, n).into() }

    #[test]
    fn per_address_limit_is_reserved_before_work() {
        let mut limit=PairLimit::default();let now=Instant::now();
        for _ in 0..5 { assert!(limit.reserve(ip(1),now).is_ok()); }
        assert_eq!(limit.reserve(ip(1),now),Err(WINDOW));
        assert!(limit.reserve(ip(2),now).is_ok());
    }
    #[test]
    fn global_budget_limits_distributed_attempts_and_memory() {
        let mut limit=PairLimit::default();let now=Instant::now();
        for n in 0..30 { assert!(limit.reserve(ip(n),now).is_ok()); }
        for n in 30..200 { assert!(limit.reserve(ip(n),now).is_err()); }
        assert_eq!(limit.attempts.len(),30);
    }
    #[test]
    fn denial_does_not_extend_window_and_boundary_expires() {
        let mut limit=PairLimit::default();let now=Instant::now();
        for _ in 0..5 { limit.reserve(ip(1),now).unwrap(); }
        assert_eq!(limit.reserve(ip(1),now+Duration::from_secs(899)),Err(Duration::from_secs(1)));
        assert!(limit.reserve(ip(1),now+WINDOW).is_ok());
        assert_eq!(limit.attempts.len(),1);
    }
    #[test]
    fn rolling_window_keeps_unexpired_attempts() {
        let mut limit=PairLimit::default();let now=Instant::now();
        limit.reserve(ip(1),now).unwrap();
        for _ in 0..4 { limit.reserve(ip(1),now+Duration::from_secs(10)).unwrap(); }
        assert!(limit.reserve(ip(1),now+WINDOW).is_ok());
        assert_eq!(limit.reserve(ip(1),now+WINDOW),Err(Duration::from_secs(10)));
    }
    #[test]
    fn local_pin_rotation_can_reset_budget() {
        let mut limit=PairLimit::default();let now=Instant::now();
        for _ in 0..5 { limit.reserve(ip(1),now).unwrap(); }
        limit.clear();assert!(limit.reserve(ip(1),now).is_ok());
    }
    #[test]
    fn simultaneous_requests_cannot_exceed_the_address_budget() {
        use std::sync::{Arc,Mutex,Barrier};
        let limit=Arc::new(Mutex::new(PairLimit::default()));let barrier=Arc::new(Barrier::new(12));let now=Instant::now();
        let threads:Vec<_>=(0..12).map(|_|{let limit=limit.clone();let barrier=barrier.clone();std::thread::spawn(move||{barrier.wait();limit.lock().unwrap().reserve(ip(1),now).is_ok()})}).collect();
        assert_eq!(threads.into_iter().map(|t|t.join().unwrap()).filter(|ok|*ok).count(),5);
    }
    #[test]
    fn backwards_time_does_not_open_the_budget() {
        let mut limit=PairLimit::default();let now=Instant::now();
        for _ in 0..5 { limit.reserve(ip(1),now+Duration::from_secs(10)).unwrap(); }
        assert!(limit.reserve(ip(1),now).is_err());
    }
}
