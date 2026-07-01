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
        _ => return None,
    })
}

struct Controller {
    enigo: Enigo,
    w: i32,
    h: i32,
}

impl Controller {
    fn new() -> Option<Self> {
        let enigo = Enigo::new(&Settings::default()).ok()?;
        let (w, h) = enigo.main_display().unwrap_or((1920, 1080));
        Some(Self { enigo, w, h })
    }

    fn to_abs(&self, x: f32, y: f32) -> (i32, i32) {
        let px = (x.clamp(0.0, 1.0) * self.w as f32).round() as i32;
        let py = (y.clamp(0.0, 1.0) * self.h as f32).round() as i32;
        (px, py)
    }

    fn apply(&mut self, ev: ControlEvent) {
        let _ = match ev {
            ControlEvent::Move { x, y } => {
                let (px, py) = self.to_abs(x, y);
                self.enigo.move_mouse(px, py, Coordinate::Abs)
            }
            ControlEvent::Moverel { dx, dy } => {
                self.enigo.move_mouse(dx, dy, Coordinate::Rel)
            }
            ControlEvent::Click { x, y, button } => {
                if let (Some(x), Some(y)) = (x, y) {
                    let (px, py) = self.to_abs(x, y);
                    let _ = self.enigo.move_mouse(px, py, Coordinate::Abs);
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
            ControlEvent::Key { name } => match special_key(&name) {
                Some(k) => self.enigo.key(k, Direction::Click),
                None => {
                    // Single printable char fallback.
                    if let Some(c) = name.chars().next().filter(|_| name.chars().count() == 1) {
                        self.enigo.key(Key::Unicode(c), Direction::Click)
                    } else {
                        Ok(())
                    }
                }
            },
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
