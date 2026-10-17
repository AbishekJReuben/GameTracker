//! A single or combined, immutable physical capture layout. Acquisition belongs
//! to the shared broker; this module owns only an output-sized composition and
//! bounded per-foreign-adapter tiles. It contains no decoration or input code.
#![cfg(windows)]
use super::{
    capture_broker::{Adapter, AdapterKey, Output, OutputState},
    display::{DisplayInfo, PhysicalRect},
    dxdupe::Grab,
    gpu::Compositor,
    gpu_transfer::{AsyncReadback, Readback, Texture},
    view::{AppliedView, CaptureIdentity, ViewMode},
};
use parking_lot::{ArcMutexGuard, RawMutex};
use std::sync::Arc;
use std::collections::HashMap;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11ShaderResourceView,
};
static REQUEST: once_cell::sync::Lazy<parking_lot::RwLock<Option<AppliedView>>> =
    once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(None));
static REQUEST_REVISION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static IDENTITY:once_cell::sync::Lazy<parking_lot::RwLock<Option<Arc<CaptureIdentity>>>>=once_cell::sync::Lazy::new(||parking_lot::RwLock::new(None));
pub(crate) fn requested_identity()->Option<Arc<CaptureIdentity>>{IDENTITY.read().clone()}
pub(crate) fn request_identity(identity:Option<Arc<CaptureIdentity>>){
    let view=identity.as_ref().map(|i|i.view.clone());*IDENTITY.write()=identity;
    *REQUEST.write()=view;REQUEST_REVISION.fetch_add(1,std::sync::atomic::Ordering::Release);
}
pub(crate) fn request(view: Option<AppliedView>) {
    *IDENTITY.write()=None;
    *REQUEST.write() = view;
    REQUEST_REVISION.fetch_add(1, std::sync::atomic::Ordering::Release);
}
pub(crate) fn request_revision() -> u64 {
    REQUEST_REVISION.load(std::sync::atomic::Ordering::Acquire)
}
pub(crate) fn requested() -> Option<AppliedView> {
    REQUEST.read().clone()
}
pub(crate) fn layout(selected: usize, max_width: u32) -> Option<AppliedView> {
    let snapshot = super::display::snapshot();
    if let Some(identity)=requested_identity(){return (identity.view.layout_revision==snapshot.revision).then(||identity.view.clone());}
    let request = requested();
    let mode = request.as_ref().map_or(ViewMode::Single, |r| r.mode);
    let selected = request
        .as_ref()
        .map(|r| r.selected_display_id.as_str())
        .or_else(|| snapshot.displays.get(selected).map(|d| d.id.as_str()))?;
    AppliedView::create(
        &snapshot,
        mode,
        selected,
        request.as_ref().map_or(0, |r| r.epoch),
        max_width,
        4096,
        8_294_400,
    )
}

struct ForeignTile {
    compositor: Compositor,
    transfer: AsyncReadback,
    upload: Texture,
    ready: bool,
}
pub(crate) struct Surface {
    pub view: AppliedView,
    outputs: Vec<Output>,
    seen: HashMap<String, u64>,
    compositor: Option<Compositor>,
    cpu_target: Option<Compositor>,
    srv: Option<ID3D11ShaderResourceView>,
    foreign: HashMap<String, ForeignTile>,
    readback: Readback,
    cpu_composited: bool,
    cpu_sequence: u64,
    has_frame: bool,
    cursor: Option<(i32, i32)>,
    pub compositions: u64,
    pub cross_adapter_bytes: u64,
}
type LockedAdapters = Vec<(AdapterKey, ArcMutexGuard<RawMutex, Adapter>)>;
pub(crate) struct Frame<'a> {
    surface: &'a mut Surface,
    adapters: LockedAdapters,
    main: usize,
    _dpi: super::display::DpiScope,
}
impl Surface {
    pub fn new(view: AppliedView) -> Option<Self> {
        Self::new_impl(view, false)
    }
    #[cfg(any(test, feature = "capture-probes"))]
    pub fn separate_devices(view: AppliedView) -> Option<Self> {
        Self::new_impl(view, true)
    }
    fn new_impl(view: AppliedView, separate_devices: bool) -> Option<Self> {
        let _ = separate_devices;
        if view.displays.is_empty() || view.displays.len() > 16 {
            return None;
        }
        // The selected adapter owns the combined encoder target. Sharing an
        // output lease cannot create a second duplication for an existing pop-out.
        let mut displays = view.displays.clone();
        displays.sort_by_key(|d| d.id != view.selected_display_id);
        let outputs = displays
            .iter()
            .map(|d| {
                #[cfg(any(test, feature = "capture-probes"))]
                if separate_devices {
                    return Output::separate_device(d);
                }
                Output::new(d)
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            view,
            outputs,
            seen: HashMap::new(),
            compositor: None,
            cpu_target: None,
            srv: None,
            foreign: HashMap::new(),
            readback: Readback::default(),
            cpu_composited: false,
            cpu_sequence: 0,
            has_frame: false,
            cursor: None,
            compositions: 0,
            cross_adapter_bytes: 0,
        })
    }
    pub fn lock(&mut self) -> Frame<'_> {
        // Every multi-adapter consumer takes the same global LUID order. A new
        // primary selected on B cannot deadlock an old A-selected source during
        // supersession. No AcquireNextFrame wait occurs inside these locks.
        let selected = self.outputs[0].key();
        let mut outputs = self.outputs.clone();
        outputs.sort_by_key(Output::key);
        outputs.dedup_by_key(|o| o.key());
        let adapters: LockedAdapters = outputs.iter().map(|o| (o.key(), o.lock())).collect();
        let main = adapters
            .iter()
            .position(|(key, _)| *key == selected)
            .unwrap();
        Frame {
            surface: self,
            adapters,
            main,
            _dpi: super::display::DpiScope::physical(),
        }
    }
    pub fn force_output_fallback(&self, id: &str) {
        if let Some(output) = self.outputs.iter().find(|o| o.id() == id) {
            output.force_fallback();
        }
    }
    pub fn recover_output(&self, id: &str) {
        if let Some(output) = self.outputs.iter().find(|o| o.id() == id) {
            output.recover_duplication();
        }
    }
    #[cfg(any(test, feature = "capture-probes"))]
    pub fn prepare_recovery(&self, id: &str) -> bool {
        self.outputs
            .iter()
            .find(|o| o.id() == id)
            .is_some_and(Output::prepare_native)
    }
    #[cfg(any(test, feature = "capture-probes"))]
    pub fn freeze_snapshot(&self, id: &str, frozen: bool) {
        if let Some(output) = self.outputs.iter().find(|o| o.id() == id) {
            output.freeze_snapshot(frozen);
        }
    }
    fn compose(&mut self, adapters: &mut LockedAdapters, main: usize) -> Grab {
        let (device, context) = (
            adapters[main].1.device.clone(),
            adapters[main].1.context.clone(),
        );
        let primary = self.outputs[0].key();
        let cursor = cursor_position();
        let mut changed = self.cursor != cursor || !self.has_frame;
        self.cursor = cursor;
        if self.compositor.is_none() {
            self.compositor = Compositor::new(&device, &context, self.view.width, self.view.height);
            self.srv = self.compositor.as_ref().and_then(Compositor::output_srv);
        }
        let Some(compositor) = self.compositor.as_mut() else {
            return Grab::Lost;
        };
        let mut ready = true;
        for output in &self.outputs {
            if output.key() == primary {
                let Some(state) = adapters[main].1.outputs.get_mut(output.id()) else {
                    return Grab::Lost;
                };
                state.poll(&device, &context, true);
                changed |= self.seen.get(output.id()) != Some(&state.sequence);
                ready &= state.srv().is_some();
                self.seen.insert(output.id().into(), state.sequence);
            } else {
                let source_index = adapters
                    .iter()
                    .position(|(key, _)| *key == output.key())
                    .unwrap();
                let source = &mut adapters[source_index].1;
                let (source_device, source_context) =
                    (source.device.clone(), source.context.clone());
                let Some(state) = source.outputs.get_mut(output.id()) else {
                    return Grab::Lost;
                };
                state.poll(&source_device, &source_context, true);
                let d = &state.display;
                let region = tile_rect(self.view.source, self.view.width, self.view.height, d);
                let (w, h) = (
                    region[2].ceil().max(1.) as u32,
                    region[3].ceil().max(1.) as u32,
                );
                if !self.foreign.contains_key(output.id()) {
                    let Some(comp) = Compositor::new(&source_device, &source_context, w, h) else {
                        return Grab::Lost;
                    };
                    let Some(upload) = Texture::new(&device, w, h) else {
                        return Grab::Lost;
                    };
                    self.foreign.insert(
                        output.id().into(),
                        ForeignTile {
                            compositor: comp,
                            transfer: Default::default(),
                            upload,
                            ready: false,
                        },
                    );
                }
                let tile = self.foreign.get_mut(output.id()).unwrap();
                if tile.transfer.poll(&source_context) {
                    if tile.upload.upload(&context, &tile.transfer.bytes) {
                        tile.ready = true;
                        self.cross_adapter_bytes += tile.transfer.bytes.len() as u64;
                        changed = true;
                    }
                }
                // Each queued copy retains its own source sequence. Polling is
                // nonblocking and at most two transfers can be outstanding.
                if let Some(srv) = state.srv() {
                    if state.sequence > tile.transfer.ready_sequence {
                        if render_output(
                            &mut tile.compositor,
                            state,
                            &srv,
                            [0., 0., w as f32, h as f32],
                            None,
                        ) {
                            tile.transfer.submit(
                                &source_device,
                                &source_context,
                                tile.compositor.output(),
                                w,
                                h,
                                state.sequence,
                            );
                        }
                    }
                }
                ready &= tile.ready;
            }
        }
        if !ready {
            return Grab::Timeout;
        }
        if !changed {
            return Grab::Timeout;
        }
        compositor.clear();
        for output in &self.outputs {
            let d = self
                .view
                .displays
                .iter()
                .find(|d| d.id == output.id())
                .unwrap();
            let region = tile_rect(self.view.source, self.view.width, self.view.height, d);
            let ok = if output.key() == primary {
                let state = adapters[main].1.outputs.get_mut(output.id()).unwrap();
                let Some(srv) = state.srv() else {
                    return Grab::Lost;
                };
                render_output(compositor, state, &srv, region, None)
            } else {
                let tile = self.foreign.get(output.id()).unwrap();
                compositor.render_region(
                    &tile.upload.srv,
                    tile.upload.width,
                    tile.upload.height,
                    false,
                    None,
                    region,
                    0,
                )
            };
            if !ok {
                return Grab::Lost;
            }
        }
        self.has_frame = true;
        self.compositions += 1;
        Grab::Frame {
            w: self.view.width,
            h: self.view.height,
            native_w: self.view.width,
            native_h: self.view.height,
        }
    }
}
fn render_output(
    comp: &mut Compositor,
    state: &mut OutputState,
    srv: &ID3D11ShaderResourceView,
    region: [f32; 4],
    cursor: Option<(i32, i32)>,
) -> bool {
    let (w, h) = state.native_size();
    let mips = state.mips();
    let rotation = state.rotation;
    let sequence = state.cursor_seq();
    let cursor_on = cursor.is_some_and(|(x, y)| state.display.rect().contains(x, y));
    let image = if cursor_on { state.cursor() } else { None };
    comp.render_region(
        srv,
        w,
        h,
        mips,
        image.map(|c| (c, sequence)),
        region,
        rotation,
    )
}
pub(crate) fn tile_rect(source: PhysicalRect, w: u32, h: u32, display: &DisplayInfo) -> [f32; 4] {
    let sx = w as f32 / source.width as f32;
    let sy = h as f32 / source.height as f32;
    [
        (display.x - source.x) as f32 * sx,
        (display.y - source.y) as f32 * sy,
        display.width as f32 * sx,
        display.height as f32 * sy,
    ]
}
fn cursor_position() -> Option<(i32, i32)> {
    unsafe {
        use windows::Win32::UI::WindowsAndMessaging::*;
        let mut c = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut c).is_ok() && c.flags == CURSOR_SHOWING {
            Some((c.ptScreenPos.x, c.ptScreenPos.y))
        } else {
            None
        }
    }
}
impl Frame<'_> {
    fn state(&self) -> &OutputState {
        self.adapters[self.main]
            .1
            .outputs
            .get(self.surface.outputs[0].id())
            .unwrap()
    }
    fn state_mut(&mut self) -> &mut OutputState {
        self.adapters[self.main]
            .1
            .outputs
            .get_mut(self.surface.outputs[0].id())
            .unwrap()
    }
    pub fn device(&self) -> &ID3D11Device {
        &self.adapters[self.main].1.device
    }
    pub fn context(&self) -> &ID3D11DeviceContext {
        &self.adapters[self.main].1.context
    }
    pub fn native_size(&self) -> (u32, u32) {
        if self.surface.view.mode == ViewMode::All {
            (self.surface.view.width, self.surface.view.height)
        } else {
            let d = &self.state().display;
            (d.width, d.height)
        }
    }
    pub fn source_size(&self) -> (u32, u32) {
        (
            self.surface.view.source.width,
            self.surface.view.source.height,
        )
    }
    pub fn grab_gpu(&mut self, _timeout_ms: u32, want_mips: bool) -> Grab {
        self.surface.cpu_composited = false;
        if self.surface.view.mode == ViewMode::All {
            return self.surface.compose(&mut self.adapters, self.main);
        }
        let (device, context) = (
            self.adapters[self.main].1.device.clone(),
            self.adapters[self.main].1.context.clone(),
        );
        let id = self.surface.outputs[0].id().to_string();
        let state = self.adapters[self.main].1.outputs.get_mut(&id).unwrap();
        state.poll(&device, &context, want_mips);
        let sequence = state.sequence;
        let (w, h) = (state.display.width, state.display.height);
        if state.srv().is_none() || self.surface.seen.get(&id) == Some(&sequence) {
            return Grab::Timeout;
        }
        self.surface.seen.insert(id, sequence);
        Grab::Frame {
            w,
            h,
            native_w: w,
            native_h: h,
        }
    }
    pub fn render(&mut self, compositor: &mut Compositor) -> bool {
        if self.surface.view.mode == ViewMode::All {
            let Some(srv) = self.surface.srv.clone() else {
                return false;
            };
            let source = self.surface.view.source;
            let (w, h) = (self.surface.view.width, self.surface.view.height);
            // Cursor is a single final pass on the destination device. Never
            // bake it into delayed foreign tiles, which could leave an old
            // pointer behind when it crosses an adapter seam.
            let output = cursor_position()
                .and_then(|(x, y)| {
                    self.surface
                        .view
                        .displays
                        .iter()
                        .find(|d| d.rect().contains(x, y))
                })
                .and_then(|d| self.surface.outputs.iter().find(|o| o.id() == d.id))
                .cloned();
            if let Some(output) = output {
                let index = self
                    .adapters
                    .iter()
                    .position(|(key, _)| *key == output.key())
                    .unwrap();
                let state = self.adapters[index].1.outputs.get_mut(output.id()).unwrap();
                let sequence = state.cursor_seq();
                let origin = (state.display.x, state.display.y);
                if let Some(image) = state.cursor() {
                    let rect = [
                        (origin.0 + image.x - source.x) as f32 / source.width as f32,
                        (origin.1 + image.y - source.y) as f32 / source.height as f32,
                        image.w as f32 / source.width as f32,
                        image.h as f32 / source.height as f32,
                    ];
                    return compositor.render_scene_cursor(
                        &srv,
                        w,
                        h,
                        Some((image, sequence, rect)),
                    );
                }
            }
            return compositor.render_scene_cursor(&srv, w, h, None);
        }
        let (w, h) = compositor.size();
        let cursor = cursor_position();
        let state = self.state_mut();
        let Some(srv) = state.srv() else {
            return false;
        };
        render_output(
            compositor,
            state,
            &srv,
            [0., 0., w as f32, h as f32],
            cursor,
        )
    }
    pub fn grab(&mut self, timeout_ms: u32, max_w: u32) -> Grab {
        let frame = self.grab_gpu(timeout_ms, true);
        if matches!(frame, Grab::Lost) {
            return frame;
        }
        // GPU and CPU consumers have independent seen sequences. A rejected
        // NVENC/compositor initialization must still allow the retained first
        // static image to reach the JPEG fallback immediately.
        let sequence = if self.surface.view.mode == ViewMode::All {
            self.surface.compositions
        } else {
            self.state().sequence
        };
        if sequence == self.surface.cpu_sequence || self.state().srv().is_none() {
            return Grab::Timeout;
        }
        if self.surface.view.mode == ViewMode::Single
            && self.state().rotation == 0
            && !self.state().fallback()
        {
            let result = self.state_mut().readback(max_w);
            if matches!(result, Grab::Frame { .. }) {
                self.surface.cpu_sequence = sequence;
            }
            return result;
        }
        // Combined, rotated and fallback sources read back only the negotiated
        // small target, with their normal cursor already composited once.
        let (nw, nh) = self.native_size();
        let (w, h) = if self.surface.view.mode == ViewMode::All {
            (nw, nh)
        } else {
            super::view::fit_size(
                PhysicalRect {
                    x: 0,
                    y: 0,
                    width: nw,
                    height: nh,
                },
                max_w,
                4096,
                8_294_400,
            )
        };
        if self
            .surface
            .cpu_target
            .as_ref()
            .is_none_or(|c| c.size() != (w, h))
        {
            self.surface.cpu_target = Compositor::new(self.device(), self.context(), w, h);
        }
        let Some(mut comp) = self.surface.cpu_target.take() else {
            return Grab::Lost;
        };
        let ok = self.render(&mut comp);
        self.surface.cpu_target = Some(comp);
        if !ok {
            return Grab::Lost;
        }
        let (device, context) = (
            self.adapters[self.main].1.device.clone(),
            self.adapters[self.main].1.context.clone(),
        );
        let comp = self.surface.cpu_target.as_ref().unwrap();
        if !self
            .surface
            .readback
            .copy(&device, &context, comp.output(), w, h)
        {
            return Grab::Lost;
        }
        self.surface.cpu_composited = true;
        self.surface.cpu_sequence = sequence;
        Grab::Frame {
            w,
            h,
            native_w: nw,
            native_h: nh,
        }
    }
    pub fn buffer(&self) -> &[u8] {
        if self.surface.cpu_composited {
            &self.surface.readback.bytes
        } else {
            self.state().buffer()
        }
    }
    pub fn draw_cursor(&self, pixels: &mut [u8], w: u32, h: u32) {
        if !self.surface.cpu_composited {
            self.state().draw_cursor(pixels, w, h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_tiles_preserve_negative_origins_gaps_and_total_output_limit() {
        let snapshot = super::super::display::DisplaySnapshot {
            revision: 1,
            bounds: PhysicalRect {
                x: -3840,
                y: 0,
                width: 7680,
                height: 2160,
            },
            displays: vec![],
        };
        let d = DisplayInfo {
            id: "left".into(),
            index: 0,
            name: "left".into(),
            x: -3840,
            y: 0,
            width: 3840,
            height: 2160,
            rotation: 0,
            is_primary: false,
            selected: false,
            layout_revision: 1,
        };
        assert_eq!(
            tile_rect(snapshot.bounds, 1920, 540, &d),
            [0., 0., 960., 540.]
        );
        let mut right = d.clone();
        right.x = 0;
        assert_eq!(
            tile_rect(snapshot.bounds, 1920, 540, &right),
            [960., 0., 960., 540.]
        );
        right.x = 1920;
        assert_eq!(
            tile_rect(
                PhysicalRect {
                    width: 9600,
                    ..snapshot.bounds
                },
                1920,
                432,
                &right
            ),
            [1152., 0., 768., 432.]
        );
    }
}
