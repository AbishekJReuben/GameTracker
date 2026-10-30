//! The orb's maths: springs, edge snapping, panel placement and the icon path.
//! Pure, so all of it is tested without a window.

use serde::{Deserialize, Serialize};

/// A damped spring from 0 to 1. `response` is roughly how long it takes to get
/// there, in seconds; a `damping` below 1 overshoots.
#[derive(Clone, Copy, Debug)]
pub struct Spring {
    pub damping: f32,
    pub response: f32,
}

impl Spring {
    fn omega(self) -> f32 {
        std::f32::consts::TAU / self.response.max(0.01)
    }

    /// Position at `t` seconds.
    pub fn at(self, t: f32) -> f32 {
        let (z, w) = (self.damping, self.omega());
        if z < 1.0 {
            let wd = w * (1.0 - z * z).sqrt();
            1.0 - (-z * w * t).exp() * ((wd * t).cos() + z * w / wd * (wd * t).sin())
        } else {
            1.0 - (-w * t).exp() * (1.0 + w * t)
        }
    }

    /// Seconds until it stays within 0.2 % of its target.
    pub fn settle(self) -> f32 {
        let mut t = 2.5;
        while t > 0.02 && (self.at(t) - 1.0).abs() < 0.002 {
            t -= 0.004;
        }
        (t + 0.004).min(2.5)
    }

    /// The curve as (progress, value) keys for a compositor animation.
    pub fn keys(self, count: usize) -> Vec<(f32, f32)> {
        let settle = self.settle();
        let last = count.max(2) - 1;
        (0..=last)
            .map(|i| {
                let p = i as f32 / last as f32;
                (p, if i == last { 1.0 } else { self.at(p * settle) })
            })
            .collect()
    }
}

pub const PRESS: Spring = Spring { damping: 0.72, response: 0.12 };
pub const HOVER: Spring = Spring { damping: 0.62, response: 0.28 };
pub const OPEN: Spring = Spring { damping: 0.88, response: 0.3 };
pub const CLOSE: Spring = Spring { damping: 1.0, response: 0.2 };
pub const TUCK: Spring = Spring { damping: 0.9, response: 0.42 };

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn right(self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(self) -> i32 {
        self.y + self.h
    }
    pub fn union(self, o: Rect) -> Rect {
        let (x, y) = (self.x.min(o.x), self.y.min(o.y));
        Rect { x, y, w: self.right().max(o.right()) - x, h: self.bottom().max(o.bottom()) - y }
    }
    pub fn inflate(self, by: i32) -> Rect {
        Rect { x: self.x - by, y: self.y - by, w: self.w + by * 2, h: self.h + by * 2 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Left,
    Right,
}

/// How far ahead a release is projected, in seconds. A flick reaches the far edge.
const THROW: f32 = 0.14;

/// Where a released orb comes to rest: the nearest side edge of its work area, after
/// carrying its speed for a moment.
pub fn snap(x: i32, y: i32, size: i32, vx: f32, vy: f32, work: Rect, gap: i32) -> (i32, i32, Edge) {
    let centre = x as f32 + size as f32 / 2.0 + vx * THROW;
    let edge = if centre < (work.x + work.w / 2) as f32 { Edge::Left } else { Edge::Right };
    let tx = match edge {
        Edge::Left => work.x + gap,
        Edge::Right => work.right() - size - gap,
    };
    let ty = (y as f32 + vy * THROW).round() as i32;
    (tx, ty.clamp(work.y + gap, (work.bottom() - size - gap).max(work.y + gap)), edge)
}

/// Where the panel opens: beside the orb on the side with room, vertically centred
/// on it and fully inside the work area.
pub fn panel_rect(orb: Rect, wanted: (i32, i32), work: Rect, gap: i32) -> Rect {
    let w = wanted.0.min(work.w - gap * 2).max(1);
    let h = wanted.1.min(work.h - gap * 2).max(1);
    let right_of_orb = orb.x + orb.w / 2 < work.x + work.w / 2;
    let x = if right_of_orb { orb.right() + gap } else { orb.x - w - gap };
    let y = orb.y + orb.h / 2 - h / 2;
    Rect {
        x: x.clamp(work.x + gap, (work.right() - w - gap).max(work.x + gap)),
        y: y.clamp(work.y + gap, (work.bottom() - h - gap).max(work.y + gap)),
        w,
        h,
    }
}

/// Points round a superellipse of radius `r` centred on the origin, clockwise from
/// the right. Exponent 2 is a circle, 4 a squircle; between the two it reads as a
/// pebble rather than a button.
pub fn superellipse(r: f32, exponent: f32, count: usize) -> Vec<(f32, f32)> {
    let power = 2.0 / exponent;
    (0..count)
        .map(|i| {
            let a = i as f32 / count as f32 * std::f32::consts::TAU;
            let (s, c) = a.sin_cos();
            (r * c.signum() * c.abs().powf(power), r * s.signum() * s.abs().powf(power))
        })
        .collect()
}

/// Parsed drawing commands for the icon, in icon units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PathOp {
    Move(f32, f32),
    Line(f32, f32),
    Arc { rx: f32, ry: f32, large: bool, sweep: bool, x: f32, y: f32 },
    Close,
}

/// A small SVG path reader: M, L, H, V, A and Z, relative or absolute. That covers
/// the lucide icon the orb draws.
pub fn parse_path(d: &str) -> Vec<PathOp> {
    let mut chars = d.chars().peekable();
    let (mut x, mut y, mut sx, mut sy) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let mut out = Vec::new();
    let mut cmd = ' ';
    fn skip(c: &mut std::iter::Peekable<std::str::Chars>) {
        while matches!(c.peek(), Some(' ') | Some(',') | Some('\n')) {
            c.next();
        }
    }
    fn number(c: &mut std::iter::Peekable<std::str::Chars>) -> f32 {
        skip(c);
        let mut s = String::new();
        if matches!(c.peek(), Some('-') | Some('+')) {
            s.push(c.next().unwrap());
        }
        let mut dot = false;
        while let Some(&ch) = c.peek() {
            if ch.is_ascii_digit() || (ch == '.' && !dot) {
                dot |= ch == '.';
                s.push(ch);
                c.next();
            } else {
                break;
            }
        }
        s.parse().unwrap_or(0.0)
    }
    fn flag(c: &mut std::iter::Peekable<std::str::Chars>) -> bool {
        skip(c);
        c.next() == Some('1')
    }
    loop {
        skip(&mut chars);
        let Some(&next) = chars.peek() else { break };
        if next.is_ascii_alphabetic() {
            cmd = next;
            chars.next();
        }
        let rel = cmd.is_ascii_lowercase();
        match cmd.to_ascii_uppercase() {
            'M' | 'L' => {
                let (nx, ny) = (number(&mut chars), number(&mut chars));
                x = if rel { x + nx } else { nx };
                y = if rel { y + ny } else { ny };
                if cmd.to_ascii_uppercase() == 'M' {
                    out.push(PathOp::Move(x, y));
                    (sx, sy) = (x, y);
                    cmd = if rel { 'l' } else { 'L' };
                } else {
                    out.push(PathOp::Line(x, y));
                }
            }
            'H' => {
                let n = number(&mut chars);
                x = if rel { x + n } else { n };
                out.push(PathOp::Line(x, y));
            }
            'V' => {
                let n = number(&mut chars);
                y = if rel { y + n } else { n };
                out.push(PathOp::Line(x, y));
            }
            'A' => {
                let (rx, ry, _rot) = (number(&mut chars), number(&mut chars), number(&mut chars));
                let (large, sweep) = (flag(&mut chars), flag(&mut chars));
                let (nx, ny) = (number(&mut chars), number(&mut chars));
                x = if rel { x + nx } else { nx };
                y = if rel { y + ny } else { ny };
                out.push(PathOp::Arc { rx, ry, large, sweep, x, y });
            }
            'Z' => {
                out.push(PathOp::Close);
                (x, y) = (sx, sy);
                skip(&mut chars);
                if chars.peek().is_none() {
                    break;
                }
                if !chars.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
                    break;
                }
            }
            _ => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spring_starts_at_zero_and_ends_at_one() {
        for s in [PRESS, HOVER, OPEN, CLOSE, TUCK] {
            assert!(s.at(0.0).abs() < 1e-5);
            let keys = s.keys(24);
            assert_eq!(keys.first().copied(), Some((0.0, 0.0)));
            assert_eq!(keys.last().copied(), Some((1.0, 1.0)));
            assert!(keys.windows(2).all(|k| k[1].0 > k[0].0), "progress keys must rise");
        }
    }

    #[test]
    fn open_overshoots_a_little_and_close_never_does() {
        let peak = |s: Spring| s.keys(120).iter().fold(0f32, |m, k| m.max(k.1));
        assert!(peak(OPEN) > 1.001 && peak(OPEN) < 1.03, "{}", peak(OPEN));
        assert!(peak(CLOSE) <= 1.0001);
    }

    #[test]
    fn settle_is_short_enough_to_feel_immediate() {
        assert!(OPEN.settle() < 0.4, "{}", OPEN.settle());
        assert!(CLOSE.settle() < 0.3, "{}", CLOSE.settle());
        assert!(PRESS.settle() < 0.25);
    }

    const WORK: Rect = Rect { x: 0, y: 0, w: 3840, h: 2100 };

    #[test]
    fn a_release_lands_on_the_nearest_edge() {
        assert_eq!(snap(300, 500, 90, 0.0, 0.0, WORK, 16), (16, 500, Edge::Left));
        assert_eq!(snap(3000, 500, 90, 0.0, 0.0, WORK, 16), (3734, 500, Edge::Right));
    }

    #[test]
    fn a_throw_can_cross_to_the_far_edge() {
        assert_eq!(snap(1700, 500, 90, 3000.0, 0.0, WORK, 16).2, Edge::Right);
        assert_eq!(snap(2100, 500, 90, -3000.0, 0.0, WORK, 16).2, Edge::Left);
    }

    #[test]
    fn a_release_stays_inside_the_work_area() {
        assert_eq!(snap(100, 99999, 90, 0.0, 0.0, WORK, 16).1, 2100 - 90 - 16);
        assert_eq!(snap(100, -500, 90, 0.0, -5000.0, WORK, 16).1, 16);
    }

    #[test]
    fn negative_monitor_coordinates_work() {
        let left = Rect { x: -3840, y: 0, w: 3840, h: 2100 };
        assert_eq!(snap(-200, 300, 90, 0.0, 0.0, left, 16), (-3840 + 3840 - 90 - 16, 300, Edge::Right));
        assert_eq!(snap(-3000, 300, 90, 0.0, 0.0, left, 16), (-3824, 300, Edge::Left));
    }

    #[test]
    fn the_panel_opens_on_the_side_with_room() {
        let orb = Rect { x: 3734, y: 500, w: 90, h: 90 };
        let p = panel_rect(orb, (475, 700), WORK, 16);
        assert_eq!(p.right(), 3734 - 16, "left of an orb on the right edge");
        let orb = Rect { x: 16, y: 500, w: 90, h: 90 };
        assert_eq!(panel_rect(orb, (475, 700), WORK, 16).x, 106 + 16);
    }

    #[test]
    fn the_panel_never_leaves_the_work_area() {
        let orb = Rect { x: 3734, y: 2000, w: 90, h: 90 };
        let p = panel_rect(orb, (475, 700), WORK, 16);
        assert_eq!(p.bottom(), 2100 - 16);
        let small = Rect { x: 0, y: 0, w: 400, h: 300 };
        let p = panel_rect(Rect { x: 10, y: 10, w: 40, h: 40 }, (475, 700), small, 8);
        assert_eq!((p.w, p.h), (384, 284));
        assert!(p.x >= 8 && p.right() <= 392 && p.y >= 8 && p.bottom() <= 292);
    }

    #[test]
    fn a_superellipse_sits_between_a_circle_and_a_square() {
        let pts = superellipse(10.0, 3.2, 64);
        assert_eq!(pts.len(), 64);
        let reach = |(x, y): (f32, f32)| (x * x + y * y).sqrt();
        assert!((reach(pts[0]) - 10.0).abs() < 1e-3, "touches the circle on the axes");
        let corner = reach(pts[8]);
        assert!(corner > 10.0 && corner < 14.14, "{corner}");
    }

    #[test]
    fn union_and_inflate_keep_their_edges() {
        let a = Rect { x: 10, y: 20, w: 30, h: 40 };
        let b = Rect { x: -5, y: 30, w: 10, h: 100 };
        assert_eq!(a.union(b), Rect { x: -5, y: 20, w: 45, h: 110 });
        assert_eq!(a.inflate(2), Rect { x: 8, y: 18, w: 34, h: 44 });
    }

    #[test]
    fn the_path_reader_handles_relative_commands_and_arcs() {
        let ops = parse_path("M13.4 2H6a2 2 0 0 0-2 2v16");
        assert_eq!(ops[0], PathOp::Move(13.4, 2.0));
        assert_eq!(ops[1], PathOp::Line(6.0, 2.0));
        assert_eq!(ops[2], PathOp::Arc { rx: 2.0, ry: 2.0, large: false, sweep: false, x: 4.0, y: 4.0 });
        assert_eq!(ops[3], PathOp::Line(4.0, 20.0));
    }

    #[test]
    fn the_path_reader_handles_repeated_moves_and_close() {
        let ops = parse_path("M2 6h4M2 10h4");
        assert_eq!(ops, [PathOp::Move(2.0, 6.0), PathOp::Line(6.0, 6.0), PathOp::Move(2.0, 10.0), PathOp::Line(6.0, 10.0)]);
        assert_eq!(parse_path("M1 1l2 0z").last(), Some(&PathOp::Close));
    }
}
