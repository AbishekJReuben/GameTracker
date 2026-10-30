//! Where the orb lives: a monitor, an edge and a position along that edge, so it
//! comes back to the same spot after a resolution, scaling or monitor change.

use super::motion::{Edge, Rect};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Place {
    pub monitor: String,
    pub edge: Edge,
    /// 0 is the top of the work area, 1 the bottom.
    pub along: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Monitor {
    pub name: String,
    pub bounds: Rect,
    pub work: Rect,
    pub scale: f32,
    pub primary: bool,
}

/// Top-left of an orb at `place`, and the monitor it ended up on. A monitor that's
/// gone falls back to the primary.
pub fn resolve<'a>(place: &Place, monitors: &'a [Monitor], size: impl Fn(&Monitor) -> (i32, i32)) -> Option<(&'a Monitor, i32, i32)> {
    let m = monitors
        .iter()
        .find(|m| m.name == place.monitor)
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or(monitors.first())?;
    let (orb, gap) = size(m);
    let x = match place.edge {
        Edge::Left => m.work.x + gap,
        Edge::Right => m.work.right() - orb - gap,
    };
    let span = (m.work.h - orb - gap * 2).max(0);
    let y = m.work.y + gap + (span as f32 * place.along.clamp(0.0, 1.0)).round() as i32;
    Some((m, x, y))
}

/// The place for an orb resting at `(x, y)`.
pub fn locate(monitor: &Monitor, edge: Edge, y: i32, orb: i32, gap: i32) -> Place {
    let span = (monitor.work.h - orb - gap * 2).max(1);
    Place {
        monitor: monitor.name.clone(),
        edge,
        along: ((y - monitor.work.y - gap) as f32 / span as f32).clamp(0.0, 1.0),
    }
}

/// The monitor holding this point, or the nearest one.
pub fn monitor_at(monitors: &[Monitor], x: i32, y: i32) -> Option<&Monitor> {
    let distance = |m: &Monitor| {
        let dx = (m.bounds.x - x).max(x - m.bounds.right() + 1).max(0) as i64;
        let dy = (m.bounds.y - y).max(y - m.bounds.bottom() + 1).max(0) as i64;
        dx * dx + dy * dy
    };
    monitors.iter().min_by_key(|m| distance(m))
}

/// The old overlay stored a logical `x,y`. Used once, on first run.
pub fn from_legacy(raw: &str, monitors: &[Monitor]) -> Option<Place> {
    let mut it = raw.split(',');
    let x: f32 = it.next()?.trim().parse().ok()?;
    let y: f32 = it.next()?.trim().parse().ok()?;
    let primary = monitors.iter().find(|m| m.primary).or(monitors.first())?;
    let (px, py) = ((x * primary.scale).round() as i32, (y * primary.scale).round() as i32);
    let m = monitor_at(monitors, px, py)?;
    let edge = if px < m.work.x + m.work.w / 2 { Edge::Left } else { Edge::Right };
    Some(Place {
        monitor: m.name.clone(),
        edge,
        along: ((py - m.work.y) as f32 / m.work.h.max(1) as f32).clamp(0.0, 1.0),
    })
}

/// Default: right edge of the primary monitor, a little above the middle.
pub fn default_place(monitors: &[Monitor]) -> Option<Place> {
    let m = monitors.iter().find(|m| m.primary).or(monitors.first())?;
    Some(Place { monitor: m.name.clone(), edge: Edge::Right, along: 0.42 })
}

pub fn monitors() -> Vec<Monitor> {
    use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    unsafe extern "system" fn add(m: HMONITOR, _: HDC, _: *mut RECT, out: LPARAM) -> BOOL {
        let out = &mut *(out.0 as *mut Vec<Monitor>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(m, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
            let rect = |r: RECT| Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
            let (mut dpi, mut unused) = (96, 96);
            let _ = GetDpiForMonitor(m, MDT_EFFECTIVE_DPI, &mut dpi, &mut unused);
            out.push(Monitor {
                name: String::from_utf16_lossy(&info.szDevice).trim_end_matches('\0').to_string(),
                bounds: rect(info.monitorInfo.rcMonitor),
                work: rect(info.monitorInfo.rcWork),
                scale: dpi as f32 / 96.0,
                primary: info.monitorInfo.dwFlags & 1 != 0,
            });
        }
        TRUE
    }
    let mut out: Vec<Monitor> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(add), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screens() -> Vec<Monitor> {
        let m = |name: &str, x: i32, primary: bool| Monitor {
            name: name.into(),
            bounds: Rect { x, y: 0, w: 3840, h: 2160 },
            work: Rect { x, y: 0, w: 3840, h: 2100 },
            scale: 1.25,
            primary,
        };
        vec![m("DISPLAY1", -3840, false), m("DISPLAY2", 0, true)]
    }
    const SIZE: fn(&Monitor) -> (i32, i32) = |_| (70, 18);

    #[test]
    fn a_place_survives_the_round_trip() {
        let monitors = screens();
        let place = locate(&monitors[0], Edge::Left, 900, 70, 18);
        let (m, x, y) = resolve(&place, &monitors, SIZE).unwrap();
        assert_eq!(m.name, "DISPLAY1");
        assert_eq!((x, y), (-3840 + 18, 900));
    }

    #[test]
    fn a_missing_monitor_falls_back_to_the_primary() {
        let place = Place { monitor: "GONE".into(), edge: Edge::Right, along: 0.5 };
        let monitors = screens();
        let (m, x, _) = resolve(&place, &monitors, SIZE).unwrap();
        assert_eq!(m.name, "DISPLAY2");
        assert_eq!(x, 3840 - 70 - 18);
    }

    #[test]
    fn along_is_clamped_so_the_orb_stays_on_screen() {
        let place = Place { monitor: "DISPLAY2".into(), edge: Edge::Left, along: 7.0 };
        let monitors = screens();
        let (_, _, y) = resolve(&place, &monitors, SIZE).unwrap();
        assert_eq!(y, 2100 - 70 - 18);
    }

    #[test]
    fn no_monitors_means_no_place() {
        let place = Place { monitor: "X".into(), edge: Edge::Left, along: 0.0 };
        assert!(resolve(&place, &[], SIZE).is_none());
        assert!(default_place(&[]).is_none());
    }

    #[test]
    fn the_nearest_monitor_wins_off_screen() {
        let monitors = screens();
        assert_eq!(monitor_at(&monitors, -5000, 100).unwrap().name, "DISPLAY1");
        assert_eq!(monitor_at(&monitors, 9000, 100).unwrap().name, "DISPLAY2");
        assert_eq!(monitor_at(&monitors, -1, 100).unwrap().name, "DISPLAY1");
        assert_eq!(monitor_at(&monitors, 0, 100).unwrap().name, "DISPLAY2");
    }

    #[test]
    fn the_old_position_lands_on_its_nearest_edge() {
        let monitors = screens();
        let place = from_legacy("100, 400", &monitors).unwrap();
        assert_eq!((place.monitor.as_str(), place.edge), ("DISPLAY2", Edge::Left));
        assert!((place.along - 500.0 / 2100.0).abs() < 1e-4);
        assert!(from_legacy("", &monitors).is_none());
        assert_eq!(from_legacy("-2000,100", &monitors).unwrap().monitor, "DISPLAY1");
    }
}
