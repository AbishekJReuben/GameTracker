//! Remote input injection: translate control events from the phone into real
//! mouse/keyboard actions via `enigo`. Runs on a dedicated OS thread (see
//! `spawn_controller`) because `Enigo` is not `Send` and must not cross `.await`.

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Deserialize;

/// A single control instruction from the companion app. Coordinates are
/// normalized 0.0–1.0 relative to the streamed screen, so they survive scaling.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ControlEvent {
    /// Move the cursor to a normalized position.
    Move { x: f32, y: f32 },
    /// Move relatively (like trackpad).
    Moverel { dx: i32, dy: i32 },
    /// Switch which monitor is captured and targeted for absolute positioning.
    Monitor { index: usize },
    /// Press-and-release a mouse button (optionally after moving there first).
    Click {
        x: Option<f32>,
        y: Option<f32>,
        button: Option<String>,
    },
    /// Mouse button down / up (for drags).
    Down { button: Option<String> },
    Up { button: Option<String> },
    /// Scroll by wheel clicks; positive dy scrolls down.
    Scroll { dx: Option<i32>, dy: i32 },
    /// Type a string of text.
    Text { value: String },
    /// Press a named special key (Enter, Backspace, Escape, Tab, arrows, …).
    Key { name: String },
    /// Hold a key/modifier down (for chords like Ctrl+C driven from sticky keys).
    Keydown { name: String },
    /// Release a previously held key/modifier.
    Keyup { name: String },
}

fn button_for(name: &Option<String>) -> Button {
    match name.as_deref() {
        Some("right") => Button::Right,
        Some("middle") => Button::Middle,
        _ => Button::Left,
    }
}

fn special_key(name: &str) -> Option<Key> {
    Some(match name.to_ascii_lowercase().as_str() {
        "enter" | "return" => Key::Return,
        "backspace" => Key::Backspace,
        "escape" | "esc" => Key::Escape,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "insert" | "ins" => Key::Insert,
        "capslock" | "caps" => Key::CapsLock,
        // Modifiers — usable both as one-shot keys and as held (keydown/keyup) chords.
        "ctrl" | "control" => Key::Control,
        "alt" => Key::Alt,
        "shift" => Key::Shift,
        "win" | "meta" | "super" | "cmd" => Key::Meta,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        // Media / volume keys.
        "volumeup" | "volup" => Key::VolumeUp,
        "volumedown" | "voldown" => Key::VolumeDown,
        "volumemute" | "mute" => Key::VolumeMute,
        "playpause" | "mediaplaypause" => Key::MediaPlayPause,
        "nexttrack" | "medianext" => Key::MediaNextTrack,
        "prevtrack" | "mediaprev" => Key::MediaPrevTrack,
        _ => return None,
    })
}

struct Controller {
    enigo: Enigo,
    // Virtual-desktop bounds of the monitor currently being controlled. Absolute
    // input maps into this rect so it lands on the right display (enigo's own Abs
    // path is primary-monitor-only on Windows, so we position the cursor ourselves).
    mx: i32,
    my: i32,
    mw: i32,
    mh: i32,
}

impl Controller {
    fn new() -> Option<Self> {
        let enigo = Enigo::new(&Settings::default()).ok()?;
        let mut c = Self { enigo, mx: 0, my: 0, mw: 1920, mh: 1080 };
        c.set_monitor(crate::remote::capture::selected_monitor());
        Some(c)
    }

    /// Point absolute input at monitor `index` (and tell the capture side too).
    fn set_monitor(&mut self, index: usize) {
        crate::remote::capture::set_selected_monitor(index);
        if let Some((x, y, w, h)) = crate::remote::capture::monitor_bounds(index) {
            self.mx = x;
            self.my = y;
            self.mw = w as i32;
            self.mh = h as i32;
        } else if let Ok((w, h)) = self.enigo.main_display() {
            self.mx = 0;
            self.my = 0;
            self.mw = w;
            self.mh = h;
        }
    }

    fn to_abs(&self, x: f32, y: f32) -> (i32, i32) {
        let px = self.mx + (x.clamp(0.0, 1.0) * (self.mw - 1).max(0) as f32).round() as i32;
        let py = self.my + (y.clamp(0.0, 1.0) * (self.mh - 1).max(0) as f32).round() as i32;
        (px, py)
    }

    /// Move the cursor to an absolute virtual-desktop pixel. Uses `SetCursorPos` on
    /// Windows so it works across all monitors (incl. negative offsets); elsewhere
    /// falls back to enigo's absolute move.
    fn move_abs(&mut self, px: i32, py: i32) {
        #[cfg(windows)]
        {
            use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
            unsafe {
                let _ = SetCursorPos(px, py);
            }
        }
        #[cfg(not(windows))]
        {
            let _ = self.enigo.move_mouse(px, py, Coordinate::Abs);
        }
    }

    /// Apply a key by name in the given direction (Press/Release/Click). Named
    /// specials map through `special_key`; anything else is treated as a single
    /// printable Unicode char.
    fn key_dir(&mut self, name: &str, dir: Direction) -> enigo::InputResult<()> {
        match special_key(name) {
            Some(k) => self.enigo.key(k, dir),
            None => match name.chars().next().filter(|_| name.chars().count() == 1) {
                Some(c) => self.enigo.key(Key::Unicode(c), dir),
                None => Ok(()),
            },
        }
    }

    fn apply(&mut self, ev: ControlEvent) {
        let _ = match ev {
            ControlEvent::Move { x, y } => {
                let (px, py) = self.to_abs(x, y);
                self.move_abs(px, py);
                Ok(())
            }
            ControlEvent::Moverel { dx, dy } => {
                self.enigo.move_mouse(dx, dy, Coordinate::Rel)
            }
            ControlEvent::Monitor { index } => {
                self.set_monitor(index);
                Ok(())
            }
            ControlEvent::Click { x, y, button } => {
                if let (Some(x), Some(y)) = (x, y) {
                    let (px, py) = self.to_abs(x, y);
                    self.move_abs(px, py);
                }
                self.enigo.button(button_for(&button), Direction::Click)
            }
            ControlEvent::Down { button } => {
                self.enigo.button(button_for(&button), Direction::Press)
            }
            ControlEvent::Up { button } => {
                self.enigo.button(button_for(&button), Direction::Release)
            }
            ControlEvent::Scroll { dx, dy } => {
                if let Some(dx) = dx {
                    if dx != 0 {
                        let _ = self.enigo.scroll(dx, Axis::Horizontal);
                    }
                }
                self.enigo.scroll(dy, Axis::Vertical)
            }
            ControlEvent::Text { value } => self.enigo.text(&value),
            ControlEvent::Key { name } => self.key_dir(&name, Direction::Click),
            ControlEvent::Keydown { name } => self.key_dir(&name, Direction::Press),
            ControlEvent::Keyup { name } => self.key_dir(&name, Direction::Release),
        };
    }
}

/// Spawn an OS thread that owns an `Enigo` and applies events from the returned
/// channel. Dropping the sender (socket closed) ends the thread. Returns `None`
/// if the input backend can't initialize.
pub fn spawn_controller() -> Option<std::sync::mpsc::Sender<ControlEvent>> {
    let (tx, rx) = std::sync::mpsc::channel::<ControlEvent>();
    // Verify the backend initializes before handing back a sender.
    let mut controller = Controller::new()?;
    std::thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            controller.apply(ev);
        }
    });
    Some(tx)
}

/// A process-wide input controller for the command-based (WebRTC) path, where
/// events arrive one Tauri command at a time rather than over a single socket.
/// Lazily spawns the injection thread and respawns it if it ever dies.
static CONTROLLER: once_cell::sync::Lazy<parking_lot::Mutex<Option<std::sync::mpsc::Sender<ControlEvent>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(None));

/// Inject a single control event via the shared controller (used by the
/// `remote_inject` command when driving input over a WebRTC data channel).
pub fn inject(ev: ControlEvent) {
    let mut guard = CONTROLLER.lock();
    if guard.is_none() {
        *guard = spawn_controller();
    }
    if let Some(tx) = guard.as_ref() {
        if tx.send(ev).is_err() {
            *guard = None; // Thread died; a fresh one spawns on the next event.
        }
    }
}
