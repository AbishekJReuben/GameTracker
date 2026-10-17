//! Authoritative physical display topology, shared by capture, input and presence.
//! Enumeration runs only on initialization, WM_DISPLAYCHANGE/WM_DEVICECHANGE and
//! a five-second missed-notification recovery poll, never on a pointer/frame path.
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::Once;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalRect { pub x: i32, pub y: i32, pub width: u32, pub height: u32 }
impl PhysicalRect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && (x as i64) < self.x as i64 + self.width as i64 && (y as i64) < self.y as i64 + self.height as i64
    }
    pub fn point(&self, x: f32, y: f32) -> Option<(i32, i32)> {
        if !x.is_finite() || !y.is_finite() || !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) || self.width == 0 || self.height == 0 { return None; }
        Some((self.x + (x * self.width.saturating_sub(1) as f32).round() as i32, self.y + (y * self.height.saturating_sub(1) as f32).round() as i32))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String, pub index: usize, pub name: String,
    pub x: i32, pub y: i32, pub width: u32, pub height: u32,
    pub rotation: u32, pub is_primary: bool, pub selected: bool, pub layout_revision: u64,
}
impl DisplayInfo { pub fn rect(&self) -> PhysicalRect { PhysicalRect { x: self.x, y: self.y, width: self.width, height: self.height } } }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplaySnapshot { pub revision: u64, pub bounds: PhysicalRect, pub displays: Vec<DisplayInfo> }
impl DisplaySnapshot {
    pub fn by_id(&self, id: &str) -> Option<&DisplayInfo> { self.displays.iter().find(|d| d.id == id) }
    pub fn at(&self, x: i32, y: i32) -> Option<&DisplayInfo> { self.displays.iter().find(|d| d.rect().contains(x,y)) }
}
static CACHE: Lazy<RwLock<DisplaySnapshot>> = Lazy::new(|| RwLock::new(DisplaySnapshot::default()));
static START: Once = Once::new();
static REVISION:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);

pub fn union(displays: &[DisplayInfo]) -> PhysicalRect {
    if displays.is_empty() { return PhysicalRect::default(); }
    let x = displays.iter().map(|d| d.x).min().unwrap_or(0);
    let y = displays.iter().map(|d| d.y).min().unwrap_or(0);
    let right = displays.iter().map(|d| d.x as i64 + d.width as i64).max().unwrap_or(0);
    let bottom = displays.iter().map(|d| d.y as i64 + d.height as i64).max().unwrap_or(0);
    PhysicalRect { x, y, width: (right - x as i64).max(0) as u32, height: (bottom - y as i64).max(0) as u32 }
}
fn apply(mut displays: Vec<DisplayInfo>) {
    displays.retain(|d| d.width > 0 && d.height > 0);
    displays.sort_by(|a,b| (a.x,a.y,&a.id).cmp(&(b.x,b.y,&b.id)));
    let mut cache = CACHE.write();
    for (i,d) in displays.iter_mut().enumerate() { d.index = i; d.layout_revision = cache.revision; d.selected = false; }
    if displays == cache.displays { return; }
    let revision = cache.revision.saturating_add(1).max(1);
    for d in &mut displays { d.layout_revision = revision; }
    *cache = DisplaySnapshot { revision, bounds: union(&displays), displays };
    REVISION.store(revision,std::sync::atomic::Ordering::Release);
}
fn initialize() {
    START.call_once(|| {
        apply(enumerate());
        let _ = std::thread::Builder::new().name("display-topology".into()).spawn(watch);
    });
}
pub fn snapshot() -> DisplaySnapshot { initialize(); CACHE.read().clone() }
pub fn revision()->u64{initialize();REVISION.load(std::sync::atomic::Ordering::Acquire)}
#[cfg(windows)]
pub(crate) struct DpiScope(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT);
#[cfg(windows)]
impl DpiScope{pub fn physical()->Self{unsafe{Self(windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))}}}
#[cfg(windows)]
impl Drop for DpiScope{fn drop(&mut self){if !self.0.0.is_null(){unsafe{windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(self.0);}}}}
pub fn bounds(index: usize) -> Option<PhysicalRect> {
    initialize();
    let cache = CACHE.read();
    cache.displays.get(index).or_else(|| cache.displays.iter().find(|d| d.is_primary)).or(cache.displays.first()).map(DisplayInfo::rect)
}

#[cfg(windows)]
fn enumerate() -> Vec<DisplayInfo> {
    use windows::{core::PCWSTR, Win32::{Foundation::{BOOL,LPARAM,RECT}, Graphics::Gdi::*}};
    unsafe extern "system" fn each(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let output = &mut *(data.0 as *mut Vec<DisplayInfo>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(h, &mut info as *mut _ as *mut MONITORINFO).as_bool() { return BOOL(1); }
        let text = |v: &[u16]| String::from_utf16_lossy(&v[..v.iter().position(|c| *c == 0).unwrap_or(v.len())]);
        let device_name = text(&info.szDevice);
        let device = PCWSTR(info.szDevice.as_ptr());
        let mut monitor = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
        // DeviceID is the monitor interface path, independent of list order and
        // physical desktop origin. DISPLAYn remains a fallback for unusual drivers.
        let found = EnumDisplayDevicesW(device, 0, &mut monitor, 1).as_bool();
        let id = if found { text(&monitor.DeviceID) } else { String::new() };
        let name = if found { text(&monitor.DeviceString) } else { device_name.clone() };
        let mut mode = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
        let physical = EnumDisplaySettingsW(device, ENUM_CURRENT_SETTINGS, &mut mode).as_bool();
        let r = info.monitorInfo.rcMonitor;
        let (x,y,width,height,rotation) = if physical && mode.dmPelsWidth > 0 && mode.dmPelsHeight > 0 {
            let display = mode.Anonymous1.Anonymous2;
            (display.dmPosition.x, display.dmPosition.y, mode.dmPelsWidth, mode.dmPelsHeight, display.dmDisplayOrientation.0 * 90)
        } else { (r.left,r.top,(r.right-r.left).max(0) as u32,(r.bottom-r.top).max(0) as u32,0) };
        output.push(DisplayInfo { id: if id.is_empty() { device_name } else { id }, index: 0, name, x,y,width,height,rotation, is_primary: info.monitorInfo.dwFlags & 1 != 0, selected:false,layout_revision:0 });
        BOOL(1)
    }
    let mut output = Vec::new();
    unsafe { let _ = EnumDisplayMonitors(HDC::default(),None,Some(each),LPARAM(&mut output as *mut _ as isize)); }
    output
}
#[cfg(not(windows))]
fn enumerate() -> Vec<DisplayInfo> {
    xcap::Monitor::all().unwrap_or_default().into_iter().enumerate().map(|(index,m)| DisplayInfo { id: format!("{}",m.id().unwrap_or(index as u32)), index, name:m.name().unwrap_or_default(), x:m.x().unwrap_or(0), y:m.y().unwrap_or(0),width:m.width().unwrap_or(0),height:m.height().unwrap_or(0),rotation:0,is_primary:m.is_primary().unwrap_or(false),selected:false,layout_revision:0 }).collect()
}
#[cfg(windows)]
fn watch() {
    use windows::{core::w, Win32::{Foundation::{HWND,LPARAM,LRESULT,WPARAM}, System::LibraryLoader::GetModuleHandleW, UI::WindowsAndMessaging::*}};
    unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if matches!(msg,WM_DISPLAYCHANGE | WM_DEVICECHANGE | WM_TIMER) { apply(enumerate()); }
        DefWindowProcW(hwnd,msg,wp,lp)
    }
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return; };
        let class = WNDCLASSW { lpfnWndProc:Some(procedure),hInstance:module.into(),lpszClassName:w!("GameTrackerDisplayTopology"),..Default::default() };
        if RegisterClassW(&class) == 0 { return; }
        // Hidden top-level window receives display broadcasts; HWND_MESSAGE does not.
        let Ok(hwnd) = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,w!("GameTrackerDisplayTopology"),w!(""),WS_POPUP,0,0,0,0,None,None,module,None) else { return; };
        SetTimer(hwnd,1,5000,None);
        let mut message = MSG::default();
        while GetMessageW(&mut message,None,0,0).0 > 0 { let _ = TranslateMessage(&message); DispatchMessageW(&message); }
        let _ = DestroyWindow(hwnd);
    }
}
#[cfg(not(windows))]
fn watch() { loop { std::thread::sleep(std::time::Duration::from_secs(5)); apply(enumerate()); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_rect_corners_are_exact_and_invalid_input_is_rejected() {
        let r = PhysicalRect { x:-3840,y:-1080,width:7680,height:3240 };
        assert_eq!(r.point(0.,0.),Some((-3840,-1080)));
        assert_eq!(r.point(1.,1.),Some((3839,2159)));
        assert_eq!(r.point(f32::NAN,0.),None); assert_eq!(r.point(1.1,0.),None);
        assert!(r.contains(3839,2159)); assert!(!r.contains(3840,2160));
    }
    #[test]
    fn shared_layout_fixtures_keep_physical_geometry_and_identities() {
        let fixtures: Vec<serde_json::Value> = serde_json::from_str(include_str!("../../../docs/remote-implementation/fixtures/layouts.json")).unwrap();
        for fixture in fixtures {
            let displays: Vec<_> = fixture["displays"].as_array().unwrap().iter().enumerate().map(|(index,d)| DisplayInfo {
                id:d["id"].as_str().unwrap().into(),index,name:String::new(),x:d["x"].as_i64().unwrap() as i32,y:d["y"].as_i64().unwrap() as i32,width:d["width"].as_u64().unwrap() as u32,height:d["height"].as_u64().unwrap() as u32,rotation:d["rotation"].as_u64().unwrap_or(0) as u32,is_primary:d["id"]=="primary",selected:false,layout_revision:1
            }).collect();
            let expected: PhysicalRect = serde_json::from_value(fixture["bounds"].clone()).unwrap();
            assert_eq!(union(&displays),expected,"{}",fixture["name"]);
            let snapshot = DisplaySnapshot { revision:1,bounds:expected,displays };
            for d in &snapshot.displays {
                for (x,y) in [(d.x,d.y),(d.x+d.width as i32-1,d.y+d.height as i32-1),(d.x+d.width as i32/2,d.y+d.height as i32/2)] {
                    assert_eq!(snapshot.at(x,y).map(|d|d.id.as_str()),Some(d.id.as_str()));
                }
                assert_eq!(snapshot.by_id(&d.id).map(|d|d.rect()),Some(d.rect()));
            }
        }
    }
}
