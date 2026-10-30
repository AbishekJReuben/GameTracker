//! The orb: a native window that can't freeze, because nothing on its thread ever
//! waits. It never touches the database or the WebView; it reports what the user did
//! over a channel and is told what to show.
//!
//! Three windows, top to bottom:
//! - `hit` is exactly the orb's shape and draws nothing. It takes the mouse.
//! - `glass` draws the orb and its glow. It is click-through, so the glow never eats
//!   a click. It stays the same size, so the orb can't jump when `stage` changes.
//! - `stage` is click-through and hidden at rest. It holds whatever is bigger than
//!   the orb: the ripple, the peek card and the shape that grows into the panel.

mod fullscreen;
mod hotkey;
pub mod motion;
pub mod place;
mod scene;

use motion::{panel_rect, snap, Edge, Rect};
use place::{locate, monitor_at, monitors, resolve, Monitor, Place};
use scene::{OrbScene, StageScene};
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::core::{w, Result, PCWSTR};
use windows::System::DispatcherQueueController;
use windows::UI::Composition::Compositor;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::WinRT::*;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::Controls::WM_MOUSELEAVE;
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::{DragAcceptFiles, DragFinish, DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::*;

pub use scene::Rim;

const ORB_DIP: f32 = 54.0;
/// Room round the orb for its glow.
const MARGIN_DIP: f32 = 34.0;
/// Between a resting orb and the screen edge.
const GAP_DIP: f32 = 14.0;
const PANEL_GAP_DIP: f32 = 14.0;
/// How much of a tucked orb stays on screen.
const SLIVER_DIP: f32 = 8.0;
/// Pointer travel that turns a press into a drag.
const DRAG_DIP: f32 = 5.0;
const TUCK_AFTER: Duration = Duration::from_secs(4);
const TUCK_DIM: f32 = 0.62;
const PEEK_HOLD_MS: f32 = 1900.0;
/// The panel takes over once the shape looks finished, not when its spring has
/// settled to the last pixel. That tail is what made an open feel slow.
const REVEAL_AT: f32 = 0.8;
/// How long the shape waits for the page's first frame. A hidden page has to wake up
/// before it can draw; fading sooner shows an empty panel. A page that stays silent
/// this long isn't worth waiting for.
const PAINT_WAIT: Duration = Duration::from_millis(280);
const REVEAL_FADE_MS: f32 = 130.0;

const WM_WAKE: u32 = WM_APP + 1;
const WM_FOREGROUND: u32 = WM_APP + 2;
const TIMER_TUCK: usize = 1;
const TIMER_WATCH: usize = 2;
const TIMER_STAGE: usize = 3;
const TIMER_MORPH: usize = 4;
const TIMER_REVEAL: usize = 5;
const TIMER_FOREGROUND: usize = 6;
const TIMER_SPARK: usize = 7;
const HOTKEY_ID: i32 = 1;

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub tuck: bool,
    pub spark: bool,
    pub peek: bool,
    /// Keep the orb and panel out of screen capture and the phone stream.
    pub private: bool,
    pub hotkey: String,
    /// Logical size of the panel the next open should grow into.
    pub panel: (f32, f32),
}

/// What the shell tells the orb.
pub enum ToOrb {
    Config(Config),
    Close,
    /// A note landed. `from` is the device name when it came from elsewhere.
    Note { body: String, from: Option<String> },
    Unread(u32),
    Rim(Rim),
    Recording(bool),
    /// The panel's page has drawn, or will draw as soon as it's shown.
    PanelReady(isize),
    /// The panel window is gone, so a new one has to be built before the next open.
    PanelGone,
    /// The page has drawn since it was shown, so the shape can fade off it.
    PanelPainted,
}

/// What the orb tells the shell. Nothing here may be answered on the orb's thread.
pub enum FromOrb {
    /// The pointer is near: start building the panel now.
    Prewarm(Rect),
    Open(Rect),
    Reveal,
    Focus,
    Close,
    Closed(Option<Rect>),
    Moved(Place),
    Dropped(Vec<PathBuf>),
    HotkeyTaken(String),
}

#[derive(Clone)]
pub struct Handle {
    tx: Sender<ToOrb>,
    hit: Arc<AtomicIsize>,
}

impl Handle {
    pub fn send(&self, message: ToOrb) {
        let _ = self.tx.send(message);
        let hit = self.hit.load(Ordering::SeqCst);
        if hit != 0 {
            let _ = unsafe { PostMessageW(HWND(hit as _), WM_WAKE, WPARAM(0), LPARAM(0)) };
        }
    }
}

pub fn spawn(config: Config, place: Option<Place>, legacy: Option<String>, events: Sender<FromOrb>) -> Handle {
    let (tx, rx) = std::sync::mpsc::channel();
    let hit = Arc::new(AtomicIsize::new(0));
    let published = hit.clone();
    let _ = std::thread::Builder::new().name("notes-orb".into()).spawn(move || {
        if let Err(e) = unsafe { run(config, place, legacy, events, rx, published) } {
            crate::hostproc::trace(&format!("notes orb failed: {e}"));
            std::process::exit(78);
        }
    });
    Handle { tx, hit }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Panel {
    Closed,
    Opening,
    Revealing,
    Open,
    Closing,
}

#[derive(Clone, Copy)]
struct Press {
    /// Pointer at the press, screen pixels.
    start: (i32, i32),
    /// Pointer relative to the orb's corner.
    grab: (i32, i32),
    moved: bool,
    last: (i32, i32),
    at: Instant,
    velocity: (f32, f32),
}

struct Scenes {
    orb: OrbScene,
    stage: StageScene,
}

struct Orb {
    hit: HWND,
    glass: HWND,
    stage: HWND,
    compositor: Compositor,
    scenes: RefCell<Option<Scenes>>,
    events: Sender<FromOrb>,
    rx: Receiver<ToOrb>,
    config: RefCell<Config>,
    place: RefCell<Place>,
    monitor: RefCell<Monitor>,
    pos: Cell<(i32, i32)>,
    scale: Cell<f32>,
    press: Cell<Option<Press>>,
    flying: Cell<bool>,
    hover: Cell<bool>,
    tucked: Cell<bool>,
    hidden: Cell<bool>,
    reduced: Cell<bool>,
    panel: Cell<Panel>,
    panel_hwnd: Cell<isize>,
    panel_ready: Cell<bool>,
    panel_rect: Cell<Rect>,
    /// Where the user left a panel they moved, until the orb itself moves.
    panel_kept: Cell<Option<Rect>>,
    morph_done: Cell<bool>,
    shown_at: Cell<Option<Instant>>,
    painted: Cell<bool>,
    fading_at: Cell<Option<Instant>>,
    focus_before: Cell<isize>,
    rim: Cell<Rim>,
    unread: Cell<u32>,
    hotkey_on: Cell<bool>,
}

thread_local! {
    static ORB: Cell<*const Orb> = const { Cell::new(std::ptr::null()) };
}

fn orb() -> Option<&'static Orb> {
    let p = ORB.with(Cell::get);
    (!p.is_null()).then(|| unsafe { &*p })
}

fn metrics(scale: f32) -> (i32, i32, i32) {
    let px = |dip: f32| (dip * scale).round() as i32;
    (px(ORB_DIP), px(MARGIN_DIP), px(GAP_DIP))
}

unsafe fn reduced_motion() -> bool {
    let mut on = BOOL(1);
    let _ = SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, Some(&mut on as *mut _ as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
    !on.as_bool()
}

unsafe fn run(config: Config, place: Option<Place>, legacy: Option<String>, events: Sender<FromOrb>, rx: Receiver<ToOrb>, published: Arc<AtomicIsize>) -> Result<()> {
    let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    RoInitialize(RO_INIT_SINGLETHREADED)?;
    let options = DispatcherQueueOptions {
        dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
        threadType: DQTYPE_THREAD_CURRENT,
        apartmentType: DQTAT_COM_NONE,
    };
    let _queue: DispatcherQueueController = CreateDispatcherQueueController(options)?;
    let compositor = Compositor::new()?;
    let module = GetModuleHandleW(None)?;
    let instance = HINSTANCE(module.0);
    let cursor = LoadCursorW(None, IDC_HAND)?;
    let hit_class = WNDCLASSW { lpfnWndProc: Some(hit_proc), hInstance: instance, lpszClassName: w!("GameTrackerNotesOrb"), hCursor: cursor, ..Default::default() };
    let glass_class = WNDCLASSW { lpfnWndProc: Some(glass_proc), hInstance: instance, lpszClassName: w!("GameTrackerNotesGlass"), ..Default::default() };
    RegisterClassW(&hit_class);
    RegisterClassW(&glass_class);

    let list = monitors();
    let place = place
        .or_else(|| legacy.and_then(|raw| place::from_legacy(&raw, &list)))
        .or_else(|| place::default_place(&list))
        .ok_or_else(windows::core::Error::from_win32)?;
    let sizes = |m: &Monitor| {
        let (size, _, gap) = metrics(m.scale);
        (size, gap)
    };
    let (monitor, x, y) = resolve(&place, &list, sizes).ok_or_else(windows::core::Error::from_win32)?;
    let monitor = monitor.clone();
    let scale = monitor.scale;
    let (size, margin, _) = metrics(scale);
    let window = size + margin * 2;

    let popup = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP;
    let ghost = popup | WS_EX_TRANSPARENT | WS_EX_LAYERED;
    let make = |class: PCWSTR, ex: WINDOW_EX_STYLE, x: i32, y: i32, w_: i32, h: i32| CreateWindowExW(ex, class, w!("Notes"), WS_POPUP, x, y, w_, h, None, None, instance, None);
    let stage = make(w!("GameTrackerNotesGlass"), ghost, x, y, size, size)?;
    let glass = make(w!("GameTrackerNotesGlass"), ghost, x - margin, y - margin, window, window)?;
    let hit = make(w!("GameTrackerNotesOrb"), popup, x, y, size, size)?;
    for hwnd in [stage, glass] {
        SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA)?;
    }
    shape_hit(hit, size, size, 0, 0);

    // The app runs elevated, and Windows blocks drags from Explorer into an elevated
    // window unless these three messages are let through.
    for message in [WM_DROPFILES, WM_COPYDATA, 0x0049] {
        let _ = ChangeWindowMessageFilterEx(hit, message, MSGFLT_ALLOW, None);
    }
    DragAcceptFiles(hit, true);

    let scenes = build_scenes(&compositor, glass, stage, window, size, scale)?;
    let state: &'static Orb = Box::leak(Box::new(Orb {
        hit,
        glass,
        stage,
        compositor,
        scenes: RefCell::new(Some(scenes)),
        events,
        rx,
        config: RefCell::new(config),
        place: RefCell::new(place),
        monitor: RefCell::new(monitor),
        pos: Cell::new((x, y)),
        scale: Cell::new(scale),
        press: Cell::new(None),
        flying: Cell::new(false),
        hover: Cell::new(false),
        tucked: Cell::new(false),
        hidden: Cell::new(false),
        reduced: Cell::new(reduced_motion()),
        panel: Cell::new(Panel::Closed),
        panel_hwnd: Cell::new(0),
        panel_ready: Cell::new(false),
        panel_rect: Cell::new(Rect { x: 0, y: 0, w: 0, h: 0 }),
        panel_kept: Cell::new(None),
        morph_done: Cell::new(false),
        shown_at: Cell::new(None),
        painted: Cell::new(false),
        fading_at: Cell::new(None),
        focus_before: Cell::new(0),
        rim: Cell::new(Rim::Synced),
        unread: Cell::new(0),
        hotkey_on: Cell::new(false),
    }));
    ORB.with(|o| o.set(state as *const Orb));

    state.clip_to_work();
    state.apply_privacy();
    let _ = ShowWindow(glass, SW_SHOWNOACTIVATE);
    let _ = ShowWindow(hit, SW_SHOWNOACTIVATE);
    state.register_hotkey();
    SetTimer(hit, TIMER_WATCH, 2000, None);
    state.arm_tuck();
    let _hook: HWINEVENTHOOK = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(foreground_changed), 0, 0, WINEVENT_OUTOFCONTEXT);
    published.store(hit.0 as isize, Ordering::SeqCst);
    state.drain();

    let mut msg = MSG::default();
    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
        DispatchMessageW(&msg);
    }
    Ok(())
}

unsafe fn build_scenes(compositor: &Compositor, glass: HWND, stage: HWND, window: i32, size: i32, scale: f32) -> Result<Scenes> {
    let orb = OrbScene::new(compositor.clone(), glass, window as f32, size as f32, scale)?;
    let stage = orb.stage(stage)?;
    Ok(Scenes { orb, stage })
}

/// What the window adds round what you see: Windows keeps invisible resize borders
/// outside the client area, and the rest of this file deals in what you see.
unsafe fn frame_of(panel: HWND) -> (i32, i32, i32, i32) {
    let (mut outer, seen) = (RECT::default(), visible_rect(panel));
    let _ = GetWindowRect(panel, &mut outer);
    (seen.x - outer.left, seen.y - outer.top, outer.right - seen.right(), outer.bottom - seen.bottom())
}

unsafe fn visible_rect(panel: HWND) -> Rect {
    let mut client = RECT::default();
    let _ = GetClientRect(panel, &mut client);
    let mut origin = POINT::default();
    let _ = ClientToScreen(panel, &mut origin);
    Rect { x: origin.x, y: origin.y, w: client.right, h: client.bottom }
}

/// The hit area: the orb's shape, or the sliver left when tucked.
unsafe fn shape_hit(hit: HWND, w_: i32, h: i32, x: i32, y: i32) {
    let radius = (w_.min(h) as f32 * 0.86) as i32;
    let region = CreateRoundRectRgn(x, y, x + w_ + 1, y + h + 1, radius, radius);
    let _ = SetWindowRgn(hit, region, true);
}

unsafe extern "system" fn foreground_changed(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    if let Some(o) = orb() {
        let _ = PostMessageW(o.hit, WM_FOREGROUND, WPARAM(0), LPARAM(0));
    }
}

unsafe extern "system" fn glass_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => LRESULT(1),
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

unsafe extern "system" fn hit_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let Some(o) = orb() else { return DefWindowProcW(hwnd, msg, wp, lp) };
    match msg {
        WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
        WM_ERASEBKGND => LRESULT(1),
        WM_LBUTTONDOWN => {
            o.down();
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            o.moved();
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            o.up();
            LRESULT(0)
        }
        WM_CAPTURECHANGED => {
            if HWND(lp.0 as _) != hwnd {
                o.capture_lost();
            }
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            o.left();
            LRESULT(0)
        }
        WM_DROPFILES => {
            o.dropped(HDROP(wp.0 as _));
            LRESULT(0)
        }
        WM_HOTKEY => {
            o.hotkey();
            LRESULT(0)
        }
        WM_TIMER => {
            o.timer(wp.0);
            LRESULT(0)
        }
        WM_WAKE => {
            o.drain();
            LRESULT(0)
        }
        WM_FOREGROUND => {
            SetTimer(hwnd, TIMER_FOREGROUND, 250, None);
            LRESULT(0)
        }
        WM_DPICHANGED => {
            // Mid-drag the orb is simply crossing a monitor. `settle` sorts it out.
            if o.press.get().is_none() && !o.flying.get() {
                o.relayout(true);
            }
            LRESULT(0)
        }
        WM_DISPLAYCHANGE => {
            o.relayout(false);
            LRESULT(0)
        }
        WM_SETTINGCHANGE => {
            o.reduced.set(reduced_motion());
            if wp.0 as u32 == SPI_SETWORKAREA.0 {
                o.relayout(false);
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

impl Orb {
    fn tell(&self, event: FromOrb) {
        let _ = self.events.send(event);
    }

    fn scene<T>(&self, f: impl FnOnce(&OrbScene, &StageScene) -> Result<T>) -> Option<T> {
        let scenes = self.scenes.borrow();
        let s = scenes.as_ref()?;
        match f(&s.orb, &s.stage) {
            Ok(v) => Some(v),
            Err(e) => {
                crate::hostproc::trace(&format!("notes orb: {e}"));
                None
            }
        }
    }

    fn sizes(&self) -> (i32, i32, i32) {
        metrics(self.scale.get())
    }

    fn orb_rect(&self) -> Rect {
        let (x, y) = self.pos.get();
        let (size, _, _) = self.sizes();
        Rect { x, y, w: size, h: size }
    }

    unsafe fn cursor(&self) -> (i32, i32) {
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        (p.x, p.y)
    }

    fn wanted_panel(&self) -> Rect {
        if let Some(kept) = self.panel_kept.get() {
            return kept;
        }
        let scale = self.scale.get();
        let (w_, h) = self.config.borrow().panel;
        let gap = (PANEL_GAP_DIP * scale).round() as i32;
        let work = self.monitor.borrow().work;
        panel_rect(self.orb_rect(), ((w_ * scale).round() as i32, (h * scale).round() as i32), work, gap)
    }

    unsafe fn move_to(&self, x: i32, y: i32) {
        self.pos.set((x, y));
        let (_, margin, _) = self.sizes();
        let flags = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE;
        let _ = SetWindowPos(self.glass, None, x - margin, y - margin, 0, 0, flags);
        let _ = SetWindowPos(self.hit, None, x, y, 0, 0, flags);
    }

    /// Nothing the orb draws may reach past the work area it rests on.
    unsafe fn clip_to_work(&self) {
        let (x, y) = self.pos.get();
        let (size, margin, _) = self.sizes();
        let window = size + margin * 2;
        let work = self.monitor.borrow().work;
        let (left, top) = (x - margin, y - margin);
        let inset = |n: i32| n.max(0) as f32;
        self.scene(|orb, _| orb.clip(inset(work.x - left), inset(work.y - top), inset(left + window - work.right()), inset(top + window - work.bottom())));
    }

    // ---- mouse ---------------------------------------------------------------

    unsafe fn down(&self) {
        self.flying.set(false);
        let _ = SetCapture(self.hit);
        let at = self.cursor();
        let (x, y) = self.pos.get();
        self.press.set(Some(Press {
            start: at,
            grab: (at.0 - x, at.1 - y),
            moved: false,
            last: at,
            at: Instant::now(),
            velocity: (0.0, 0.0),
        }));
        self.scene(|orb, _| orb.press());
        self.tell(FromOrb::Prewarm(self.wanted_panel()));
    }

    unsafe fn moved(&self) {
        let Some(mut press) = self.press.get() else {
            self.hovered();
            return;
        };
        let at = self.cursor();
        let (dx, dy) = (at.0 - press.start.0, at.1 - press.start.1);
        let threshold = DRAG_DIP * self.scale.get();
        if !press.moved {
            if ((dx * dx + dy * dy) as f32) < threshold * threshold {
                return;
            }
            press.moved = true;
            let _ = KillTimer(self.hit, TIMER_TUCK);
            self.scene(|orb, _| orb.unclip());
            if self.tucked.get() {
                self.untuck();
            }
        }
        let dt = press.at.elapsed().as_secs_f32();
        if dt > 0.001 {
            // Smoothed over a few events, so the last instant before a release
            // doesn't decide the whole throw.
            let k = (dt / 0.05).min(1.0);
            let raw = ((at.0 - press.last.0) as f32 / dt, (at.1 - press.last.1) as f32 / dt);
            press.velocity = (press.velocity.0 + (raw.0 - press.velocity.0) * k, press.velocity.1 + (raw.1 - press.velocity.1) * k);
            press.last = at;
            press.at = Instant::now();
        }
        self.press.set(Some(press));
        self.move_to(at.0 - press.grab.0, at.1 - press.grab.1);
        self.lean(press.velocity);
    }

    unsafe fn lean(&self, v: (f32, f32)) {
        if self.reduced.get() {
            return;
        }
        let speed = (v.0 * v.0 + v.1 * v.1).sqrt() / self.scale.get();
        let by = (speed / 9000.0).min(0.16);
        self.scene(|orb, _| orb.stretch(v.1.atan2(v.0), by));
    }

    unsafe fn up(&self) {
        let Some(press) = self.press.take() else { return };
        let _ = ReleaseCapture();
        if press.moved {
            self.settle(press.velocity);
        } else {
            self.scene(|orb, _| orb.hover(true, self.reduced.get()));
            match self.panel.get() {
                Panel::Closed => self.open(),
                Panel::Closing => {}
                _ => self.close(),
            }
        }
    }

    unsafe fn capture_lost(&self) {
        if let Some(press) = self.press.take() {
            if press.moved {
                self.settle(press.velocity);
            } else {
                self.scene(|orb, _| orb.hover(false, self.reduced.get()));
            }
        }
    }

    unsafe fn hovered(&self) {
        if self.hover.replace(true) {
            return;
        }
        let mut track = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE,
            hwndTrack: self.hit,
            dwHoverTime: 0,
        };
        let _ = TrackMouseEvent(&mut track);
        let _ = KillTimer(self.hit, TIMER_TUCK);
        if self.tucked.get() {
            self.untuck();
        }
        self.scene(|orb, _| orb.hover(true, self.reduced.get()));
        self.tell(FromOrb::Prewarm(self.wanted_panel()));
    }

    unsafe fn left(&self) {
        self.hover.set(false);
        if self.press.get().is_none() {
            self.scene(|orb, _| orb.hover(false, self.reduced.get()));
        }
        self.arm_tuck();
    }

    unsafe fn dropped(&self, drop: HDROP) {
        let count = DragQueryFileW(drop, u32::MAX, None);
        let mut files = Vec::new();
        for i in 0..count {
            let mut buf = vec![0u16; 1 + DragQueryFileW(drop, i, None) as usize];
            let n = DragQueryFileW(drop, i, Some(&mut buf)) as usize;
            files.push(PathBuf::from(String::from_utf16_lossy(&buf[..n])));
        }
        DragFinish(drop);
        if !files.is_empty() {
            self.tell(FromOrb::Dropped(files));
        }
    }

    // ---- throw and rest ------------------------------------------------------

    /// Carry the release's speed to the nearest edge on a spring. Runs here because
    /// this thread has nothing else to do, paced by the compositor's frames.
    unsafe fn settle(&self, velocity: (f32, f32)) {
        let (x, y) = self.pos.get();
        let list = monitors();
        let (size, _, gap) = self.sizes();
        let Some(monitor) = monitor_at(&list, x + size / 2, y + size / 2) else { return };
        let (tx, ty, edge) = snap(x, y, size, velocity.0, velocity.1, monitor.work, gap);
        let monitor = monitor.clone();
        self.panel_kept.set(None);
        if !self.reduced.get() {
            self.fly((tx, ty), velocity);
        }
        self.move_to(tx, ty);
        self.scene(|orb, _| orb.stretch(0.0, 0.0));
        let place = locate(&monitor, edge, ty, size, gap);
        let rescale = monitor.scale != self.scale.get();
        *self.monitor.borrow_mut() = monitor;
        *self.place.borrow_mut() = place.clone();
        if rescale {
            self.relayout(true);
        }
        self.clip_to_work();
        self.tell(FromOrb::Moved(place));
        self.arm_tuck();
        if !self.hover.get() {
            self.scene(|orb, _| orb.hover(false, self.reduced.get()));
        }
    }

    unsafe fn fly(&self, to: (i32, i32), velocity: (f32, f32)) {
        const STIFFNESS: f32 = 210.0;
        const DAMPING: f32 = 25.0;
        let (mut x, mut y) = (self.pos.get().0 as f32, self.pos.get().1 as f32);
        let (mut vx, mut vy) = velocity;
        // Keep the flight in the same direction, without an arrival that overshoots
        // onto the next monitor.
        let limit = 9000.0 * self.scale.get();
        vx = vx.clamp(-limit, limit);
        vy = vy.clamp(-limit, limit);
        let (tx, ty) = (to.0 as f32, to.1 as f32);
        self.flying.set(true);
        let start = Instant::now();
        let mut last = start;
        while self.flying.get() && start.elapsed() < Duration::from_millis(900) {
            let dt = last.elapsed().as_secs_f32().clamp(0.004, 0.034);
            last = Instant::now();
            for _ in 0..4 {
                let h = dt / 4.0;
                vx += ((tx - x) * STIFFNESS - vx * DAMPING) * h;
                vy += ((ty - y) * STIFFNESS - vy * DAMPING) * h;
                x += vx * h;
                y += vy * h;
            }
            self.move_to(x.round() as i32, y.round() as i32);
            self.lean((vx, vy));
            if (tx - x).abs() < 0.6 && (ty - y).abs() < 0.6 && vx.abs() + vy.abs() < 24.0 {
                break;
            }
            let _ = DwmFlush();
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                DispatchMessageW(&msg);
            }
        }
        self.flying.set(false);
    }

    unsafe fn arm_tuck(&self) {
        if self.config.borrow().tuck {
            SetTimer(self.hit, TIMER_TUCK, TUCK_AFTER.as_millis() as u32, None);
        }
    }

    fn can_tuck(&self) -> bool {
        self.config.borrow().tuck && !self.tucked.get() && !self.hover.get() && self.press.get().is_none() && self.panel.get() == Panel::Closed && !self.hidden.get()
    }

    /// How far the orb slides, and where its hit area goes once it's there.
    fn tuck_geometry(&self) -> (f32, i32, i32) {
        let (x, _) = self.pos.get();
        let (size, _, _) = self.sizes();
        let sliver = (SLIVER_DIP * self.scale.get()).round() as i32;
        let work = self.monitor.borrow().work;
        match self.place.borrow().edge {
            Edge::Left => ((work.x - x - size + sliver) as f32, work.x, sliver * 2),
            Edge::Right => ((work.right() - x - sliver) as f32, work.right() - sliver * 2, sliver * 2),
        }
    }

    unsafe fn tuck(&self) {
        if !self.can_tuck() {
            return;
        }
        let (by, hit_x, hit_w) = self.tuck_geometry();
        self.tucked.set(true);
        self.scene(|orb, _| orb.tuck(by, TUCK_DIM, self.reduced.get()));
        let (_, y) = self.pos.get();
        let (size, _, _) = self.sizes();
        let _ = SetWindowPos(self.hit, None, hit_x, y, hit_w, size, SWP_NOZORDER | SWP_NOACTIVATE);
        let _ = SetWindowRgn(self.hit, HRGN::default(), true);
    }

    unsafe fn untuck(&self) {
        self.tucked.set(false);
        self.scene(|orb, _| orb.tuck(0.0, 1.0, self.reduced.get()));
        let (x, y) = self.pos.get();
        let (size, _, _) = self.sizes();
        let _ = SetWindowPos(self.hit, None, x, y, size, size, SWP_NOZORDER | SWP_NOACTIVATE);
        shape_hit(self.hit, size, size, 0, 0);
    }

    // ---- stage ---------------------------------------------------------------

    /// Put the stage over `rect` and report its top-left.
    unsafe fn raise_stage(&self, rect: Rect) -> (i32, i32) {
        self.scene(|_, stage| stage.resize(rect.w as f32, rect.h as f32));
        // Under the orb, so the shape comes out from behind it.
        let _ = SetWindowPos(self.stage, self.glass, rect.x, rect.y, rect.w, rect.h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        (rect.x, rect.y)
    }

    unsafe fn lower_stage(&self) {
        let _ = ShowWindow(self.stage, SW_HIDE);
        self.scene(|orb, stage| {
            orb.hide_blob(stage)?;
            orb.hide_skeleton(stage)?;
            orb.hide_spark(stage)
        });
    }

    fn stage_busy(&self) -> bool {
        self.panel.get() != Panel::Closed
    }

    unsafe fn show_note(&self, body: &str, from: Option<&str>) {
        if self.hidden.get() || self.stage_busy() {
            self.scene(|orb, _| orb.flash());
            return;
        }
        let (want_peek, want_spark) = {
            let c = self.config.borrow();
            (c.peek, c.spark && from.is_none())
        };
        if self.tucked.get() {
            self.untuck();
            self.arm_tuck();
        }
        self.scene(|orb, _| orb.flash());
        if self.reduced.get() && !want_peek {
            return;
        }
        let orb_rect = self.orb_rect();
        let scale = self.scale.get();
        let reach = (orb_rect.w as f32 * 0.75) as i32;
        let around = orb_rect.inflate(reach);
        let work = self.monitor.borrow().work;
        let gap = (10.0 * scale) as i32;
        let label = match from {
            Some(device) => format!("From {device}"),
            None => "Saved to Notes".to_string(),
        };
        let size = if want_peek { self.scene(|orb, stage| orb.paint_peek(stage, &label, body)) } else { None };
        let (rect, card) = match size {
            Some((w_, h)) => {
                let (w_, h) = (w_.ceil() as i32, h.ceil() as i32);
                let on_left = self.place.borrow().edge == Edge::Right;
                let x = if on_left { orb_rect.x - gap - w_ } else { orb_rect.right() + gap };
                let y = (orb_rect.y + orb_rect.h / 2 - h / 2).clamp(work.y + gap, (work.bottom() - h - gap).max(work.y));
                let pad = (28.0 * scale) as i32;
                let card = Rect { x, y, w: w_, h };
                (around.union(card.inflate(pad)), Some(card))
            }
            None => (around, None),
        };
        let (ox, oy) = self.raise_stage(rect);
        let mut hold = 0.9;
        let spot = ((orb_rect.x - ox) as f32, (orb_rect.y - oy) as f32);
        if !self.reduced.get() {
            hold = self.scene(|orb, stage| orb.ripple(stage, spot.0, spot.1)).unwrap_or(hold);
        }
        if let Some(card) = card {
            let (x, y) = ((card.x - ox) as f32, (card.y - oy) as f32);
            let start = x + if card.x < orb_rect.x { 18.0 } else { -18.0 } * scale;
            self.scene(|orb, stage| orb.show_peek(stage, x, y, start, self.reduced.get(), PEEK_HOLD_MS));
            hold = (PEEK_HOLD_MS + 480.0) / 1000.0;
        }
        if want_spark && !self.reduced.get() {
            let at = self.cursor();
            let from = ((at.0 - ox) as f32, (at.1 - oy) as f32);
            let to = (spot.0 + orb_rect.w as f32 / 2.0, spot.1 + orb_rect.h as f32 / 2.0);
            self.scene(|orb, stage| orb.spark(stage, from, to));
            SetTimer(self.hit, TIMER_SPARK, 540, None);
        }
        SetTimer(self.hit, TIMER_STAGE, (hold * 1000.0) as u32, None);
    }

    // ---- the panel -----------------------------------------------------------

    /// The hotkey opens, closes, or brings back a panel that lost focus.
    unsafe fn hotkey(&self) {
        let panel = HWND(self.panel_hwnd.get() as _);
        match self.panel.get() {
            Panel::Closed => self.open(),
            Panel::Open if !panel.0.is_null() && GetForegroundWindow() != panel => {
                let _ = SetForegroundWindow(panel);
            }
            Panel::Closing => {}
            _ => self.close(),
        }
    }

    unsafe fn open(&self) {
        let _ = KillTimer(self.hit, TIMER_TUCK);
        let _ = KillTimer(self.hit, TIMER_STAGE);
        if self.tucked.get() {
            self.untuck();
        }
        self.panel.set(Panel::Opening);
        self.morph_done.set(false);
        self.shown_at.set(None);
        self.focus_before.set(GetForegroundWindow().0 as isize);
        self.set_unread(0);
        let rect = self.wanted_panel();
        self.panel_rect.set(rect);
        self.tell(FromOrb::Open(rect));
        let orb_rect = self.orb_rect();
        let stage = orb_rect.union(rect).inflate(4);
        let (ox, oy) = self.raise_stage(stage);
        let at = |r: Rect| Rect { x: r.x - ox, y: r.y - oy, w: r.w, h: r.h };
        let secs = self.scene(|orb, s| orb.morph(s, Some(at(orb_rect)), at(rect), true, self.reduced.get())).unwrap_or(0.1);
        SetTimer(self.hit, TIMER_MORPH, (secs * 1000.0 * REVEAL_AT) as u32, None);
    }

    /// The shape has settled, or the page just got ready. Whichever comes second
    /// shows the real panel.
    unsafe fn try_reveal(&self) {
        if self.panel.get() != Panel::Opening || !self.morph_done.get() {
            return;
        }
        let panel = HWND(self.panel_hwnd.get() as _);
        if !self.panel_ready.get() || panel.0.is_null() {
            let (ox, oy) = self.stage_origin();
            let r = self.panel_rect.get();
            self.scene(|orb, stage| orb.skeleton(stage, Rect { x: r.x - ox, y: r.y - oy, w: r.w, h: r.h }));
            return;
        }
        self.panel.set(Panel::Revealing);
        self.painted.set(false);
        self.fading_at.set(None);
        let r = self.panel_rect.get();
        let (left, top, right, bottom) = frame_of(panel);
        self.tell(FromOrb::Reveal);
        // Async: if the shell's UI thread is busy this thread must not wait for it.
        let _ = SetWindowPos(
            panel,
            self.stage,
            r.x - left,
            r.y - top,
            r.w + left + right,
            r.h + top + bottom,
            SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
        );
        self.shown_at.set(None);
        SetTimer(self.hit, TIMER_REVEAL, 8, None);
    }

    unsafe fn stage_origin(&self) -> (i32, i32) {
        let mut r = RECT::default();
        let _ = GetWindowRect(self.stage, &mut r);
        (r.left, r.top)
    }

    /// Runs on a short timer: wait for the window, wait for the page's first frame,
    /// fade the shape off it, then hand the panel to the page.
    unsafe fn reveal_tick(&self) {
        let panel = HWND(self.panel_hwnd.get() as _);
        if let Some(at) = self.fading_at.get() {
            if at.elapsed().as_secs_f32() * 1000.0 > REVEAL_FADE_MS + 16.0 {
                let _ = KillTimer(self.hit, TIMER_REVEAL);
                self.lower_stage();
                self.panel.set(Panel::Open);
                let _ = SetForegroundWindow(panel);
                self.tell(FromOrb::Focus);
            }
            return;
        }
        match self.shown_at.get() {
            None if IsWindowVisible(panel).as_bool() => self.shown_at.set(Some(Instant::now())),
            Some(at) if self.painted.get() || at.elapsed() > PAINT_WAIT => {
                self.fading_at.set(Some(Instant::now()));
                self.scene(|orb, stage| {
                    orb.hide_skeleton(stage)?;
                    orb.fade_blob(stage, REVEAL_FADE_MS)
                });
            }
            _ => {}
        }
    }

    unsafe fn close(&self) {
        let opening = self.panel.get();
        if matches!(opening, Panel::Closed | Panel::Closing) {
            return;
        }
        let panel = HWND(self.panel_hwnd.get() as _);
        let _ = KillTimer(self.hit, TIMER_MORPH);
        let _ = KillTimer(self.hit, TIMER_REVEAL);
        let had_focus = !panel.0.is_null() && GetForegroundWindow() == panel;
        let mut from = self.panel_rect.get();
        let mut kept = None;
        if !panel.0.is_null() && IsWindowVisible(panel).as_bool() {
            let now = visible_rect(panel);
            if now != from {
                kept = Some(now);
            }
            from = now;
        }
        self.panel.set(Panel::Closing);
        self.tell(FromOrb::Close);
        let orb_rect = self.orb_rect();
        let stage = orb_rect.union(from).inflate(4);
        let (ox, oy) = self.raise_stage(stage);
        let at = |r: Rect| Rect { x: r.x - ox, y: r.y - oy, w: r.w, h: r.h };
        self.scene(|orb, s| orb.hide_skeleton(s));
        // Still growing: turn round from wherever it has got to.
        let start = (opening != Panel::Opening).then(|| at(from));
        let secs = self.scene(|orb, s| orb.morph(s, start, at(orb_rect), false, self.reduced.get())).unwrap_or(0.1);
        if !panel.0.is_null() {
            let _ = SetWindowPos(panel, None, 0, 0, 0, 0, SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
        }
        if let Some(rect) = kept {
            self.panel_kept.set(Some(rect));
            self.panel_rect.set(rect);
        }
        self.tell(FromOrb::Closed(kept));
        if had_focus {
            let before = HWND(self.focus_before.get() as _);
            if !before.0.is_null() && IsWindow(before).as_bool() {
                let _ = SetForegroundWindow(before);
            }
        }
        SetTimer(self.hit, TIMER_STAGE, (secs * 1000.0) as u32 + 16, None);
    }

    fn set_unread(&self, count: u32) {
        if self.unread.replace(count) != count {
            self.scene(|orb, _| unsafe { orb.set_unread(count) });
        }
    }

    // ---- housekeeping --------------------------------------------------------

    unsafe fn timer(&self, id: usize) {
        match id {
            TIMER_TUCK => {
                let _ = KillTimer(self.hit, TIMER_TUCK);
                self.tuck();
            }
            TIMER_WATCH => self.watch(),
            TIMER_FOREGROUND => {
                let _ = KillTimer(self.hit, TIMER_FOREGROUND);
                self.watch();
            }
            TIMER_MORPH => {
                let _ = KillTimer(self.hit, TIMER_MORPH);
                self.morph_done.set(true);
                self.try_reveal();
            }
            TIMER_REVEAL => self.reveal_tick(),
            TIMER_SPARK => {
                let _ = KillTimer(self.hit, TIMER_SPARK);
                self.scene(|orb, stage| orb.hide_spark(stage));
            }
            TIMER_STAGE => {
                let _ = KillTimer(self.hit, TIMER_STAGE);
                if matches!(self.panel.get(), Panel::Closing | Panel::Closed) {
                    self.lower_stage();
                    self.panel.set(Panel::Closed);
                    if !self.hover.get() {
                        self.scene(|orb, _| orb.hover(false, self.reduced.get()));
                    }
                    self.arm_tuck();
                }
            }
            _ => {}
        }
    }

    /// Runs every 2 s and on every foreground change.
    unsafe fn watch(&self) {
        if self.scenes.borrow().as_ref().is_some_and(|s| !s.orb.device_ok()) {
            self.relayout(true);
        }
        let mon = MonitorFromPoint(POINT { x: self.pos.get().0, y: self.pos.get().1 }, MONITOR_DEFAULTTONEAREST);
        let covered = fullscreen::covers(mon) && self.panel.get() == Panel::Closed;
        if covered == self.hidden.get() {
            return;
        }
        self.hidden.set(covered);
        crate::hostproc::trace(if covered { "notes orb: fullscreen app, hiding" } else { "notes orb: back" });
        if covered {
            self.scene(|orb, _| orb.presence(0.0));
            let _ = ShowWindow(self.hit, SW_HIDE);
            let _ = ShowWindow(self.stage, SW_HIDE);
        } else {
            let opacity = if self.tucked.get() { TUCK_DIM } else { 1.0 };
            self.scene(|orb, _| orb.presence(opacity));
            let _ = ShowWindow(self.hit, SW_SHOWNOACTIVATE);
        }
    }

    /// The monitor layout or scaling changed: work out everything from the place.
    unsafe fn relayout(&self, rebuild: bool) {
        let list = monitors();
        let place = self.place.borrow().clone();
        let sizes = |m: &Monitor| {
            let (size, _, gap) = metrics(m.scale);
            (size, gap)
        };
        let Some((monitor, x, y)) = resolve(&place, &list, sizes) else { return };
        let monitor = monitor.clone();
        let changed = rebuild || monitor.scale != self.scale.get();
        self.scale.set(monitor.scale);
        *self.monitor.borrow_mut() = monitor;
        self.panel_kept.set(None);
        if self.tucked.get() {
            self.untuck();
        }
        let (size, margin, _) = self.sizes();
        let window = size + margin * 2;
        if changed {
            let _ = SetWindowPos(self.glass, None, x - margin, y - margin, window, window, SWP_NOZORDER | SWP_NOACTIVATE);
            let _ = SetWindowPos(self.hit, None, x, y, size, size, SWP_NOZORDER | SWP_NOACTIVATE);
            shape_hit(self.hit, size, size, 0, 0);
            *self.scenes.borrow_mut() = None;
            match build_scenes(&self.compositor, self.glass, self.stage, window, size, self.scale.get()) {
                Ok(s) => *self.scenes.borrow_mut() = Some(s),
                Err(e) => crate::hostproc::trace(&format!("notes orb: rebuild failed: {e}")),
            }
            let rim = self.rim.get();
            if rim != Rim::Synced {
                self.scene(|orb, _| orb.set_rim(rim));
            }
            let unread = self.unread.get();
            self.scene(|orb, _| orb.set_unread(unread));
        }
        self.move_to(x, y);
        self.clip_to_work();
        self.arm_tuck();
    }

    unsafe fn apply_privacy(&self) {
        let affinity = if self.config.borrow().private { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
        for hwnd in [self.glass, self.stage, HWND(self.panel_hwnd.get() as _)] {
            if !hwnd.0.is_null() {
                let _ = SetWindowDisplayAffinity(hwnd, affinity);
            }
        }
    }

    unsafe fn register_hotkey(&self) {
        if self.hotkey_on.replace(false) {
            let _ = UnregisterHotKey(self.hit, HOTKEY_ID);
        }
        let text = self.config.borrow().hotkey.clone();
        if text.trim().is_empty() {
            return;
        }
        let Some((mods, vk)) = hotkey::parse(&text) else {
            self.tell(FromOrb::HotkeyTaken(text));
            return;
        };
        let mods = HOT_KEY_MODIFIERS(mods) | MOD_NOREPEAT;
        if RegisterHotKey(self.hit, HOTKEY_ID, mods, vk).is_ok() {
            self.hotkey_on.set(true);
        } else {
            self.tell(FromOrb::HotkeyTaken(text));
        }
    }

    unsafe fn drain(&self) {
        while let Ok(message) = self.rx.try_recv() {
            match message {
                ToOrb::Config(config) => {
                    let hotkey_changed = config.hotkey != self.config.borrow().hotkey;
                    let tuck_off = !config.tuck;
                    *self.config.borrow_mut() = config;
                    self.apply_privacy();
                    if hotkey_changed {
                        self.register_hotkey();
                    }
                    if tuck_off {
                        let _ = KillTimer(self.hit, TIMER_TUCK);
                        if self.tucked.get() {
                            self.untuck();
                        }
                    } else {
                        self.arm_tuck();
                    }
                }
                ToOrb::Close => self.close(),
                ToOrb::Note { body, from } => self.show_note(&body, from.as_deref()),
                ToOrb::Unread(count) => self.set_unread(count),
                ToOrb::Rim(rim) => {
                    if self.rim.replace(rim) != rim {
                        self.scene(|orb, _| orb.set_rim(rim));
                    }
                }
                ToOrb::Recording(on) => {
                    let rim = if on { Rim::Recording } else { self.rim.get() };
                    self.scene(|orb, _| orb.set_rim(rim));
                }
                ToOrb::PanelReady(hwnd) => {
                    self.panel_hwnd.set(hwnd);
                    self.panel_ready.set(true);
                    self.apply_privacy();
                    self.try_reveal();
                }
                ToOrb::PanelPainted => self.painted.set(true),
                ToOrb::PanelGone => {
                    self.panel_hwnd.set(0);
                    self.panel_ready.set(false);
                    match self.panel.get() {
                        Panel::Open => {
                            self.panel.set(Panel::Closed);
                            self.arm_tuck();
                        }
                        // Mid-open: ask for another. The skeleton holds until it's up.
                        Panel::Opening | Panel::Revealing => {
                            let _ = KillTimer(self.hit, TIMER_REVEAL);
                            self.panel.set(Panel::Opening);
                            self.tell(FromOrb::Open(self.panel_rect.get()));
                            self.try_reveal();
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

