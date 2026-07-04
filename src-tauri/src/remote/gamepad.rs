//! Virtual gamepad injection for the remote-play feature.
//!
//! An Android phone with a physical controller attached reads it through the web
//! **Gamepad API** and streams the pad state to us over the same control channel
//! that carries mouse/keyboard input. We replay that state into a **virtual Xbox
//! 360 controller** so PC games see a real XInput device — letting the user play
//! their PC games from the couch with a controller docked to the phone.
//!
//! This requires the **ViGEmBus** driver (<https://vigembus.com>). Without it,
//! `Client::connect()` fails, injection becomes a no-op, and [`available`] reports
//! `false` so the phone can prompt the user to install it.
//!
//! The virtual controller lives on its own dedicated OS thread (owning the
//! non-`Send` ViGEm handles), fed by a channel. A recv-timeout watchdog releases
//! all inputs to neutral if updates stop arriving (phone paused / link dropped),
//! so a held button never sticks after a disconnect.

use serde::Deserialize;

/// One snapshot of controller state from the phone.
///
/// `buttons` is an **XInput-style bitmask** — the phone maps the standard Gamepad
/// layout to these bits (see [`XButtons`](vigem_client::XButtons) constants). Sticks
/// are normalized `-1.0..1.0` with the phone already flipping Y to XInput's
/// up-positive convention; triggers are `0.0..1.0`.
#[derive(Deserialize, Clone, Copy, Default, PartialEq, Debug)]
pub struct GamepadState {
    #[serde(default)]
    pub buttons: u16,
    #[serde(default)]
    pub lx: f32,
    #[serde(default)]
    pub ly: f32,
    #[serde(default)]
    pub rx: f32,
    #[serde(default)]
    pub ry: f32,
    #[serde(default)]
    pub lt: f32,
    #[serde(default)]
    pub rt: f32,
}

/// Whether a virtual gamepad can be created (i.e. the ViGEmBus driver is present).
/// The phone queries this before offering controller mode so it can prompt the
/// user to install the driver if it's missing. Result is cached after the first probe.
pub fn available() -> bool {
    imp::available()
}

/// Push a new controller state to the virtual pad (lazily plugging it in on the
/// first call). No-op if the driver is unavailable.
pub fn apply(state: GamepadState) {
    imp::apply(state);
}

/// Release every input to neutral and unplug the virtual controller. Called when
/// the phone leaves controller mode or the remote session ends.
pub fn stop() {
    imp::stop();
}

#[cfg(windows)]
mod imp {
    use super::GamepadState;
    use parking_lot::Mutex;
    use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
    use std::time::Duration;
    use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

    enum Msg {
        State(GamepadState),
        Stop,
    }

    static TX: once_cell::sync::Lazy<Mutex<Option<Sender<Msg>>>> =
        once_cell::sync::Lazy::new(|| Mutex::new(None));
    /// Cached driver-availability probe (`None` = not yet probed).
    static AVAILABLE: once_cell::sync::Lazy<Mutex<Option<bool>>> =
        once_cell::sync::Lazy::new(|| Mutex::new(None));

    pub fn available() -> bool {
        let mut guard = AVAILABLE.lock();
        if let Some(v) = *guard {
            return v;
        }
        let v = Client::connect().is_ok();
        *guard = Some(v);
        v
    }

    fn to_i16(v: f32) -> i16 {
        (v.clamp(-1.0, 1.0) * 32767.0).round() as i16
    }
    fn to_u8(v: f32) -> u8 {
        (v.clamp(0.0, 1.0) * 255.0).round() as u8
    }

    /// Own the ViGEm handles for the life of the session and apply incoming states.
    fn run(rx: std::sync::mpsc::Receiver<Msg>) {
        let client = match Client::connect() {
            Ok(c) => c,
            Err(_) => return, // driver went away; TX resets on the next apply()
        };
        let mut target = Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
        if target.plugin().is_err() {
            return;
        }
        let _ = target.wait_ready();
        let neutral = XGamepad::default();
        loop {
            match rx.recv_timeout(Duration::from_millis(1500)) {
                Ok(Msg::State(s)) => {
                    let pad = XGamepad {
                        buttons: XButtons { raw: s.buttons },
                        left_trigger: to_u8(s.lt),
                        right_trigger: to_u8(s.rt),
                        thumb_lx: to_i16(s.lx),
                        thumb_ly: to_i16(s.ly),
                        thumb_rx: to_i16(s.rx),
                        thumb_ry: to_i16(s.ry),
                    };
                    let _ = target.update(&pad);
                }
                Ok(Msg::Stop) => {
                    let _ = target.update(&neutral);
                    break; // dropping `target` unplugs the virtual controller
                }
                // No updates for a while: release to neutral so a held button can't
                // stick if the phone paused or the link dropped, but stay plugged in
                // (a genuine idle controller sends heartbeats to keep it alive).
                Err(RecvTimeoutError::Timeout) => {
                    let _ = target.update(&neutral);
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    fn ensure() -> Option<Sender<Msg>> {
        let mut guard = TX.lock();
        if guard.is_none() {
            if !available() {
                return None;
            }
            let (tx, rx) = channel::<Msg>();
            std::thread::spawn(move || run(rx));
            *guard = Some(tx);
        }
        guard.clone()
    }

    pub fn apply(state: GamepadState) {
        if let Some(tx) = ensure() {
            if tx.send(Msg::State(state)).is_err() {
                *TX.lock() = None; // thread died; a fresh one spawns on the next apply
            }
        }
    }

    pub fn stop() {
        if let Some(tx) = TX.lock().take() {
            let _ = tx.send(Msg::Stop);
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::GamepadState;
    pub fn available() -> bool {
        false
    }
    pub fn apply(_state: GamepadState) {}
    pub fn stop() {}
}
