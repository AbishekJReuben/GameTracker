//! Remote input injection: translate control events from the phone into real
//! mouse/keyboard actions via `enigo`. Runs on a dedicated OS thread (see
//! `spawn_controller`) because `Enigo` is not `Send` and must not cross `.await`.

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde::Deserialize;
use std::{collections::{HashMap,HashSet},sync::{Arc,atomic::{AtomicBool,Ordering}}};

/// A single control instruction from the companion app. Coordinates are
/// normalized 0.0–1.0 relative to the streamed screen, so they survive scaling.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ControlEvent {
    /// Internal ownership wrapper; never accepted as a guest event variant.
    #[serde(skip)]
    Owned { session_id:String, authorized:Option<Arc<AtomicBool>>,event:Box<ControlEvent> },
    #[serde(rename="viewinput")]
    Epoch { epoch:u64,#[serde(default)] anchor:Option<[f32;2]>,event:Box<ControlEvent> },
    #[serde(skip)]
    ReleaseSession {session_id:String},
    /// Move the cursor to a normalized position.
    Move { x: f32, y: f32 },
    /// Move relatively (like trackpad).
    Moverel { dx: i32, dy: i32 },
    /// Switch which monitor is captured AND targeted for absolute positioning.
    /// Sent by the PRIMARY tab's display switcher — the primary capture follows it.
    Monitor { index: usize },
    /// Re-target absolute-input bounds at monitor `index` WITHOUT changing which
    /// monitor is captured. Constructed internally (the phone never sends it) to pin
    /// each event to the right display: a pop-out tab controls display 2 without
    /// repointing display 1's capture, and the primary re-pins to its own display so
    /// an interleaved pop-out event can't leave the shared cursor on the wrong screen.
    InputMonitor { index: usize },
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
    /// Update the virtual Xbox 360 controller (a physical controller attached to
    /// the phone, streamed here so PC games see a real XInput device). The pad
    /// state fields are flattened into this message by serde's internal tagging.
    Gamepad(crate::remote::gamepad::GamepadState),
    /// Release the virtual controller to neutral and unplug it.
    Gamepadstop,
    /// Apply several events atomically, in order. Multi-part gestures (Ctrl+C =
    /// keydown ctrl → key c → keyup ctrl) used to arrive as separate Tauri
    /// invokes, and invoke dispatch does not guarantee ordering — sometimes the
    /// keyup landed before the key and the PC saw a bare "c" typed after Ctrl
    /// was released. One wire message can't be reordered against itself.
    Seq { events: Vec<ControlEvent> },
}

fn button_for(name: &Option<String>) -> Button {
    match name.as_deref().unwrap_or("left").to_ascii_lowercase().as_str() {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    }
}
fn key_for(name:&str)->Option<Key>{special_key(name).or_else(||{let mut chars=name.chars();let key=chars.next()?;chars.next().is_none().then_some(Key::Unicode(key))})}
fn held_key(key:Key)->Option<Key>{
    #[cfg(windows)]{windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY::try_from(key).ok().map(|vk|Key::Other((if matches!(key,Key::Unicode(_)){vk.0&0xff}else{vk.0}) as u32))}
    #[cfg(not(windows))]{match key{Key::Unicode(c)if c.is_ascii()=>Some(Key::Unicode(c.to_ascii_lowercase())),Key::Unicode(_)=>None,key=>Some(key)}}
}
#[derive(Default)]
struct Holds<K:Eq+std::hash::Hash>(HashMap<K,HashSet<String>>);
impl<K:Eq+std::hash::Hash+Copy> Holds<K>{
    fn held(&self,key:K)->bool{self.0.contains_key(&key)}
    fn press(&mut self,key:K,owner:String){self.0.entry(key).or_default().insert(owner);}
    fn release(&mut self,key:K,owner:&str)->bool{let empty=self.0.get_mut(&key).is_some_and(|owners|owners.remove(owner)&&owners.is_empty());if empty{self.0.remove(&key);}empty}
    fn end(&mut self,owner:&str)->Vec<K>{let keys=self.0.keys().copied().collect::<Vec<_>>();keys.into_iter().filter(|key|self.release(*key,owner)).collect()}
}
fn apply_key(name:&str,direction:Direction,owner:String,held:&mut Holds<Key>,mut inject:impl FnMut(Key,Direction)->enigo::InputResult<()>)->enigo::InputResult<()>{
    let Some(original)=key_for(name)else{return Ok(());};let physical=held_key(original);
    if direction==Direction::Click{return if physical.is_some_and(|key|held.held(key)){Ok(())}else{inject(original,Direction::Click)};}
    // Unicode text fallback is a click even for Press/Release in Enigo. Holds
    // require an actual OS VK and inject the exact same Key on both boundaries.
    let Some(key)=physical else{return Ok(());};
    if direction==Direction::Press{let result=if held.held(key){Ok(())}else{inject(key,Direction::Press)};if result.is_ok(){held.press(key,owner);}result}
    else if held.release(key,&owner){inject(key,Direction::Release)}else{Ok(())}
}
/// The blocked-epoch dispatcher still permits owned releases, including virtual
/// controller neutralization. This function is also the actual dispatch seam
/// used by the no-OS-input regression, rather than a parallel client predicate.
fn dispatch_releases(event:ControlEvent,apply:&mut impl FnMut(ControlEvent)){
    match event{
        ControlEvent::Up{..}|ControlEvent::Keyup{..}|ControlEvent::Gamepadstop=>apply(event),
        ControlEvent::Seq{events}=>for event in events{dispatch_releases(event,apply);},
        _=>{}
    }
}
fn non_coordinate(event:&ControlEvent)->bool{match event{
    ControlEvent::Text{..}|ControlEvent::Key{..}|ControlEvent::Keydown{..}|ControlEvent::Keyup{..}|ControlEvent::Gamepad(..)|ControlEvent::Gamepadstop=>true,
    ControlEvent::Seq{events}=>events.iter().all(non_coordinate),_=>false
}}
fn dispatch_pending(event:ControlEvent,authorized:bool,apply:&mut impl FnMut(ControlEvent)){
    if authorized&&non_coordinate(&event){apply(event);}else{dispatch_releases(event,apply);}
}
fn release_gamepad(owner:&mut Option<String>,sid:&str,stop:impl FnOnce()){
    if owner.as_deref()==Some(sid){*owner=None;stop();}
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
        "printscreen" | "printscr" | "prtsc" | "prtscr" => Key::PrintScr,
        // enigo 0.3 spells this `Numlock` (not NumLock).
        "numlock" | "num" => Key::Numlock,
        // Windows: Key::Scroll (VK_SCROLL); Linux has ScrollLock — this app is Win-only.
        "scrolllock" | "scroll" | "scrlk" => Key::Scroll,
        "pause" | "break" => Key::Pause,
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
    session_id:Option<String>,
    epoch_view:Option<Arc<super::view::CaptureIdentity>>,
    anchors:HashMap<String,(u64,i32,i32)>,
    held_buttons:Holds<Button>,
    held_keys:Holds<Key>,
    gamepad_owner:Option<String>,
}

impl Controller {
    fn new() -> Option<Self> {
        let enigo = Enigo::new(&Settings::default()).ok()?;
        let mut c = Self { enigo, mx: 0, my: 0, mw: 1920, mh: 1080,session_id:None,epoch_view:None,anchors:HashMap::new(),held_buttons:Holds(HashMap::new()),held_keys:Holds(HashMap::new()),gamepad_owner:None };
        c.set_monitor(crate::remote::capture::selected_monitor());
        Some(c)
    }

    /// Point absolute input at monitor `index` AND make the capture follow it (the
    /// primary tab's explicit display switch).
    fn set_monitor(&mut self, index: usize) {
        crate::remote::capture::set_selected_monitor(index);
        self.set_input_bounds(index);
    }

    /// Point absolute input at monitor `index` WITHOUT changing the captured monitor.
    /// Used to pin each event to the display it came from (primary vs a pop-out)
    /// while the two share this single cursor/controller.
    fn set_input_bounds(&mut self, index: usize) {
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

    /// Move the cursor to an absolute virtual-desktop pixel. On Windows this injects
    /// a real mouse-move via `SendInput` (ABSOLUTE|VIRTUALDESK) rather than
    /// `SetCursorPos`: `SetCursorPos` only teleports the pointer, so the shell never
    /// starts its hover timer and taskbar thumbnail previews (Aero Peek) never appear
    /// under the remote cursor. `SendInput` posts a genuine move into the input queue
    /// (like AnyDesk/RDP), so hover/preview works; normalizing to the 0..65535
    /// virtual-desktop range preserves multi-monitor + negative offsets. Elsewhere,
    /// falls back to enigo's absolute move.
    fn move_abs(&mut self, px: i32, py: i32) {
        #[cfg(windows)]
        {
            use windows::Win32::UI::Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
                MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT,
            };
            use windows::Win32::UI::WindowsAndMessaging::{
                GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
                SM_YVIRTUALSCREEN,
            };
            unsafe {
                let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) as u32;
                let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) as u32;
                let nx = super::input_mapping::absolute_bin(px,vx,vw);
                let ny = super::input_mapping::absolute_bin(py,vy,vh);
                let input = INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: nx,
                            dy: ny,
                            mouseData: 0,
                            dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
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
        let owner=self.owner();apply_key(name,dir,owner,&mut self.held_keys,|key,direction|self.enigo.key(key,direction))
    }

    fn apply(&mut self, ev: ControlEvent) {
        let _ = match ev {
            ControlEvent::Owned{session_id,authorized,event}=>{
                let previous=self.session_id.replace(session_id.clone());
                let admitted=authorized.as_ref().is_some_and(|flag|flag.load(Ordering::Acquire));
                if !admitted{self.releases_only(*event);self.session_id=previous;return;}
                match *event {
                    ControlEvent::Epoch{epoch,anchor,event}=>{
                        if non_coordinate(&event){dispatch_pending(*event,admitted,&mut |event|self.apply(event));self.session_id=previous;return;}
                        match super::view_session::input(&session_id,Some(epoch)){
                            super::view_session::InputView::Ready(view)=>{
                                self.mx=view.view.source.x;self.my=view.view.source.y;self.mw=view.view.source.width as i32;self.mh=view.view.source.height as i32;
                                let old=self.epoch_view.replace(view);
                                if let Some([x,y])=anchor{if let Some((px,py))=self.mapped_point(x,y){self.move_abs(px,py);self.apply(*event);}else{self.releases_only(*event);}}
                                else{if matches!(*event,ControlEvent::Down{..}|ControlEvent::Click{x:None,y:None,..}|ControlEvent::Scroll{..}){self.remember_actual();}self.apply(*event);}self.epoch_view=old;
                            },_=>self.releases_only(*event),
                        }
                    },
                    ControlEvent::Monitor{index} if super::view_session::legacy_monitor(&session_id,index)=>{},
                    event=>match super::view_session::input(&session_id,None){super::view_session::InputView::Legacy=>self.apply(event),_=>self.releases_only(event)},
                }
                self.session_id=previous;Ok(())
            },
            ControlEvent::Epoch{..}=>Ok(()), // no unowned epoch messages
            ControlEvent::ReleaseSession{session_id}=>{self.release_owned(&session_id);Ok(())},
            ControlEvent::Move { x, y } => {
                let Some((px,py))=self.mapped_point(x,y)else{return;};
                self.move_abs(px, py);
                Ok(())
            }
            ControlEvent::Moverel { dx, dy } => {
                let result=self.enigo.move_mouse(dx,dy,Coordinate::Rel);self.remember_actual();result
            }
            ControlEvent::Monitor { index } => {
                self.set_monitor(index);
                Ok(())
            }
            ControlEvent::InputMonitor { index } => {
                self.set_input_bounds(index);
                Ok(())
            }
            ControlEvent::Click { x, y, button } => {
                let button=button_for(&button);if self.held_buttons.held(button){return;}
                if let (Some(x), Some(y)) = (x, y) {
                    let Some((px,py))=self.mapped_point(x,y)else{return;};
                    self.move_abs(px, py);
                }
                if !self.valid_anchor(){return;}
                let result=self.enigo.button(button, Direction::Click);if result.is_ok(){self.click_reaction();}result
            }
            ControlEvent::Down { button } => {
                if !self.valid_anchor(){return;}
                let owner=self.owner();let button=button_for(&button);
                let result=if self.held_buttons.held(button){Ok(())}else{self.enigo.button(button,Direction::Press)};if result.is_ok(){self.held_buttons.press(button,owner);self.click_reaction();}result
            }
            ControlEvent::Up { button } => {
                let owner=self.owner();let button=button_for(&button);
                if self.held_buttons.release(button,&owner){self.enigo.button(button,Direction::Release)}else{Ok(())}
            }
            ControlEvent::Scroll { dx, dy } => {
                if !self.valid_anchor(){return;}
                if let Some(dx) = dx {
                    if dx != 0 {
                        let _ = self.enigo.scroll(dx, Axis::Horizontal);
                    }
                }
                self.enigo.scroll(dy, Axis::Vertical)
            }
            ControlEvent::Text { value } => self.enigo.text(&value),
            ControlEvent::Key { name } => self.key_dir(&name, Direction::Click),
            ControlEvent::Keydown { name } => self.key_dir(&name,Direction::Press),
            ControlEvent::Keyup { name } => self.key_dir(&name,Direction::Release),
            // Gamepad events bypass enigo entirely — they drive the virtual XInput
            // controller, which owns its own dedicated thread (see `gamepad.rs`).
            ControlEvent::Gamepad(state) => {
                self.gamepad_owner=Some(self.owner());
                crate::remote::gamepad::apply(state);
                Ok(())
            }
            ControlEvent::Gamepadstop => {
                let owner=self.owner();release_gamepad(&mut self.gamepad_owner,&owner,crate::remote::gamepad::stop);
                Ok(())
            }
            ControlEvent::Seq { events } => {
                for e in events {
                    self.apply(e);
                }
                Ok(())
            }
        };
    }
    fn owner(&self)->String{self.session_id.clone().unwrap_or_default()}
    fn releases_only(&mut self,event:ControlEvent){dispatch_releases(event,&mut |event|self.apply(event));}
    fn release_owned(&mut self,sid:&str){
        for button in self.held_buttons.end(sid){let _=self.enigo.button(button,Direction::Release);}
        for key in self.held_keys.end(sid){let _=self.enigo.key(key,Direction::Release);}self.anchors.remove(sid);
        release_gamepad(&mut self.gamepad_owner,sid,crate::remote::gamepad::stop);
    }
    fn mapped_point(&mut self,x:f32,y:f32)->Option<(i32,i32)>{
        if let Some(view)=&self.epoch_view{let point=super::input_mapping::point(&view.view,x,y);let owner=self.owner();if let Some((px,py))=point{self.anchors.insert(owner,(view.view.epoch,px,py));}else{self.anchors.remove(&owner);}point}
        else if x.is_finite()&&y.is_finite(){Some(self.to_abs(x,y))}else{None}
    }
    fn valid_anchor(&self)->bool{
        let Some(view)=&self.epoch_view else{return true;};
        self.anchors.get(&self.owner()).is_some_and(|(epoch,x,y)|*epoch==view.view.epoch&&super::input_mapping::contains(&view.view,*x,*y))
    }
    fn remember_actual(&mut self){
        #[cfg(windows)]if let Some(view)=&self.epoch_view{unsafe{let mut p=windows::Win32::Foundation::POINT::default();let owner=self.owner();if windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p).is_ok()&&super::input_mapping::contains(&view.view,p.x,p.y){self.anchors.insert(owner,(view.view.epoch,p.x,p.y));}else{self.anchors.remove(&owner);}}}
    }
    fn click_reaction(&self) {
        #[cfg(windows)] if let Some(session)=&self.session_id {unsafe{
            let mut point=windows::Win32::Foundation::POINT::default();
            if windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point).is_ok(){crate::remote::overlay::reaction(session,point.x,point.y);}
        }}
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
        #[cfg(windows)]let _dpi=super::display::DpiScope::physical();
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

/// Inject a single control event from the PRIMARY tab via the shared controller
/// (the `remote_inject` command, WebRTC data channel).
///
/// Every event is preceded by a bounds-only pin to the primary-selected monitor, so
/// a pop-out tab's interleaved input (which pins to its own display) can never leave
/// the shared cursor mapped to the wrong screen. The explicit `Monitor` switch is
/// exempt — it sets the bounds itself and is the only event allowed to move the
/// globally-captured monitor.
pub fn inject(ev: ControlEvent) {
    let mut guard = CONTROLLER.lock();
    if guard.is_none() {
        *guard = spawn_controller();
    }
    if let Some(tx) = guard.as_ref() {
        let needs_pin = !matches!(ev, ControlEvent::Monitor { .. });
        let ok = (!needs_pin
            || tx
                .send(ControlEvent::InputMonitor { index: crate::remote::capture::selected_monitor() })
                .is_ok())
            && tx.send(ev).is_ok();
        if !ok {
            *guard = None; // Thread died; a fresh one spawns on the next event.
        }
    }
}

/// Inject a single control event from a pop-out tab locked to `monitor` (the
/// `remote_inject_on` command). Pins absolute input to that display and applies the
/// event under one lock so a concurrent primary inject can't land between them.
///
/// Crucially this pins **input bounds only** — it must NOT change `SELECTED_MONITOR`
/// (the monitor the PRIMARY tab captures). Sending `ControlEvent::Monitor` here was
/// the bug that made controlling a pop-out repoint the original tab's display and
/// collapse both feeds onto one monitor.
pub fn inject_on_monitor(monitor: usize, ev: ControlEvent) {
    let mut guard = CONTROLLER.lock();
    if guard.is_none() {
        *guard = spawn_controller();
    }
    if let Some(tx) = guard.as_ref() {
        if tx.send(ControlEvent::InputMonitor { index: monitor }).is_err() || tx.send(ev).is_err() {
            *guard = None;
        }
    }
}
/// Session identity accompanies input only after negotiated authorization. The
/// injector's ordering/anchor remains unchanged; decoration receives successful
/// button events at the true OS hotspot and never delays pointer movement.
pub fn inject_session(session_id:Option<String>,monitor:Option<usize>,event:ControlEvent) {
    let event=match session_id.filter(|s|!s.is_empty()&&s.len()<=128) {Some(session_id)=>{let authorized=super::view_session::authorization(&session_id);ControlEvent::Owned{session_id,authorized,event:Box::new(event)}},None=>event};
    if let Some(monitor)=monitor{inject_on_monitor(monitor,event);}else{inject(event);}
}
pub fn release_session(sid:&str){if let Some(tx)=CONTROLLER.lock().as_ref(){let _=tx.send(ControlEvent::ReleaseSession{session_id:sid.into()});}}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn pending_view_preserves_authorized_foreground_input_and_atomic_mixed_sequences(){
        let event=ControlEvent::Seq{events:vec![ControlEvent::Keydown{name:"ctrl".into()},ControlEvent::Text{value:"日本語😀".into()},ControlEvent::Keyup{name:"ctrl".into()},ControlEvent::Gamepadstop]};
        let mut delivered=Vec::new();dispatch_pending(event,true,&mut |event|delivered.push(event));assert!(matches!(&delivered[..],[ControlEvent::Seq{events}]if events.len()==4));
        let mut mixed=Vec::new();dispatch_pending(ControlEvent::Seq{events:vec![ControlEvent::Keydown{name:"ctrl".into()},ControlEvent::Move{x:0.5,y:0.5},ControlEvent::Click{x:None,y:None,button:None},ControlEvent::Keyup{name:"ctrl".into()}]},true,&mut |event|mixed.push(event));assert!(matches!(&mixed[..],[ControlEvent::Keyup{..}]),"never partially execute mixed coordinate presses while pending");
        let mut retired=Vec::new();dispatch_pending(ControlEvent::Text{value:"must not type".into()},false,&mut |event|retired.push(event));assert!(retired.is_empty());
    }
    #[test]fn blocked_epoch_dispatch_preserves_nested_releases_and_scoped_gamepad_neutralization(){
        let event=ControlEvent::Seq{events:vec![ControlEvent::Move{x:0.5,y:0.5},ControlEvent::Gamepadstop,ControlEvent::Seq{events:vec![ControlEvent::Down{button:None},ControlEvent::Up{button:None},ControlEvent::Keyup{name:"CTRL".into()}]}]};
        let mut released=Vec::new();dispatch_releases(event,&mut |event|released.push(match event{ControlEvent::Gamepadstop=>"pad",ControlEvent::Up{..}=>"mouse",ControlEvent::Keyup{..}=>"key",_=>panic!("blocked action dispatched")}));assert_eq!(released,vec!["pad","mouse","key"]);
        let mut owner=Some("active".into());let mut stops=0;release_gamepad(&mut owner,"retired",||stops+=1);assert_eq!(stops,0);assert_eq!(owner.as_deref(),Some("active"));release_gamepad(&mut owner,"active",||stops+=1);release_gamepad(&mut owner,"active",||stops+=1);assert_eq!(stops,1);assert!(owner.is_none());
    }
    #[test]fn aliases_and_case_share_actual_key_and_button_ownership(){
        let mut keys=Holds(HashMap::new());let ctrl=key_for("ctrl").unwrap();assert_eq!(key_for("CONTROL"),Some(ctrl));assert_eq!(key_for("Ctrl"),Some(ctrl));
        keys.press(ctrl,"a".into());keys.press(key_for("CONTROL").unwrap(),"b".into());
        assert!(keys.held(key_for("CTRL").unwrap()),"one-shot Click must be suppressed while any session holds the key");
        assert!(!keys.release(key_for("control").unwrap(),"a"));assert!(keys.held(ctrl));assert!(!keys.release(ctrl,"retired-c"));assert!(keys.release(key_for("Ctrl").unwrap(),"b"));assert!(keys.0.is_empty());
        assert!(key_for("").is_none());assert!(key_for("invalid-key-name").is_none());assert_eq!(held_key(key_for("C").unwrap()),held_key(key_for("c").unwrap()));assert_eq!(key_for("C"),Some(Key::Unicode('C')));
        let mut buttons=Holds(HashMap::new());let left=button_for(&None);assert_eq!(left,button_for(&Some("unknown-defaults-to-left".into())));
        buttons.press(left,"a".into());buttons.press(button_for(&Some("LEFT".into())),"b".into());
        assert!(buttons.held(left),"Direction::Click would release an active drag and must not be sent");assert!(buttons.end("a").is_empty());assert_eq!(buttons.end("b"),vec![left]);assert!(buttons.0.is_empty());
        assert_eq!(button_for(&Some("RIGHT".into())),Button::Right);
    }
    #[test]fn injection_adapter_uses_exact_physical_key_for_alias_holds_and_preserves_one_shot_unicode(){
        let mut held=Holds(HashMap::new());let mut calls=Vec::new();
        for(name,direction,owner)in[("C",Direction::Press,"a"),("c",Direction::Press,"b"),("C",Direction::Click,"b"),("c",Direction::Release,"a"),("C",Direction::Release,"b")]{apply_key(name,direction,owner.into(),&mut held,|key,dir|{calls.push((key,dir));Ok(())}).unwrap();}
        assert_eq!(calls.len(),2);assert_eq!(calls[0].0,calls[1].0);assert_eq!(calls[0].1,Direction::Press);assert_eq!(calls[1].1,Direction::Release);assert!(held.0.is_empty());
        apply_key("C",Direction::Click,"a".into(),&mut held,|key,dir|{calls.push((key,dir));Ok(())}).unwrap();assert_eq!(calls.last(),Some(&(Key::Unicode('C'),Direction::Click)));
        let before=calls.len();for direction in [Direction::Press,Direction::Release]{apply_key("😀",direction,"a".into(),&mut held,|key,dir|{calls.push((key,dir));Ok(())}).unwrap();}assert_eq!(calls.len(),before);assert!(held.0.is_empty());
    }
    #[test]fn cleanup_releases_only_the_last_owner_and_never_another_sessions_holds(){
        let mut keys=Holds(HashMap::new());keys.press(Key::Control,"a".into());keys.press(Key::Control,"b".into());keys.press(Key::Shift,"a".into());keys.press(Key::Meta,"b".into());
        assert_eq!(keys.end("a"),vec![Key::Shift]);assert!(keys.held(Key::Control));assert!(keys.held(Key::Meta));assert!(keys.end("a").is_empty());let released=keys.end("b");assert_eq!(released.len(),2);assert!(released.contains(&Key::Control)&&released.contains(&Key::Meta));assert!(keys.0.is_empty());
    }
}
