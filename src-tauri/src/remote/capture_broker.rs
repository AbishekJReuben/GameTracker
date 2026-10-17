//! One physical-output acquisition shared by primary, combined and pop-out
//! consumers. Adapter locks serialize their common immediate context. DXGI is
//! always polled with timeout zero; callers pace outside the graphics lock.
#![cfg(windows)]
use super::{
    display::DisplayInfo,
    dxdupe::{CursorImage, Duplicator, Grab, OutputBinding},
    gpu_transfer::Texture,
};
use once_cell::sync::Lazy;
use parking_lot::{ArcMutexGuard, Mutex, RawMutex};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Weak,
    },
    time::{Duration, Instant},
};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11ShaderResourceView,
};
pub(crate) type AdapterKey = (i32, u32, u32);
static ADAPTERS: Lazy<Mutex<HashMap<AdapterKey, Weak<Mutex<Adapter>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static CREATED: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Adapter {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub outputs: HashMap<String, OutputState>,
}
pub(crate) struct OutputState {
    pub display: DisplayInfo,
    pub sequence: u64,
    pub acquisitions: u64,
    pub polls: u64,
    pub fallback_frames: u64,
    pub consumers: usize,
    pub serial: u64,
    pub rotation: u32,
    binding: OutputBinding,
    dup: Option<Duplicator>,
    fallback: Option<Texture>,
    fallback_pixels: Vec<u8>,
    last_poll: Instant,
    last_fallback: Instant,
    retry: Instant,
    force_fallback: bool,
    fallback_cursor: super::system_cursor::SystemCursor,
    #[cfg(any(test, feature = "capture-probes"))]
    frozen: bool,
}
impl OutputState {
    fn new(display: DisplayInfo, binding: OutputBinding) -> Self {
        Self {
            rotation: binding.rotation,
            display,
            binding,
            dup: None,
            fallback: None,
            fallback_pixels: Vec::new(),
            sequence: 0,
            acquisitions: 0,
            polls: 0,
            fallback_frames: 0,
            consumers: 0,
            serial: CREATED.fetch_add(1, Ordering::Relaxed) + 1,
            last_poll: Instant::now() - Duration::from_secs(2),
            last_fallback: Instant::now() - Duration::from_secs(2),
            retry: Instant::now() - Duration::from_secs(2),
            force_fallback: false,
            fallback_cursor: Default::default(),
            #[cfg(any(test, feature = "capture-probes"))]
            frozen: false,
        }
    }
    fn open_native(&mut self, device: &ID3D11Device, context: &ID3D11DeviceContext) -> bool {
        self.retry = Instant::now();
        self.dup = Duplicator::on_device(&self.binding, device, context);
        if self.dup.is_none() {
            return false;
        }
        self.acquisitions += 1;
        self.rotation = self.binding.rotation;
        self.serial = CREATED.fetch_add(1, Ordering::Relaxed) + 1;
        // New source, new cursor-cache namespace, and no image before the first
        // valid acquisition. Fallback shape/pixels must not masquerade as DXGI.
        self.fallback = None;
        self.fallback_pixels.clear();
        true
    }
    pub fn poll(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        want_mips: bool,
    ) -> bool {
        #[cfg(any(test, feature = "capture-probes"))]
        if self.frozen && self.srv().is_some() {
            return false;
        }
        if self.last_poll.elapsed() < Duration::from_millis(1) {
            if want_mips {
                if let Some(d) = &mut self.dup {
                    d.ensure_current_mips();
                }
            }
            return false;
        }
        self.last_poll = Instant::now();
        if self.dup.is_none()
            && !self.force_fallback
            && self.retry.elapsed() >= Duration::from_millis(500)
        {
            self.open_native(device, context);
        }
        if let Some(d) = &mut self.dup {
            self.polls += 1;
            match d.grab_gpu(0, want_mips) {
                Grab::Frame { .. } => {
                    self.sequence += 1;
                    return true;
                }
                Grab::Timeout => {
                    if want_mips {
                        d.ensure_current_mips();
                    }
                    return false;
                }
                Grab::Lost => {
                    self.dup = None;
                    self.retry = Instant::now();
                }
            }
        }
        let pointer_changed = self.fallback_cursor.update();
        if self.last_fallback.elapsed() < Duration::from_millis(16) {
            if pointer_changed && self.fallback.is_some() {
                self.sequence += 1;
                return true;
            }
            return false;
        }
        self.last_fallback = Instant::now();
        // MonitorFromPoint resolves the cached physical origin without another
        // display enumeration. Do not share xcap's raw HMONITOR wrapper across
        // threads: its temporary GDI handles stay on this serialized caller.
        let Some(image) = xcap::Monitor::from_point(self.display.x + 1, self.display.y + 1)
            .ok()
            .and_then(|m| m.capture_image().ok())
        else {
            return false;
        };
        let (w, h) = (image.width(), image.height());
        let mut bytes = image.into_raw();
        for p in bytes.chunks_exact_mut(4) {
            p.swap(0, 2);
        }
        if self
            .fallback
            .as_ref()
            .is_none_or(|t| (t.width, t.height) != (w, h))
        {
            self.fallback = Texture::new(device, w, h);
            self.serial = CREATED.fetch_add(1, Ordering::Relaxed) + 1;
        }
        let changed = self.fallback_pixels != bytes || self.sequence == 0;
        if changed {
            let Some(texture) = &self.fallback else {
                return false;
            };
            if !texture.upload(context, &bytes) {
                return false;
            }
            self.fallback_pixels = bytes;
            self.sequence += 1;
            self.fallback_frames += 1;
            self.rotation = 0;
        }
        if pointer_changed && !changed && self.fallback.is_some() {
            self.sequence += 1;
            return true;
        }
        changed
    }
    pub fn srv(&self) -> Option<ID3D11ShaderResourceView> {
        self.dup
            .as_ref()
            .and_then(Duplicator::frame_srv)
            .or_else(|| self.fallback.as_ref().map(|t| t.srv.clone()))
    }
    pub fn native_size(&self) -> (u32, u32) {
        self.dup
            .as_ref()
            .map(Duplicator::native_size)
            .filter(|s| s.0 > 0 && s.1 > 0)
            .or_else(|| self.fallback.as_ref().map(|t| (t.width, t.height)))
            .unwrap_or((0, 0))
    }
    pub fn mips(&self) -> bool {
        self.dup.as_ref().is_some_and(Duplicator::mips_current)
    }
    pub fn cursor_seq(&self) -> u64 {
        (self.serial << 32)
            | self
                .dup
                .as_ref()
                .map_or(self.fallback_cursor.sequence, Duplicator::cursor_seq)
    }
    pub fn cursor(&mut self) -> Option<&CursorImage> {
        if let Some(d) = &mut self.dup {
            d.cursor_image_cached()
        } else {
            self.fallback_cursor.image(self.display.rect())
        }
    }
    pub fn readback(&mut self, max_w: u32) -> Grab {
        self.dup
            .as_mut()
            .map_or(Grab::Lost, |d| d.readback_current(max_w))
    }
    pub fn buffer(&self) -> &[u8] {
        self.dup
            .as_ref()
            .map_or(&self.fallback_pixels, Duplicator::buffer)
    }
    pub fn draw_cursor(&self, pixels: &mut [u8], w: u32, h: u32) {
        if let Some(d) = &self.dup {
            d.draw_cursor(pixels, w, h);
        }
    }
    pub fn fallback(&self) -> bool {
        self.dup.is_none() && self.fallback.is_some()
    }
}

struct Lease {
    adapter: Arc<Mutex<Adapter>>,
    id: String,
    key: AdapterKey,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut group = self.adapter.lock();
        if let Some(output) = group.outputs.get_mut(&self.id) {
            output.consumers = output.consumers.saturating_sub(1);
            if output.consumers == 0 {
                group.outputs.remove(&self.id);
            }
        }
    }
}
#[derive(Clone)]
pub(crate) struct Output {
    lease: Arc<Lease>,
}
impl Output {
    pub fn new(display: &DisplayInfo) -> Option<Self> {
        Self::new_instance(display, 0)
    }
    #[cfg(any(test, feature = "capture-probes"))]
    pub fn separate_device(display: &DisplayInfo) -> Option<Self> {
        Self::new_instance(display, display.index as u32 + 1)
    }
    fn new_instance(display: &DisplayInfo, instance: u32) -> Option<Self> {
        let binding = OutputBinding::find(display.x, display.y)?;
        let key = (binding.adapter_key.0, binding.adapter_key.1, instance);
        let adapter = {
            let mut registry = ADAPTERS.lock();
            registry.retain(|_, a| a.strong_count() > 0);
            if let Some(adapter) = registry.get(&key).and_then(Weak::upgrade) {
                adapter
            } else {
                let (device, context) = binding.create_device()?;
                let adapter = Arc::new(Mutex::new(Adapter {
                    device,
                    context,
                    outputs: HashMap::new(),
                }));
                registry.insert(key, Arc::downgrade(&adapter));
                adapter
            }
        };
        {
            let mut group = adapter.lock();
            let output = group
                .outputs
                .entry(display.id.clone())
                .or_insert_with(|| OutputState::new(display.clone(), binding.clone()));
            if output.display.rect() != display.rect()
                || output.binding.rotation != binding.rotation
            {
                let consumers = output.consumers;
                let sequence = output.sequence;
                *output = OutputState::new(display.clone(), binding);
                output.consumers = consumers;
                output.sequence = sequence;
            }
            output.consumers += 1;
        }
        Some(Self {
            lease: Arc::new(Lease {
                adapter,
                id: display.id.clone(),
                key,
            }),
        })
    }
    pub fn key(&self) -> AdapterKey {
        self.lease.key
    }
    pub fn id(&self) -> &str {
        &self.lease.id
    }
    pub fn lock(&self) -> ArcMutexGuard<RawMutex, Adapter> {
        self.lease.adapter.lock_arc()
    }
    pub fn force_fallback(&self) {
        let mut group = self.lock();
        if let Some(s) = group.outputs.get_mut(self.id()) {
            s.dup = None;
            s.force_fallback = true;
            s.sequence += 1;
        }
    }
    pub fn recover_duplication(&self) {
        let mut group = self.lock();
        if let Some(s) = group.outputs.get_mut(self.id()) {
            s.force_fallback = false;
            s.retry = Instant::now() - Duration::from_secs(1);
        }
    }
    #[cfg(any(test, feature = "capture-probes"))]
    pub fn prepare_native(&self) -> bool {
        let mut group = self.lock();
        let (device, context) = (group.device.clone(), group.context.clone());
        let Some(s) = group.outputs.get_mut(self.id()) else {
            return false;
        };
        s.force_fallback = false;
        s.open_native(&device, &context)
    }
    #[cfg(any(test, feature = "capture-probes"))]
    pub fn freeze_snapshot(&self, frozen: bool) {
        if let Some(s) = self.lock().outputs.get_mut(self.id()) {
            s.frozen = frozen;
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputStatistics {
    pub id: String,
    pub adapter: AdapterKey,
    pub device: usize,
    pub consumers: usize,
    pub acquisitions: u64,
    pub polls: u64,
    pub sequence: u64,
    pub fallback_frames: u64,
    pub cursor_key: u64,
    pub rotation: u32,
    pub valid_image: bool,
    pub source: &'static str,
}
pub(crate) fn statistics() -> Vec<OutputStatistics> {
    use windows::core::Interface;
    let adapters: Vec<_> = ADAPTERS
        .lock()
        .iter()
        .filter_map(|(k, a)| a.upgrade().map(|a| (*k, a)))
        .collect();
    adapters
        .into_iter()
        .flat_map(|(key, a)| {
            let a = a.lock();
            a.outputs
                .values()
                .map(|s| OutputStatistics {
                    id: s.display.id.clone(),
                    adapter: key,
                    device: a.device.as_raw() as usize,
                    consumers: s.consumers,
                    acquisitions: s.acquisitions,
                    polls: s.polls,
                    sequence: s.sequence,
                    fallback_frames: s.fallback_frames,
                    cursor_key: s.cursor_seq(),
                    rotation: s.rotation,
                    valid_image: s.srv().is_some(),
                    source: if s.dup.is_some() { "dxgi" } else { "gdi" },
                })
                .collect::<Vec<_>>()
        })
        .collect()
}
