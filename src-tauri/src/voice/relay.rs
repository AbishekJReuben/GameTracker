//! The PC's side of the `/voice` channel on the discovery server.
//!
//! Same trust model as Notes: every device derives an AES-256-GCM key from the
//! permanent key (`remote_secret_code`) with HKDF-SHA256, and the server only
//! ever stores ciphertext. Voice uses its own salt so a voice key can never open
//! a note, and vice versa. Wire format for anything encrypted:
//! `iv(12) || ciphertext || tag(16)`, base64 when it rides in JSON.
//!
//! Audio goes over this same socket (not an HTTP upload) and the relay forwards
//! it straight to the phone: that's the difference between hearing a line about
//! a second after Claude writes it and hearing it after two extra round trips.

use base64::Engine as _;
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

const SALT: &[u8] = b"gt-voice-v1";

pub struct Crypto {
    key: LessSafeKey,
    rng: SystemRandom,
}

impl Crypto {
    pub fn new(secret: &str) -> Self {
        let salt = ring::hkdf::Salt::new(ring::hkdf::HKDF_SHA256, SALT);
        let prk = salt.extract(secret.as_bytes());
        let okm = prk.expand(&[], &aead::AES_256_GCM).expect("hkdf expand");
        let key = UnboundKey::from(okm);
        Self { key: LessSafeKey::new(key), rng: SystemRandom::new() }
    }

    pub fn seal(&self, plain: &[u8]) -> Vec<u8> {
        let mut iv = [0u8; 12];
        self.rng.fill(&mut iv).expect("rng");
        let mut buf = plain.to_vec();
        self.key
            .seal_in_place_append_tag(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut buf)
            .expect("seal");
        let mut out = Vec::with_capacity(12 + buf.len());
        out.extend_from_slice(&iv);
        out.extend_from_slice(&buf);
        out
    }

    pub fn open(&self, blob: &[u8]) -> Option<Vec<u8>> {
        if blob.len() < 12 + 16 {
            return None;
        }
        let mut iv = [0u8; 12];
        iv.copy_from_slice(&blob[..12]);
        let mut buf = blob[12..].to_vec();
        let plain = self.key.open_in_place(Nonce::assume_unique_for_key(iv), Aad::empty(), &mut buf).ok()?;
        Some(plain.to_vec())
    }

    pub fn seal_b64(&self, plain: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.seal(plain))
    }
}

/// The relay namespace for a user's devices: hex of the first 8 bytes of
/// SHA-256(secret). Identical to Notes' `clipId`, so one id names one user.
pub fn space_id(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(secret.as_bytes())[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// `wss://host/ws` (the signaling URL) → `wss://host`.
pub fn ws_base(signal_url: &str) -> String {
    let u = signal_url.trim().trim_end_matches('/');
    let u = u.strip_suffix("/ws").unwrap_or(u);
    if let Some(rest) = u.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = u.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        u.to_string()
    }
}

/// Things the voice loop wants sent.
pub enum Out {
    /// Item metadata (already carrying its encrypted payload).
    Item(Value),
    /// One synthesized part: encrypted MP3, base64.
    Audio { item: String, part: usize, dur_ms: u32, data: String },
}

/// Things the relay told us.
pub enum In {
    Connected,
    Disconnected(String),
    /// The phone finished everything up to this order.
    Head(i64),
    /// The phone wants this item spoken (a replay of something never voiced).
    Want(String),
}

/// Run the connection until `stop`: reconnects with backoff and keeps anything
/// queued while offline (bounded) so a blip loses nothing.
pub fn run(url: String, rx: Receiver<Out>, tx: Sender<In>, stop: Arc<AtomicBool>) {
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut backoff = Duration::from_secs(1);
    while !stop.load(Ordering::SeqCst) {
        drain(&rx, &mut queue);
        match connect(&url) {
            Ok(mut ws) => {
                backoff = Duration::from_secs(1);
                let _ = tx.send(In::Connected);
                let reason = session(&mut ws, &rx, &tx, &stop, &mut queue);
                let _ = ws.close(None);
                let _ = tx.send(In::Disconnected(reason));
            }
            Err(e) => {
                let _ = tx.send(In::Disconnected(e));
            }
        }
        let until = Instant::now() + backoff;
        while Instant::now() < until && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(200));
            drain(&rx, &mut queue);
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

const QUEUE_MAX: usize = 4000;

fn drain(rx: &Receiver<Out>, queue: &mut VecDeque<String>) {
    loop {
        match rx.try_recv() {
            Ok(out) => {
                queue.push_back(encode(out));
                while queue.len() > QUEUE_MAX {
                    queue.pop_front();
                }
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        }
    }
}

fn encode(out: Out) -> String {
    match out {
        Out::Item(item) => json!({ "t": "add", "item": item }).to_string(),
        Out::Audio { item, part, dur_ms, data } => {
            json!({ "t": "audio", "itemId": item, "part": part, "durMs": dur_ms, "data": data }).to_string()
        }
    }
}

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

fn connect(url: &str) -> Result<Ws, String> {
    let (ws, _) = tungstenite::connect(url).map_err(|e| format!("connect: {e}"))?;
    let tcp = match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s,
        MaybeTlsStream::Rustls(s) => s.get_ref(),
        _ => return Err("unsupported stream".into()),
    };
    // Short reads let one thread both send and receive.
    tcp.set_read_timeout(Some(Duration::from_millis(80))).map_err(|e| e.to_string())?;
    tcp.set_nodelay(true).ok();
    Ok(ws)
}

fn session(ws: &mut Ws, rx: &Receiver<Out>, tx: &Sender<In>, stop: &AtomicBool, queue: &mut VecDeque<String>) -> String {
    // The PC doesn't need the item history back, only where the phone is.
    if let Err(e) = ws.send(Message::text(json!({ "t": "hello", "role": "pc", "since": -1 }).to_string())) {
        return e.to_string();
    }
    let mut last_ping = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        drain(rx, queue);
        while let Some(msg) = queue.front() {
            if let Err(e) = ws.send(Message::text(msg.clone())) {
                return format!("send: {e}");
            }
            queue.pop_front();
        }
        // Cloudflare drops a quiet socket at ~100 s.
        if last_ping.elapsed() > Duration::from_secs(30) {
            last_ping = Instant::now();
            if let Err(e) = ws.send(Message::Ping(Vec::new().into())) {
                return format!("ping: {e}");
            }
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                match v.get("t").and_then(Value::as_str) {
                    Some("head") => {
                        if let Some(o) = v.get("order").and_then(Value::as_i64) {
                            let _ = tx.send(In::Head(o));
                        }
                    }
                    Some("want") => {
                        if let Some(id) = v.get("itemId").and_then(Value::as_str) {
                            let _ = tx.send(In::Want(id.to_string()));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return "closed by server".into(),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return format!("read: {e}"),
        }
    }
    "stopped".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip_and_tamper_detection() {
        let c = Crypto::new("secret-key");
        let blob = c.seal(b"hello");
        assert_eq!(blob.len(), 12 + 5 + 16);
        assert_eq!(c.open(&blob).unwrap(), b"hello");
        let mut bad = blob.clone();
        bad[20] ^= 1;
        assert!(c.open(&bad).is_none());
        assert!(Crypto::new("other").open(&blob).is_none());
    }

    #[test]
    fn key_matches_the_hkdf_spec_used_by_the_phone() {
        // HKDF-SHA256(ikm="abc", salt="gt-voice-v1", info="") → 32 bytes. The
        // Android service derives with the same parameters (VoiceService.deriveKey);
        // this pins the value both sides must agree on.
        let salt = ring::hkdf::Salt::new(ring::hkdf::HKDF_SHA256, SALT);
        struct Len32;
        impl ring::hkdf::KeyType for Len32 {
            fn len(&self) -> usize {
                32
            }
        }
        let mut okm = [0u8; 32];
        salt.extract(b"abc").expand(&[], Len32).unwrap().fill(&mut okm).unwrap();
        let hex: String = okm.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, EXPECTED_ABC_KEY);
    }

    // Filled in from an independent HKDF implementation (Python's hmac), below.
    const EXPECTED_ABC_KEY: &str = include_str!("testdata/hkdf_abc.txt");

    #[test]
    fn urls_and_space_id() {
        assert_eq!(ws_base("wss://discovery.example.com/ws"), "wss://discovery.example.com");
        assert_eq!(ws_base("https://h.example.com/"), "wss://h.example.com");
        assert_eq!(ws_base("http://localhost:8080/ws"), "ws://localhost:8080");
        assert_eq!(space_id("abc"), "ba7816bf8f01cfea");
    }
}
