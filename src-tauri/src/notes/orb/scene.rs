//! What the orb looks like: a Windows.UI.Composition tree. Animations here run in the
//! compositor, so they keep moving even if this thread stops. A resting orb has no
//! running animation, so it costs nothing until something happens.

use super::motion::{parse_path, superellipse, PathOp, Rect, Spring, CLOSE, HOVER, OPEN, PRESS, TUCK};
use windows::core::{w, Interface, Result, HSTRING};
use windows::Foundation::Numerics::{Vector2, Vector3};
use windows::Foundation::{Size, TimeSpan};
use windows::Graphics::DirectX::{DirectXAlphaMode, DirectXPixelFormat};
use windows::UI::Color;
use windows::UI::Composition::Desktop::DesktopWindowTarget;
use windows::UI::Composition::*;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::Graphics::Direct2D::Common::*;
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Composition::{ICompositionDrawingSurfaceInterop, ICompositorDesktopInterop, ICompositorInterop};

/// lucide "notebook-pen".
const ICON_PATHS: [&str; 3] = [
    "M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4",
    "M2 6h4M2 10h4M2 14h4M2 18h4",
    "M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z",
];

/// The orb's outline: between a circle and a squircle.
const OUTLINE: f32 = 3.1;
/// Rim brightness at rest. Hover and an open panel take it to full.
const RIM_REST: f32 = 0.72;
pub const PANEL_RADIUS_DIP: f32 = 8.0;

const fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
    Color { A: a, R: r, G: g, B: b }
}
const VIOLET: Color = rgba(139, 123, 255, 255);
const BLUE: Color = rgba(79, 140, 255, 255);
const CYAN: Color = rgba(34, 211, 238, 255);
const GREEN: Color = rgba(52, 211, 153, 255);
const PINK: Color = rgba(244, 114, 182, 255);
const AMBER: Color = rgba(251, 191, 36, 255);
const RED: Color = rgba(251, 93, 106, 255);
const QUIET: Color = rgba(128, 137, 168, 255);

/// Rim state. Healthy sync is the plain aurora, so only trouble draws the eye.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rim {
    Synced,
    Reconnecting,
    Off,
    Recording,
}

fn v2(x: f32, y: f32) -> Vector2 {
    Vector2 { X: x, Y: y }
}
fn v3(x: f32, y: f32) -> Vector3 {
    Vector3 { X: x, Y: y, Z: 0.0 }
}
fn ms(n: f32) -> TimeSpan {
    TimeSpan { Duration: (n * 10_000.0) as i64 }
}
fn prop(name: &str) -> HSTRING {
    HSTRING::from(name)
}
fn d2c(c: (u8, u8, u8, u8)) -> D2D1_COLOR_F {
    D2D1_COLOR_F { r: c.0 as f32 / 255.0, g: c.1 as f32 / 255.0, b: c.2 as f32 / 255.0, a: c.3 as f32 / 255.0 }
}
fn pt(x: f32, y: f32) -> D2D_POINT_2F {
    D2D_POINT_2F { x, y }
}

type Stop = (f32, (u8, u8, u8, u8));

unsafe fn stops(ctx: &ID2D1DeviceContext, list: &[Stop]) -> Result<ID2D1GradientStopCollection> {
    let list: Vec<_> = list.iter().map(|&(position, c)| D2D1_GRADIENT_STOP { position, color: d2c(c) }).collect();
    ID2D1RenderTarget::CreateGradientStopCollection(ctx, &list, D2D1_GAMMA_2_2, D2D1_EXTEND_MODE_CLAMP)
}

unsafe fn linear(ctx: &ID2D1DeviceContext, from: (f32, f32), to: (f32, f32), list: &[Stop]) -> Result<ID2D1LinearGradientBrush> {
    ctx.CreateLinearGradientBrush(
        &D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES { startPoint: pt(from.0, from.1), endPoint: pt(to.0, to.1) },
        None,
        &stops(ctx, list)?,
    )
}

unsafe fn radial(ctx: &ID2D1DeviceContext, centre: (f32, f32), radius: (f32, f32), list: &[Stop]) -> Result<ID2D1RadialGradientBrush> {
    ctx.CreateRadialGradientBrush(
        &D2D1_RADIAL_GRADIENT_BRUSH_PROPERTIES {
            center: pt(centre.0, centre.1),
            gradientOriginOffset: pt(0.0, 0.0),
            radiusX: radius.0,
            radiusY: radius.1,
        },
        None,
        &stops(ctx, list)?,
    )
}

/// The few things that need real drawing. Composition has no text or path strokes
/// with the control this needs, and each surface is painted once.
struct Painter {
    device: ID3D11Device,
    graphics: CompositionGraphicsDevice,
    d2d: ID2D1Factory1,
    write: IDWriteFactory,
}

impl Painter {
    unsafe fn new(compositor: &Compositor) -> Result<Self> {
        let mut device = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;
        let device = device.ok_or_else(windows::core::Error::from_win32)?;
        let dxgi: IDXGIDevice = device.cast()?;
        let d2d: ID2D1Factory1 = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
        let d2d_device = d2d.CreateDevice(&dxgi)?;
        let interop: ICompositorInterop = compositor.cast()?;
        let graphics = interop.CreateGraphicsDevice(&d2d_device)?;
        Ok(Self { device, graphics, d2d, write: DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)? })
    }

    /// Paint a fresh surface. `draw` gets the context and the surface's offset.
    unsafe fn paint(&self, w: f32, h: f32, draw: impl FnOnce(&ID2D1DeviceContext, f32, f32) -> Result<()>) -> Result<CompositionDrawingSurface> {
        let surface = self.graphics.CreateDrawingSurface(
            Size { Width: w.ceil(), Height: h.ceil() },
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            DirectXAlphaMode::Premultiplied,
        )?;
        let interop: ICompositionDrawingSurfaceInterop = surface.cast()?;
        let mut offset = POINT::default();
        let ctx: ID2D1DeviceContext = interop.BeginDraw(None, &mut offset)?;
        ctx.Clear(Some(&D2D1_COLOR_F { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }));
        ctx.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        let result = draw(&ctx, offset.x as f32, offset.y as f32);
        interop.EndDraw()?;
        result?;
        Ok(surface)
    }

    unsafe fn outline(&self, cx: f32, cy: f32, r: f32) -> Result<ID2D1PathGeometry1> {
        let geometry = self.d2d.CreatePathGeometry()?;
        let sink = geometry.Open()?;
        let points: Vec<_> = superellipse(r, OUTLINE, 160).into_iter().map(|(x, y)| pt(cx + x, cy + y)).collect();
        sink.BeginFigure(points[0], D2D1_FIGURE_BEGIN_FILLED);
        sink.AddLines(&points[1..]);
        sink.EndFigure(D2D1_FIGURE_END_CLOSED);
        sink.Close()?;
        Ok(geometry)
    }

    /// Opaque outline, used as a mask.
    unsafe fn alpha(&self, size: f32) -> Result<CompositionDrawingSurface> {
        self.paint(size, size, |ctx, ox, oy| {
            let shape = self.outline(ox + size / 2.0, oy + size / 2.0, size / 2.0)?;
            ctx.FillGeometry(&shape, &ctx.CreateSolidColorBrush(&d2c((255, 255, 255, 255)), None)?, None);
            Ok(())
        })
    }

    /// The thin ring round the outline, used as a mask for the rim colours.
    unsafe fn ring(&self, size: f32, thickness: f32) -> Result<CompositionDrawingSurface> {
        self.paint(size, size, |ctx, ox, oy| {
            let shape = self.outline(ox + size / 2.0, oy + size / 2.0, size / 2.0 - thickness / 2.0)?;
            ctx.DrawGeometry(&shape, &ctx.CreateSolidColorBrush(&d2c((255, 255, 255, 255)), None)?, thickness, None);
            Ok(())
        })
    }

    /// The glass. Light comes in at the top left, and the colour that passes through
    /// pools at the bottom right. That second pool is what makes it read as a solid
    /// piece of glass and not a gradient button.
    unsafe fn glass(&self, size: f32, scale: f32) -> Result<CompositionDrawingSurface> {
        self.paint(size, size, |ctx, ox, oy| {
            let (cx, cy, r) = (ox + size / 2.0, oy + size / 2.0, size / 2.0);
            let shape = self.outline(cx, cy, r)?;
            let at = |x: f32, y: f32| (ox + size * x, oy + size * y);
            let body = linear(ctx, at(0.1, 0.0), at(0.9, 1.0), &[
                (0.0, (58, 46, 158, 250)),
                (0.48, (20, 22, 56, 250)),
                (1.0, (8, 52, 74, 250)),
            ])?;
            ctx.FillGeometry(&shape, &body, None);
            let bounce = radial(ctx, at(0.72, 1.04), (size * 0.82, size * 0.66), &[
                (0.0, (34, 211, 238, 150)),
                (0.55, (34, 150, 238, 42)),
                (1.0, (34, 120, 238, 0)),
            ])?;
            ctx.FillGeometry(&shape, &bounce, None);
            let sky = radial(ctx, at(0.26, 0.1), (size * 0.86, size * 0.74), &[
                (0.0, (196, 182, 255, 130)),
                (0.6, (139, 123, 255, 30)),
                (1.0, (139, 123, 255, 0)),
            ])?;
            ctx.FillGeometry(&shape, &sky, None);
            let crescent = radial(ctx, at(0.46, 0.14), (size * 0.36, size * 0.17), &[
                (0.0, (255, 255, 255, 86)),
                (1.0, (255, 255, 255, 0)),
            ])?;
            ctx.FillGeometry(&shape, &crescent, None);
            let edge = linear(ctx, at(0.5, 0.0), at(0.5, 1.0), &[
                (0.0, (255, 255, 255, 176)),
                (0.34, (255, 255, 255, 34)),
                (0.7, (255, 255, 255, 12)),
                (1.0, (130, 236, 250, 112)),
            ])?;
            let inner = self.outline(cx, cy, r - 0.5 * scale)?;
            ctx.DrawGeometry(&inner, &edge, 1.0 * scale, None);
            Ok(())
        })
    }

    unsafe fn icon_geometry(&self, scale: f32, ox: f32, oy: f32) -> Result<ID2D1PathGeometry1> {
        let geometry = self.d2d.CreatePathGeometry()?;
        let sink = geometry.Open()?;
        for d in ICON_PATHS {
            let mut open = false;
            for op in parse_path(d) {
                match op {
                    PathOp::Move(x, y) => {
                        if open {
                            sink.EndFigure(D2D1_FIGURE_END_OPEN);
                        }
                        sink.BeginFigure(pt(ox + x * scale, oy + y * scale), D2D1_FIGURE_BEGIN_HOLLOW);
                        open = true;
                    }
                    PathOp::Line(x, y) => sink.AddLine(pt(ox + x * scale, oy + y * scale)),
                    PathOp::Arc { rx, ry, large, sweep, x, y } => sink.AddArc(&D2D1_ARC_SEGMENT {
                        point: pt(ox + x * scale, oy + y * scale),
                        size: D2D_SIZE_F { width: rx * scale, height: ry * scale },
                        rotationAngle: 0.0,
                        sweepDirection: if sweep { D2D1_SWEEP_DIRECTION_CLOCKWISE } else { D2D1_SWEEP_DIRECTION_COUNTER_CLOCKWISE },
                        arcSize: if large { D2D1_ARC_SIZE_LARGE } else { D2D1_ARC_SIZE_SMALL },
                    }),
                    PathOp::Close => {
                        sink.EndFigure(D2D1_FIGURE_END_CLOSED);
                        open = false;
                    }
                }
            }
            if open {
                sink.EndFigure(D2D1_FIGURE_END_OPEN);
            }
        }
        sink.Close()?;
        Ok(geometry)
    }

    unsafe fn icon(&self, size: f32) -> Result<CompositionDrawingSurface> {
        let unit = size / 24.0;
        self.paint(size, size, |ctx, ox, oy| {
            let geometry = self.icon_geometry(unit, ox, oy)?;
            let style = self.d2d.CreateStrokeStyle(
                &D2D1_STROKE_STYLE_PROPERTIES1 {
                    startCap: D2D1_CAP_STYLE_ROUND,
                    endCap: D2D1_CAP_STYLE_ROUND,
                    lineJoin: D2D1_LINE_JOIN_ROUND,
                    miterLimit: 10.0,
                    ..Default::default()
                },
                None,
            )?;
            // A soft dark copy first, so the lines stay sharp over the brightest
            // part of the glass.
            let under = ctx.CreateSolidColorBrush(&d2c((6, 8, 24, 80)), None)?;
            let shifted = self.icon_geometry(unit, ox, oy + 0.9 * unit)?;
            ctx.DrawGeometry(&shifted, &under, 2.5 * unit, &style);
            let ink = linear(ctx, (ox, oy), (ox, oy + size), &[(0.0, (255, 255, 255, 255)), (1.0, (206, 232, 255, 255))])?;
            ctx.DrawGeometry(&geometry, &ink, 1.9 * unit, &style);
            Ok(())
        })
    }

    unsafe fn text_layout(&self, text: &str, size: f32, weight: DWRITE_FONT_WEIGHT, max_w: f32) -> Result<IDWriteTextLayout> {
        let format = self.write.CreateTextFormat(
            w!("Segoe UI Variable Text"),
            None,
            weight,
            DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL,
            size,
            w!("en-US"),
        )?;
        format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
        let sign = self.write.CreateEllipsisTrimmingSign(&format)?;
        format.SetTrimming(&DWRITE_TRIMMING { granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER, ..Default::default() }, &sign)?;
        let wide: Vec<u16> = text.encode_utf16().collect();
        self.write.CreateTextLayout(&wide, &format, max_w, 400.0)
    }

    unsafe fn badge(&self, text: &str, h: f32, s: f32) -> Result<(CompositionDrawingSurface, f32, f32)> {
        let layout = self.text_layout(text, 11.5 * s, DWRITE_FONT_WEIGHT_BOLD, 80.0 * s)?;
        let mut m = DWRITE_TEXT_METRICS::default();
        layout.GetMetrics(&mut m)?;
        let ring = 2.0 * s;
        let w = (m.width + 11.0 * s).max(h) + ring * 2.0;
        let full = h + ring * 2.0;
        let surface = self.paint(w, full, |ctx, ox, oy| {
            let cut = D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F { left: ox, top: oy, right: ox + w, bottom: oy + full },
                radiusX: full / 2.0,
                radiusY: full / 2.0,
            };
            ctx.FillRoundedRectangle(&cut, &ctx.CreateSolidColorBrush(&d2c((9, 10, 22, 255)), None)?);
            let round = D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F { left: ox + ring, top: oy + ring, right: ox + w - ring, bottom: oy + ring + h },
                radiusX: h / 2.0,
                radiusY: h / 2.0,
            };
            let fill = linear(ctx, (ox, oy), (ox, oy + h), &[(0.0, (120, 236, 250, 255)), (1.0, (28, 196, 226, 255))])?;
            ctx.FillRoundedRectangle(&round, &fill);
            let ink = ctx.CreateSolidColorBrush(&d2c((3, 20, 28, 255)), None)?;
            ctx.DrawTextLayout(pt(ox + (w - m.width) / 2.0, oy + ring + (h - m.height) / 2.0), &layout, &ink, D2D1_DRAW_TEXT_OPTIONS_NONE);
            Ok(())
        })?;
        Ok((surface, w, full))
    }

    /// The small card that says what just arrived.
    unsafe fn peek(&self, label: &str, body: &str, s: f32) -> Result<(CompositionDrawingSurface, f32, f32)> {
        let max = 288.0 * s;
        let head = self.text_layout(label, 11.0 * s, DWRITE_FONT_WEIGHT_SEMI_BOLD, max)?;
        let text = self.text_layout(body, 13.0 * s, DWRITE_FONT_WEIGHT_NORMAL, max)?;
        let (mut hm, mut tm) = (DWRITE_TEXT_METRICS::default(), DWRITE_TEXT_METRICS::default());
        head.GetMetrics(&mut hm)?;
        text.GetMetrics(&mut tm)?;
        let pad = 14.0 * s;
        let w = hm.width.max(tm.width).min(max) + pad * 2.0;
        let h = hm.height + tm.height + 3.0 * s + 19.0 * s;
        let surface = self.paint(w, h, |ctx, ox, oy| {
            let inner = 0.5 * s;
            let round = D2D1_ROUNDED_RECT {
                rect: D2D_RECT_F { left: ox + inner, top: oy + inner, right: ox + w - inner, bottom: oy + h - inner },
                radiusX: 13.0 * s,
                radiusY: 13.0 * s,
            };
            let fill = linear(ctx, (ox, oy), (ox + w, oy + h), &[(0.0, (20, 18, 44, 246)), (1.0, (9, 20, 32, 246))])?;
            ctx.FillRoundedRectangle(&round, &fill);
            let line = linear(ctx, (ox, oy), (ox + w, oy), &[
                (0.0, (139, 123, 255, 170)),
                (0.5, (34, 211, 238, 120)),
                (1.0, (52, 211, 153, 90)),
            ])?;
            ctx.DrawRoundedRectangle(&round, &line, 1.0 * s, None);
            let dim = ctx.CreateSolidColorBrush(&d2c((150, 160, 196, 255)), None)?;
            ctx.DrawTextLayout(pt(ox + pad, oy + 9.0 * s), &head, &dim, D2D1_DRAW_TEXT_OPTIONS_NONE);
            let ink = ctx.CreateSolidColorBrush(&d2c((238, 241, 251, 255)), None)?;
            ctx.DrawTextLayout(pt(ox + pad, oy + 9.0 * s + hm.height + 3.0 * s), &text, &ink, D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT);
            Ok(())
        })?;
        Ok((surface, w, h))
    }
}

/// The orb itself, in its own click-through window.
pub struct OrbScene {
    compositor: Compositor,
    painter: Painter,
    linear: LinearEasingFunction,
    ease_out: CubicBezierEasingFunction,
    _target: DesktopWindowTarget,
    root: ContainerVisual,
    group: ContainerVisual,
    tilt: ContainerVisual,
    squash: ContainerVisual,
    untilt: ContainerVisual,
    aurora: SpriteVisual,
    aurora_brush: CompositionLinearGradientBrush,
    state: SpriteVisual,
    state_brush: CompositionColorBrush,
    sheen_brush: CompositionLinearGradientBrush,
    badge: SpriteVisual,
    window: f32,
    size: f32,
    scale: f32,
}

/// The click-through layer for everything bigger than the orb: ripple, peek card and
/// the orb-to-panel morph.
pub struct StageScene {
    root: ContainerVisual,
    _target: DesktopWindowTarget,
    ripple: ShapeVisual,
    peek: SpriteVisual,
    spark: SpriteVisual,
    blob: ShapeVisual,
    blob_shape: CompositionRoundedRectangleGeometry,
    skeleton: ContainerVisual,
}

impl OrbScene {
    pub unsafe fn new(compositor: Compositor, hwnd: HWND, window: f32, size: f32, scale: f32) -> Result<Self> {
        let interop: ICompositorDesktopInterop = compositor.cast()?;
        let target = interop.CreateDesktopWindowTarget(hwnd, true)?;
        let c = &compositor;
        let root = c.CreateContainerVisual()?;
        root.SetSize(v2(window, window))?;
        target.SetRoot(&root)?;

        let linear = c.CreateLinearEasingFunction()?;
        let ease_out = c.CreateCubicBezierEasingFunction(v2(0.16, 1.0), v2(0.3, 1.0))?;
        let painter = Painter::new(c)?;
        let inset = (window - size) / 2.0;
        let centre = Vector3 { X: window / 2.0, Y: window / 2.0, Z: 0.0 };

        // Everything that presses, hovers and tucks moves as one. The three nested
        // visuals underneath make a stretch along any direction.
        let nest = |parent: &ContainerVisual| -> Result<ContainerVisual> {
            let visual = c.CreateContainerVisual()?;
            visual.SetSize(v2(window, window))?;
            visual.SetCenterPoint(centre)?;
            parent.Children()?.InsertAtTop(&visual)?;
            Ok(visual)
        };
        let group = nest(&root)?;
        let tilt = nest(&group)?;
        let squash = nest(&tilt)?;
        let untilt = nest(&squash)?;

        let alpha = painter.alpha(size)?;
        let alpha_brush = || c.CreateSurfaceBrushWithSurface(&alpha);
        let sprite = |brush: Option<&CompositionBrush>| -> Result<SpriteVisual> {
            let visual = c.CreateSpriteVisual()?;
            visual.SetSize(v2(size, size))?;
            visual.SetOffset(v3(inset, inset))?;
            if let Some(b) = brush {
                visual.SetBrush(b)?;
            }
            untilt.Children()?.InsertAtTop(&visual)?;
            Ok(visual)
        };

        // Two shadows: a tight dark one that lifts it off anything, and a wide tinted
        // one that makes it feel lit from inside on a dark desktop.
        let shadow = |color: Color, blur: f32, y: f32, opacity: f32| -> Result<()> {
            let visual = sprite(None)?;
            let s = c.CreateDropShadow()?;
            s.SetMask(&alpha_brush()?)?;
            s.SetColor(color)?;
            s.SetBlurRadius(blur * scale)?;
            s.SetOffset(v3(0.0, y * scale))?;
            s.SetOpacity(opacity)?;
            visual.SetShadow(&s)
        };
        shadow(rgba(112, 88, 255, 255), 26.0, 1.0, 0.62)?;
        shadow(rgba(34, 190, 238, 255), 22.0, 9.0, 0.3)?;
        shadow(rgba(4, 6, 20, 255), 12.0, 5.0, 0.6)?;

        sprite(Some(&c.CreateSurfaceBrushWithSurface(&painter.glass(size, scale)?)?.cast()?))?;

        let ring = painter.ring(size, 1.5 * scale)?;
        let masked = |source: &CompositionBrush| -> Result<CompositionBrush> {
            let mask = c.CreateMaskBrush()?;
            mask.SetSource(source)?;
            mask.SetMask(&c.CreateSurfaceBrushWithSurface(&ring)?)?;
            mask.cast()
        };

        // The aurora rim: a gradient that turns while the pointer is over it.
        let aurora_brush = c.CreateLinearGradientBrush()?;
        aurora_brush.SetCenterPoint(v2(0.5, 0.5))?;
        let list = aurora_brush.ColorStops()?;
        for (at, color) in [(0.0, VIOLET), (0.34, BLUE), (0.62, CYAN), (0.84, GREEN), (1.0, PINK)] {
            list.Append(&c.CreateColorGradientStopWithOffsetAndColor(at, color)?)?;
        }
        let aurora = sprite(Some(&masked(&aurora_brush.cast()?)?))?;
        aurora.SetOpacity(RIM_REST)?;

        // Trouble takes over the rim with one flat colour.
        let state_brush = c.CreateColorBrushWithColor(AMBER)?;
        let state = sprite(Some(&masked(&state_brush.cast()?)?))?;
        state.SetOpacity(0.0)?;

        // A band of light that crosses the glass once on hover. It parks off the
        // surface, so at rest it adds nothing.
        let sheen_brush = c.CreateLinearGradientBrush()?;
        sheen_brush.SetStartPoint(v2(-1.2, -1.2))?;
        sheen_brush.SetEndPoint(v2(-0.6, -0.6))?;
        let list = sheen_brush.ColorStops()?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.0, rgba(255, 255, 255, 0))?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.5, rgba(255, 255, 255, 84))?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(1.0, rgba(255, 255, 255, 0))?)?;
        let mask = c.CreateMaskBrush()?;
        mask.SetSource(&sheen_brush)?;
        mask.SetMask(&alpha_brush()?)?;
        sprite(Some(&mask.cast()?))?;

        let icon_size = (size * 0.46).round();
        let icon = c.CreateSpriteVisual()?;
        icon.SetSize(v2(icon_size, icon_size))?;
        icon.SetOffset(v3(((window - icon_size) / 2.0).round(), ((window - icon_size) / 2.0).round()))?;
        icon.SetBrush(&c.CreateSurfaceBrushWithSurface(&painter.icon(icon_size)?)?)?;
        untilt.Children()?.InsertAtTop(&icon)?;

        let badge = c.CreateSpriteVisual()?;
        badge.SetIsVisible(false)?;
        untilt.Children()?.InsertAtTop(&badge)?;

        Ok(Self {
            compositor,
            painter,
            linear,
            ease_out,
            _target: target,
            root,
            group,
            tilt,
            squash,
            untilt,
            aurora,
            aurora_brush,
            state,
            state_brush,
            sheen_brush,
            badge,
            window,
            size,
            scale,
        })
    }

    /// False once the GPU device behind the painted surfaces has been lost, which a
    /// driver update or a GPU reset does. The scene needs rebuilding then.
    pub unsafe fn device_ok(&self) -> bool {
        self.painter.device.GetDeviceRemovedReason().is_ok()
    }

    /// Stop anything being drawn past these window-relative edges, so an orb at a
    /// screen edge never appears on the monitor next door.
    pub unsafe fn clip(&self, left: f32, top: f32, right: f32, bottom: f32) -> Result<()> {
        self.root.SetClip(&self.compositor.CreateInsetClipWithInsets(left, top, right, bottom)?)
    }

    pub unsafe fn unclip(&self) -> Result<()> {
        self.root.SetClip(None)
    }

    unsafe fn spring_keys(&self, spec: Spring, target: &str, insert: impl Fn(f32, &HSTRING, &LinearEasingFunction) -> Result<()>) -> Result<f32> {
        // Each key is a blend from wherever the visual is right now, so an animation
        // that interrupts another picks up mid-flight instead of jumping.
        for (p, v) in spec.keys(26) {
            insert(p, &HSTRING::from(format!("Lerp(this.StartingValue, {target}, {v:.4})")), &self.linear)?;
        }
        Ok(spec.settle())
    }

    unsafe fn scale_to(&self, value: f32, spec: Spring) -> Result<()> {
        let a = self.compositor.CreateVector3KeyFrameAnimation()?;
        let secs = self.spring_keys(spec, &format!("Vector3({value},{value},1)"), |p, e, l| a.InsertExpressionKeyFrameWithEasingFunction(p, e, l))?;
        a.SetDuration(ms(secs * 1000.0))?;
        self.group.StartAnimation(&prop("Scale"), &a)
    }

    unsafe fn fade(&self, visual: &Visual, to: f32, millis: f32) -> Result<()> {
        let a = self.compositor.CreateScalarKeyFrameAnimation()?;
        a.InsertKeyFrameWithEasingFunction(1.0, to, &self.ease_out)?;
        a.SetDuration(ms(millis))?;
        visual.StartAnimation(&prop("Opacity"), &a)
    }

    pub unsafe fn press(&self) -> Result<()> {
        self.scale_to(0.92, PRESS)
    }

    /// Pointer over the orb: it lifts, the rim wakes and turns, and light crosses it.
    pub unsafe fn hover(&self, on: bool, reduced: bool) -> Result<()> {
        self.scale_to(if on { 1.07 } else { 1.0 }, HOVER)?;
        self.fade(&self.aurora.cast()?, if on { 1.0 } else { RIM_REST }, 240.0)?;
        if reduced {
            return Ok(());
        }
        let turn = self.compositor.CreateScalarKeyFrameAnimation()?;
        if on {
            turn.InsertExpressionKeyFrameWithEasingFunction(0.0, &HSTRING::from("this.StartingValue"), &self.linear)?;
            turn.InsertExpressionKeyFrameWithEasingFunction(1.0, &HSTRING::from("this.StartingValue + 360"), &self.linear)?;
            turn.SetDuration(ms(4800.0))?;
            turn.SetIterationBehavior(AnimationIterationBehavior::Forever)?;
            self.sweep()?;
        } else {
            // Coast to the next full turn, which looks exactly like rest, and stop.
            turn.InsertExpressionKeyFrameWithEasingFunction(1.0, &HSTRING::from("Ceil(this.StartingValue / 360) * 360"), &self.ease_out)?;
            turn.SetDuration(ms(1100.0))?;
        }
        self.aurora_brush.StartAnimation(&prop("RotationAngleInDegrees"), &turn)
    }

    unsafe fn sweep(&self) -> Result<()> {
        let band = |name: &str, from: f32, to: f32| -> Result<()> {
            let a = self.compositor.CreateVector2KeyFrameAnimation()?;
            a.InsertKeyFrame(0.0, v2(from, from))?;
            a.InsertKeyFrameWithEasingFunction(1.0, v2(to, to), &self.ease_out)?;
            a.SetDuration(ms(760.0))?;
            self.sheen_brush.StartAnimation(&prop(name), &a)
        };
        band("StartPoint", -1.2, 1.3)?;
        band("EndPoint", -0.6, 1.9)
    }

    /// Lean into the movement while dragged. `by` is 0 at rest.
    pub unsafe fn stretch(&self, angle: f32, by: f32) -> Result<()> {
        let degrees = angle.to_degrees();
        self.tilt.SetRotationAngleInDegrees(degrees)?;
        self.untilt.SetRotationAngleInDegrees(-degrees)?;
        self.squash.SetScale(Vector3 { X: 1.0 + by, Y: 1.0 / (1.0 + by), Z: 1.0 })
    }

    /// Slide part of the way out of the window, which is what clips it at the edge.
    pub unsafe fn tuck(&self, by: f32, dim: f32, reduced: bool) -> Result<()> {
        if reduced {
            self.group.SetOffset(v3(by, 0.0))?;
            return self.group.SetOpacity(dim);
        }
        let a = self.compositor.CreateVector3KeyFrameAnimation()?;
        let secs = self.spring_keys(TUCK, &format!("Vector3({by},0,0)"), |p, e, l| a.InsertExpressionKeyFrameWithEasingFunction(p, e, l))?;
        a.SetDuration(ms(secs * 1000.0))?;
        self.group.StartAnimation(&prop("Offset"), &a)?;
        self.fade(&self.group.cast()?, dim, 320.0)
    }

    /// Fade the whole orb, for a fullscreen app coming and going.
    pub unsafe fn presence(&self, opacity: f32) -> Result<()> {
        self.fade(&self.group.cast()?, opacity, 220.0)
    }

    pub unsafe fn set_rim(&self, rim: Rim) -> Result<()> {
        let color = match rim {
            Rim::Synced => {
                self.fade(&self.state.cast()?, 0.0, 320.0)?;
                return self.fade(&self.aurora.cast()?, RIM_REST, 320.0);
            }
            Rim::Reconnecting => AMBER,
            Rim::Off => QUIET,
            Rim::Recording => RED,
        };
        self.state_brush.SetColor(color)?;
        self.fade(&self.aurora.cast()?, 0.0, 240.0)?;
        if matches!(rim, Rim::Off) {
            return self.fade(&self.state.cast()?, 0.7, 240.0);
        }
        // A slow pulse that ends: it says something once, then stops costing frames.
        let a = self.compositor.CreateScalarKeyFrameAnimation()?;
        a.InsertKeyFrame(0.0, 1.0)?;
        a.InsertKeyFrame(0.5, 0.4)?;
        a.InsertKeyFrame(1.0, 1.0)?;
        a.SetDuration(ms(1800.0))?;
        a.SetIterationBehavior(AnimationIterationBehavior::Count)?;
        a.SetIterationCount(if matches!(rim, Rim::Recording) { 100 } else { 5 })?;
        self.state.StartAnimation(&prop("Opacity"), &a)
    }

    /// The rim flares for a new note.
    pub unsafe fn flash(&self) -> Result<()> {
        let a = self.compositor.CreateScalarKeyFrameAnimation()?;
        a.InsertKeyFrame(0.16, 1.0)?;
        a.InsertExpressionKeyFrame(1.0, &HSTRING::from("this.StartingValue"))?;
        a.SetDuration(ms(1200.0))?;
        self.aurora.StartAnimation(&prop("Opacity"), &a)?;
        self.sweep()
    }

    pub unsafe fn set_unread(&self, count: u32) -> Result<()> {
        if count == 0 {
            return self.badge.SetIsVisible(false);
        }
        let h = (19.0 * self.scale).round();
        let text = if count > 99 { "99+".to_string() } else { count.to_string() };
        let (surface, w, full) = self.painter.badge(&text, h, self.scale)?;
        self.badge.SetSize(v2(w, full))?;
        let inset = (self.window - self.size) / 2.0;
        let nudge = 5.0 * self.scale;
        self.badge.SetOffset(v3((self.window - inset - w + nudge).round(), (inset - nudge).round()))?;
        self.badge.SetBrush(&self.compositor.CreateSurfaceBrushWithSurface(&surface)?)?;
        self.badge.SetIsVisible(true)?;
        self.badge.SetCenterPoint(Vector3 { X: w / 2.0, Y: full / 2.0, Z: 0.0 })?;
        let a = self.compositor.CreateVector3KeyFrameAnimation()?;
        a.InsertKeyFrame(0.0, Vector3 { X: 0.6, Y: 0.6, Z: 1.0 })?;
        for (p, v) in HOVER.keys(14) {
            let s = 0.6 + 0.4 * v;
            a.InsertKeyFrameWithEasingFunction(p, Vector3 { X: s, Y: s, Z: 1.0 }, &self.linear)?;
        }
        a.SetDuration(ms(HOVER.settle() * 1000.0))?;
        self.badge.StartAnimation(&prop("Scale"), &a)
    }

    pub unsafe fn stage(&self, hwnd: HWND) -> Result<StageScene> {
        let c = &self.compositor;
        let interop: ICompositorDesktopInterop = c.cast()?;
        let target = interop.CreateDesktopWindowTarget(hwnd, true)?;
        let root = c.CreateContainerVisual()?;
        target.SetRoot(&root)?;

        let blob_shape = c.CreateRoundedRectangleGeometry()?;
        let sprite = c.CreateSpriteShapeWithGeometry(&blob_shape)?;
        let fill = c.CreateLinearGradientBrush()?;
        fill.SetStartPoint(v2(0.0, 0.0))?;
        fill.SetEndPoint(v2(1.0, 1.0))?;
        let list = fill.ColorStops()?;
        // The orb's own glass, thinned out: the shape reads as the orb opening up, and
        // what's behind it shows through the way it will through the panel.
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.0, rgba(44, 34, 104, 226))?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.46, rgba(17, 18, 38, 232))?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(1.0, rgba(10, 38, 48, 226))?)?;
        sprite.SetFillBrush(&fill)?;
        let edge = c.CreateLinearGradientBrush()?;
        edge.SetStartPoint(v2(0.0, 0.0))?;
        edge.SetEndPoint(v2(1.0, 1.0))?;
        let list = edge.ColorStops()?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.0, rgba(139, 123, 255, 190))?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.5, rgba(34, 211, 238, 110))?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(1.0, rgba(52, 211, 153, 70))?)?;
        sprite.SetStrokeBrush(&edge)?;
        sprite.SetStrokeThickness(1.0 * self.scale)?;
        let blob = c.CreateShapeVisual()?;
        blob.Shapes()?.Append(&sprite)?;
        blob.SetIsVisible(false)?;
        root.Children()?.InsertAtTop(&blob)?;

        let skeleton = c.CreateContainerVisual()?;
        skeleton.SetIsVisible(false)?;
        root.Children()?.InsertAtTop(&skeleton)?;

        let ring = c.CreateEllipseGeometry()?;
        let r = self.size / 2.0;
        ring.SetCenter(v2(r, r))?;
        ring.SetRadius(v2(r, r))?;
        let line = c.CreateSpriteShapeWithGeometry(&ring)?;
        let ring_brush = c.CreateLinearGradientBrush()?;
        let list = ring_brush.ColorStops()?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.0, VIOLET)?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(1.0, CYAN)?)?;
        line.SetStrokeBrush(&ring_brush)?;
        line.SetStrokeThickness(1.6 * self.scale)?;
        let ripple = c.CreateShapeVisual()?;
        ripple.SetSize(v2(self.size, self.size))?;
        ripple.SetCenterPoint(Vector3 { X: r, Y: r, Z: 0.0 })?;
        ripple.Shapes()?.Append(&line)?;
        ripple.SetOpacity(0.0)?;
        root.Children()?.InsertAtTop(&ripple)?;

        let spark = c.CreateSpriteVisual()?;
        let d = 26.0 * self.scale;
        spark.SetSize(v2(d, d))?;
        let glow = c.CreateRadialGradientBrush()?;
        let list = glow.ColorStops()?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.0, rgba(255, 255, 255, 255))?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(0.3, rgba(150, 240, 252, 230))?)?;
        list.Append(&c.CreateColorGradientStopWithOffsetAndColor(1.0, rgba(34, 211, 238, 0))?)?;
        spark.SetBrush(&glow)?;
        spark.SetIsVisible(false)?;
        root.Children()?.InsertAtTop(&spark)?;

        let peek = c.CreateSpriteVisual()?;
        peek.SetOpacity(0.0)?;
        let s = c.CreateDropShadow()?;
        s.SetColor(rgba(0, 0, 0, 255))?;
        s.SetBlurRadius(20.0 * self.scale)?;
        s.SetOffset(v3(0.0, 8.0 * self.scale))?;
        s.SetOpacity(0.5)?;
        peek.SetShadow(&s)?;
        root.Children()?.InsertAtTop(&peek)?;

        Ok(StageScene { root, _target: target, ripple, peek, spark, blob, blob_shape, skeleton })
    }

    /// Rings leave the orb. Returns how long the stage needs to stay up.
    pub unsafe fn ripple(&self, stage: &StageScene, x: f32, y: f32) -> Result<f32> {
        stage.ripple.SetOffset(v3(x, y))?;
        let grow = self.compositor.CreateVector3KeyFrameAnimation()?;
        grow.InsertKeyFrame(0.0, Vector3 { X: 1.0, Y: 1.0, Z: 1.0 })?;
        grow.InsertKeyFrameWithEasingFunction(1.0, Vector3 { X: 2.3, Y: 2.3, Z: 1.0 }, &self.ease_out)?;
        grow.SetDuration(ms(820.0))?;
        stage.ripple.StartAnimation(&prop("Scale"), &grow)?;
        let fade = self.compositor.CreateScalarKeyFrameAnimation()?;
        fade.InsertKeyFrame(0.0, 0.9)?;
        fade.InsertKeyFrameWithEasingFunction(1.0, 0.0, &self.ease_out)?;
        fade.SetDuration(ms(820.0))?;
        stage.ripple.StartAnimation(&prop("Opacity"), &fade)?;
        Ok(0.85)
    }

    /// Paint the card. Place it with `show_peek`.
    pub unsafe fn paint_peek(&self, stage: &StageScene, label: &str, body: &str) -> Result<(f32, f32)> {
        let (surface, w, h) = self.painter.peek(label, body, self.scale)?;
        stage.peek.SetSize(v2(w, h))?;
        stage.peek.SetBrush(&self.compositor.CreateSurfaceBrushWithSurface(&surface)?)?;
        Ok((w, h))
    }

    /// The card slides out from behind the orb, holds, and fades.
    pub unsafe fn show_peek(&self, stage: &StageScene, x: f32, y: f32, from: f32, reduced: bool, hold_ms: f32) -> Result<()> {
        let fade = self.compositor.CreateScalarKeyFrameAnimation()?;
        let total = hold_ms + 420.0;
        fade.InsertKeyFrame(0.0, 0.0)?;
        fade.InsertKeyFrameWithEasingFunction(160.0 / total, 1.0, &self.ease_out)?;
        fade.InsertKeyFrame(1.0 - 240.0 / total, 1.0)?;
        fade.InsertKeyFrame(1.0, 0.0)?;
        fade.SetDuration(ms(total))?;
        stage.peek.StartAnimation(&prop("Opacity"), &fade)?;
        if reduced {
            return stage.peek.SetOffset(v3(x, y));
        }
        let slide = self.compositor.CreateVector3KeyFrameAnimation()?;
        for (p, v) in HOVER.keys(18) {
            slide.InsertKeyFrameWithEasingFunction(p, v3(from + (x - from) * v, y), &self.linear)?;
        }
        slide.SetDuration(ms(HOVER.settle() * 1000.0))?;
        stage.peek.StartAnimation(&prop("Offset"), &slide)
    }

    /// A spark from the copy to the orb.
    pub unsafe fn spark(&self, stage: &StageScene, from: (f32, f32), to: (f32, f32)) -> Result<()> {
        let d = stage.spark.Size()?.X / 2.0;
        let (cx, cy) = ((from.0 + to.0) / 2.0, from.1.min(to.1) - 90.0 * self.scale);
        let a = self.compositor.CreateVector3KeyFrameAnimation()?;
        for i in 0..=18 {
            let t = i as f32 / 18.0;
            let u = 1.0 - t;
            let x = u * u * from.0 + 2.0 * u * t * cx + t * t * to.0 - d;
            let y = u * u * from.1 + 2.0 * u * t * cy + t * t * to.1 - d;
            a.InsertKeyFrameWithEasingFunction(t, v3(x, y), &self.linear)?;
        }
        a.SetDuration(ms(520.0))?;
        stage.spark.SetIsVisible(true)?;
        stage.spark.StartAnimation(&prop("Offset"), &a)
    }

    pub unsafe fn hide_spark(&self, stage: &StageScene) -> Result<()> {
        stage.spark.SetIsVisible(false)
    }

    /// Grow the shape from `from` to `to`, both relative to the stage. Returns seconds.
    pub unsafe fn morph(&self, stage: &StageScene, from: Rect, to: Rect, opening: bool, reduced: bool) -> Result<f32> {
        let panel = PANEL_RADIUS_DIP * self.scale;
        let orb = self.size * 0.42;
        let (spec, r0, r1) = if opening { (OPEN, orb, panel) } else { (CLOSE, panel, orb) };
        stage.blob.StopAnimation(&prop("Opacity"))?;
        stage.blob.SetOpacity(1.0)?;
        stage.blob.SetSize(stage.root.Size()?)?;
        stage.blob_shape.SetOffset(v2(from.x as f32, from.y as f32))?;
        stage.blob_shape.SetSize(v2(from.w as f32, from.h as f32))?;
        stage.blob_shape.SetCornerRadius(v2(r0, r0))?;
        stage.blob.SetIsVisible(true)?;
        if reduced {
            stage.blob_shape.SetOffset(v2(to.x as f32, to.y as f32))?;
            stage.blob_shape.SetSize(v2(to.w as f32, to.h as f32))?;
            stage.blob_shape.SetCornerRadius(v2(r1, r1))?;
            return Ok(0.12);
        }
        let run = |name: &str, target: Vector2| -> Result<f32> {
            let a = self.compositor.CreateVector2KeyFrameAnimation()?;
            let text = format!("Vector2({},{})", target.X, target.Y);
            let secs = self.spring_keys(spec, &text, |p, e, l| a.InsertExpressionKeyFrameWithEasingFunction(p, e, l))?;
            a.SetDuration(ms(secs * 1000.0))?;
            stage.blob_shape.StartAnimation(&prop(name), &a)?;
            Ok(secs)
        };
        run("Offset", v2(to.x as f32, to.y as f32))?;
        run("CornerRadius", v2(r1, r1))?;
        run("Size", v2(to.w as f32, to.h as f32))
    }

    /// Placeholder rows, shown while the panel's page is still starting.
    pub unsafe fn skeleton(&self, stage: &StageScene, area: Rect) -> Result<()> {
        let c = &self.compositor;
        stage.skeleton.Children()?.RemoveAll()?;
        let s = self.scale;
        let (pad, row, gap) = (14.0 * s, 64.0 * s, 8.0 * s);
        let top = 112.0 * s;
        let count = (((area.h as f32 - top) / (row + gap)) as i32).clamp(1, 9);
        for i in 0..count {
            let geometry = c.CreateRoundedRectangleGeometry()?;
            geometry.SetSize(v2(area.w as f32 - pad * 2.0, row))?;
            geometry.SetCornerRadius(v2(13.0 * s, 13.0 * s))?;
            let shape = c.CreateSpriteShapeWithGeometry(&geometry)?;
            shape.SetFillBrush(&c.CreateColorBrushWithColor(rgba(255, 255, 255, 14))?)?;
            let visual = c.CreateShapeVisual()?;
            visual.SetSize(v2(area.w as f32, row))?;
            visual.Shapes()?.Append(&shape)?;
            visual.SetOffset(v3(area.x as f32 + pad, area.y as f32 + top + i as f32 * (row + gap)))?;
            let pulse = c.CreateScalarKeyFrameAnimation()?;
            pulse.InsertKeyFrame(0.0, 0.5)?;
            pulse.InsertKeyFrame(0.5, 1.0)?;
            pulse.InsertKeyFrame(1.0, 0.5)?;
            pulse.SetDuration(ms(1300.0))?;
            pulse.SetDelayTime(ms(i as f32 * 70.0))?;
            pulse.SetIterationBehavior(AnimationIterationBehavior::Forever)?;
            visual.StartAnimation(&prop("Opacity"), &pulse)?;
            stage.skeleton.Children()?.InsertAtTop(&visual)?;
        }
        stage.skeleton.SetIsVisible(true)
    }

    pub unsafe fn hide_skeleton(&self, stage: &StageScene) -> Result<()> {
        stage.skeleton.Children()?.RemoveAll()?;
        stage.skeleton.SetIsVisible(false)
    }

    /// Fade the shape away, revealing the real panel underneath.
    pub unsafe fn fade_blob(&self, stage: &StageScene, millis: f32) -> Result<()> {
        let a = self.compositor.CreateScalarKeyFrameAnimation()?;
        a.InsertKeyFrame(1.0, 0.0)?;
        a.SetDuration(ms(millis))?;
        stage.blob.StartAnimation(&prop("Opacity"), &a)
    }

    pub unsafe fn hide_blob(&self, stage: &StageScene) -> Result<()> {
        stage.blob.SetIsVisible(false)
    }
}

impl StageScene {
    pub unsafe fn resize(&self, w: f32, h: f32) -> Result<()> {
        self.root.SetSize(v2(w, h))
    }
}
