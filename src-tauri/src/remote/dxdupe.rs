//! Persistent **DXGI Desktop Duplication** screen capture (Windows 8+).
//!
//! Why this exists: the previous capture path (`xcap`, GDI `BitBlt` + `GetDIBits`)
//! grabs the **entire native framebuffer on every frame** and copies it to system
//! RAM — a fixed, single-threaded, memory-bandwidth-bound cost that is the same at
//! every streamed resolution (we downscale *after*). That made capture the frame-rate
//! ceiling while no CPU core was saturated.
//!
//! Desktop Duplication keeps a **persistent GPU capture session**: the compositor
//! hands us each new frame as a GPU texture, we DMA just that texture to a staging
//! surface and map it. Crucially it only produces a frame **when the screen actually
//! changes** (and reports cursor-only updates separately, which we skip), so a static
//! desktop costs almost nothing and real changes arrive with minimal latency.
//!
//! Falls back to the caller's GDI path if init fails (e.g. an exclusive-fullscreen
//! game blocks duplication, or a display driver quirk).

#![cfg(windows)]

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11ShaderResourceView,
    ID3D11Texture2D, D3D11_BIND_FLAG, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_FORMAT_SUPPORT_MIP_AUTOGEN,
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_RESOURCE_MISC_FLAG,
    D3D11_RESOURCE_MISC_GENERATE_MIPS, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    DXGI_OUTDUPL_POINTER_SHAPE_INFO,
};

// DXGI_OUTDUPL_POINTER_SHAPE_TYPE values (the windows crate exposes them as consts
// of a wrapper type; we store the raw u32 for simple matching).
const PTR_MONOCHROME: u32 = 1;
const PTR_COLOR: u32 = 2;
const PTR_MASKED_COLOR: u32 = 4;

/// The result of trying to grab one frame from the duplication session.
pub enum Grab {
    /// A fresh frame is ready in the duplicator's reusable readback buffer (read via
    /// [`Duplicator::buffer`]), already **GPU-downscaled** toward the requested width.
    /// `w`/`h` are the readback dimensions; `native_w`/`native_h` are the true monitor
    /// resolution (for telemetry — the phone shows "native → out").
    Frame { w: u32, h: u32, native_w: u32, native_h: u32 },
    /// No new desktop content within the timeout (or cursor-only change) — reuse last.
    Timeout,
    /// The session was lost (mode change / desktop switch) — recreate the `Duplicator`.
    Lost,
}

pub struct Duplicator {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    dup: IDXGIOutputDuplication,
    /// Staging texture (CPU-readable) sized to the current readback dimensions.
    staging: Option<ID3D11Texture2D>,
    stg_w: u32,
    stg_h: u32,
    /// Full-size mip-chain texture used to downscale on the GPU (`GenerateMips`),
    /// plus its SRV; recreated when the monitor resolution changes.
    mip_tex: Option<ID3D11Texture2D>,
    mip_srv: Option<ID3D11ShaderResourceView>,
    mip_w: u32,
    mip_h: u32,
    /// Whether BGRA supports GPU mip auto-generation on this device (checked once).
    /// When false we fall back to a full-resolution readback + CPU downscale.
    gpu_scale: bool,
    /// Reusable CPU-side readback buffer — avoids allocating (and zeroing) a
    /// full-frame Vec every grab (a 4K BGRA frame is ~33 MB).
    readback: Vec<u8>,
    /// Virtual-desktop top-left of the output we're duplicating (for re-matching).
    pub origin: (i32, i32),
    // ---- live hardware-cursor state (mirrored from AcquireNextFrame info) ----
    // Desktop Duplication frames do NOT include the mouse pointer; it arrives as
    // separate position + shape metadata. We keep the latest of each so
    // `draw_cursor` can composite the real system cursor into every outgoing
    // frame — the remote user then always sees where the PC cursor actually is,
    // even when the link lags behind their own stylized touch cursor.
    ptr_visible: bool,
    ptr_x: i32,
    ptr_y: i32,
    ptr_shape: Vec<u8>,
    ptr_type: u32,
    ptr_w: u32,
    ptr_h: u32,
    ptr_pitch: u32,
    /// Native dims of the last grabbed frame (scales cursor coords to the stream).
    last_native: (u32, u32),
}

impl Duplicator {
    /// Build a duplication session for the output whose top-left desktop coordinate
    /// matches `(target_x, target_y)`; falls back to the first output otherwise.
    pub fn new_for(target_x: i32, target_y: i32) -> Option<Self> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;

            let mut chosen: Option<(IDXGIAdapter, IDXGIOutput1, (i32, i32))> = None;
            let mut first: Option<(IDXGIAdapter, IDXGIOutput1, (i32, i32))> = None;

            let mut ai = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(ai) {
                ai += 1;
                let adapter: IDXGIAdapter = adapter.cast().ok()?;
                let mut oi = 0u32;
                loop {
                    let Ok(output) = adapter.EnumOutputs(oi) else { break };
                    oi += 1;
                    let Ok(desc) = output.GetDesc() else { continue };
                    let Ok(o1) = output.cast::<IDXGIOutput1>() else { continue };
                    let r = desc.DesktopCoordinates;
                    let origin = (r.left, r.top);
                    if first.is_none() {
                        first = Some((adapter.clone(), o1.clone(), origin));
                    }
                    if r.left == target_x && r.top == target_y {
                        chosen = Some((adapter.clone(), o1, origin));
                        break;
                    }
                }
                if chosen.is_some() {
                    break;
                }
            }

            let (adapter, output1, origin) = chosen.or(first)?;

            // A device on the SAME adapter as the output is required for duplication.
            let feature_levels = [
                D3D_FEATURE_LEVEL_11_1,
                D3D_FEATURE_LEVEL_11_0,
                D3D_FEATURE_LEVEL_10_1,
                D3D_FEATURE_LEVEL_10_0,
            ];
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let mut level = D3D_FEATURE_LEVEL::default();
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&feature_levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut level),
                Some(&mut context),
            )
            .ok()?;
            let device = device?;
            let context = context?;

            let dup = output1.DuplicateOutput(&device).ok()?;

            // GPU downscale needs the swap-chain format (BGRA8) to support mip
            // auto-generation; if a driver doesn't, we quietly use the full-res path.
            let gpu_scale = device
                .CheckFormatSupport(DXGI_FORMAT_B8G8R8A8_UNORM)
                .map(|s| (s & D3D11_FORMAT_SUPPORT_MIP_AUTOGEN.0 as u32) != 0)
                .unwrap_or(false);

            Some(Self {
                device,
                context,
                dup,
                staging: None,
                stg_w: 0,
                stg_h: 0,
                mip_tex: None,
                mip_srv: None,
                mip_w: 0,
                mip_h: 0,
                gpu_scale,
                readback: Vec::new(),
                origin,
                ptr_visible: false,
                ptr_x: 0,
                ptr_y: 0,
                ptr_shape: Vec::new(),
                ptr_type: 0,
                ptr_w: 0,
                ptr_h: 0,
                ptr_pitch: 0,
                last_native: (0, 0),
            })
        }
    }

    fn ensure_staging(&mut self, w: u32, h: u32) -> Option<()> {
        if self.staging.is_some() && self.stg_w == w && self.stg_h == h {
            return Some(());
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: D3D11_BIND_FLAG(0).0 as u32,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: D3D11_RESOURCE_MISC_FLAG(0).0 as u32,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)).ok()? };
        self.staging = tex;
        self.stg_w = w;
        self.stg_h = h;
        Some(())
    }

    /// Ensure the full-size mip-chain texture (+ its SRV) used for GPU downscaling
    /// exists at `w×h`. Created with render-target + shader-resource binds and the
    /// auto-mip misc flag, which `GenerateMips` requires.
    fn ensure_mip(&mut self, w: u32, h: u32) -> Option<()> {
        if self.mip_tex.is_some() && self.mip_w == w && self.mip_h == h {
            return Some(());
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 0, // 0 = full chain: log2(max(w,h)) + 1 levels
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)).ok()? };
        let tex = tex?;
        let mut srv: Option<ID3D11ShaderResourceView> = None;
        unsafe { self.device.CreateShaderResourceView(&tex, None, Some(&mut srv)).ok()? };
        self.mip_srv = srv;
        self.mip_tex = Some(tex);
        self.mip_w = w;
        self.mip_h = h;
        Some(())
    }

    /// Map the staging texture and copy its `w×h` BGRA into the reusable readback
    /// buffer — one bulk memcpy when the driver's row pitch is already tight.
    unsafe fn map_readback(&mut self, staging_res: &ID3D11Resource, w: u32, h: u32) -> Option<()> {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        self.context.Map(staging_res, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).ok()?;
        let row = (w * 4) as usize;
        let pitch = mapped.RowPitch as usize;
        let need = row * h as usize;
        if self.readback.len() != need {
            self.readback.resize(need, 0);
        }
        let sp = mapped.pData as *const u8;
        let dp = self.readback.as_mut_ptr();
        if pitch == row {
            std::ptr::copy_nonoverlapping(sp, dp, need);
        } else {
            for y in 0..h as usize {
                std::ptr::copy_nonoverlapping(sp.add(y * pitch), dp.add(y * row), row);
            }
        }
        self.context.Unmap(staging_res, 0);
        Some(())
    }

    /// Full-resolution readback (no GPU scale): copy the frame to staging and map.
    unsafe fn readback_full(&mut self, src: &ID3D11Resource, w: u32, h: u32) -> Option<()> {
        self.ensure_staging(w, h)?;
        let staging = self.staging.clone()?;
        let dst: ID3D11Resource = staging.cast().ok()?;
        self.context.CopyResource(&dst, src);
        self.map_readback(&dst, w, h)
    }

    /// BGRA bytes of the most recent successful `grab` (at the readback dimensions).
    pub fn buffer(&self) -> &[u8] {
        &self.readback
    }

    /// Grab the next frame, blocking up to `timeout_ms` for new content, and read it
    /// into `self.readback` — **downscaled on the GPU** toward `max_w` when that helps
    /// (mip generation), so the CPU copies + resizes a far smaller image.
    pub fn grab(&mut self, timeout_ms: u32, max_w: u32) -> Grab {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            match self.dup.AcquireNextFrame(timeout_ms, &mut info, &mut resource) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Grab::Timeout,
                Err(_) => return Grab::Lost,
            }

            // Mirror the hardware-cursor metadata (position/visibility valid only on
            // frames where the mouse updated; shape only when it changed).
            let mouse_updated = info.LastMouseUpdateTime != 0;
            if mouse_updated {
                self.ptr_visible = info.PointerPosition.Visible.as_bool();
                if self.ptr_visible {
                    self.ptr_x = info.PointerPosition.Position.x;
                    self.ptr_y = info.PointerPosition.Position.y;
                }
            }
            if info.PointerShapeBufferSize > 0 {
                let mut buf = vec![0u8; info.PointerShapeBufferSize as usize];
                let mut required = 0u32;
                let mut sinfo = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
                if self
                    .dup
                    .GetFramePointerShape(buf.len() as u32, buf.as_mut_ptr() as *mut _, &mut required, &mut sinfo)
                    .is_ok()
                {
                    self.ptr_shape = buf;
                    self.ptr_type = sinfo.Type;
                    self.ptr_w = sinfo.Width;
                    self.ptr_h = sinfo.Height;
                    self.ptr_pitch = sinfo.Pitch;
                }
            }

            // New desktop pixels (LastPresentTime != 0) OR a cursor move both produce
            // a frame: the texture always holds the CURRENT desktop, and cursor moves
            // must reach the stream now that the real pointer is composited in
            // (before cursor compositing, cursor-only updates were skipped as a pure
            // CPU saving — that would freeze the visible pointer on a static screen).
            let has_new = info.LastPresentTime != 0;
            let res = resource;
            let out = (|| {
                let res = res.as_ref()?;
                if !has_new && !mouse_updated {
                    return None;
                }
                let tex: ID3D11Texture2D = res.cast().ok()?;
                let mut td = D3D11_TEXTURE2D_DESC::default();
                tex.GetDesc(&mut td);
                let (nw, nh) = (td.Width, td.Height);
                self.last_native = (nw, nh);
                let src: ID3D11Resource = tex.cast().ok()?;

                // Largest mip level still >= max_w wide, so the CPU only does a small
                // final resize to the exact target (never an upscale).
                let mut level = 0u32;
                if self.gpu_scale && max_w > 0 && nw > max_w {
                    while (nw >> (level + 1)) >= max_w && (nh >> (level + 1)) >= 1 {
                        level += 1;
                    }
                }

                if level > 0 && self.ensure_mip(nw, nh).is_some() {
                    if let Some(mip) = self.mip_tex.clone() {
                        let mip_res: ID3D11Resource = mip.cast().ok()?;
                        // Full frame -> mip 0, then generate the chain on the GPU.
                        self.context.CopySubresourceRegion(&mip_res, 0, 0, 0, 0, &src, 0, None);
                        if let Some(srv) = self.mip_srv.clone() {
                            self.context.GenerateMips(&srv);
                        }
                        let (mw, mh) = ((nw >> level).max(1), (nh >> level).max(1));
                        self.ensure_staging(mw, mh)?;
                        let staging = self.staging.clone()?;
                        let dst: ID3D11Resource = staging.cast().ok()?;
                        // Read back only the small chosen mip level.
                        self.context.CopySubresourceRegion(&dst, 0, 0, 0, 0, &mip_res, level, None);
                        self.map_readback(&dst, mw, mh)?;
                        return Some(Grab::Frame { w: mw, h: mh, native_w: nw, native_h: nh });
                    }
                }

                // No GPU downscale (target too large, unsupported, or a create failed).
                self.readback_full(&src, nw, nh)?;
                Some(Grab::Frame { w: nw, h: nh, native_w: nw, native_h: nh })
            })();

            let _ = self.dup.ReleaseFrame();
            out.unwrap_or(Grab::Timeout)
        }
    }

    /// Composite the current hardware cursor into `buf` — a packed **BGRA** image
    /// of this monitor at `bw × bh` (the final scaled stream frame). Nearest-scales
    /// the shape by the same ratio as the frame so the cursor stays proportionate
    /// at any stream resolution. Handles all three DXGI shape types: color
    /// (per-pixel alpha), monochrome (AND/XOR bit masks, the classic arrow/I-beam),
    /// and masked color (alpha byte 0 = opaque, 0xFF = XOR with screen).
    pub fn draw_cursor(&self, buf: &mut [u8], bw: u32, bh: u32) {
        if !self.ptr_visible || self.ptr_shape.is_empty() || bw == 0 || bh == 0 {
            return;
        }
        let (nw, nh) = self.last_native;
        if nw == 0 || nh == 0 {
            return;
        }
        let mono = self.ptr_type == PTR_MONOCHROME;
        let shape_w = self.ptr_w;
        let shape_h = if mono { self.ptr_h / 2 } else { self.ptr_h };
        if shape_w == 0 || shape_h == 0 {
            return;
        }
        let pitch = self.ptr_pitch as usize;
        // Destination rect: cursor position and size scaled from native to stream.
        let dx0 = (self.ptr_x as i64 * bw as i64 / nw as i64) as i32;
        let dy0 = (self.ptr_y as i64 * bh as i64 / nh as i64) as i32;
        let dw = ((shape_w as u64 * bw as u64).div_ceil(nw as u64)).max(1) as i32;
        let dh = ((shape_h as u64 * bh as u64).div_ceil(nh as u64)).max(1) as i32;

        for dy in 0..dh {
            let ty = dy0 + dy;
            if ty < 0 || ty >= bh as i32 {
                continue;
            }
            let sy = ((dy as u32 * shape_h) / dh as u32).min(shape_h - 1) as usize;
            for dx in 0..dw {
                let tx = dx0 + dx;
                if tx < 0 || tx >= bw as i32 {
                    continue;
                }
                let sx = ((dx as u32 * shape_w) / dw as u32).min(shape_w - 1) as usize;
                let di = (ty as usize * bw as usize + tx as usize) * 4;
                if di + 3 >= buf.len() {
                    continue;
                }
                match self.ptr_type {
                    PTR_COLOR => {
                        let si = sy * pitch + sx * 4;
                        let Some(px) = self.ptr_shape.get(si..si + 4) else { continue };
                        let a = px[3] as u32;
                        if a == 0 {
                            continue;
                        }
                        for c in 0..3 {
                            let s = px[c] as u32;
                            let d = buf[di + c] as u32;
                            buf[di + c] = ((s * a + d * (255 - a)) / 255) as u8;
                        }
                    }
                    PTR_MONOCHROME => {
                        // 1bpp, AND mask rows then XOR mask rows (stacked).
                        let byte = sx / 8;
                        let bit = 7 - (sx % 8);
                        let and_i = sy * pitch + byte;
                        let xor_i = (sy + shape_h as usize) * pitch + byte;
                        let (Some(&ab), Some(&xb)) = (self.ptr_shape.get(and_i), self.ptr_shape.get(xor_i)) else {
                            continue;
                        };
                        let and = (ab >> bit) & 1;
                        let xor = (xb >> bit) & 1;
                        if and == 0 {
                            let v = if xor == 1 { 0xFF } else { 0x00 };
                            buf[di] = v;
                            buf[di + 1] = v;
                            buf[di + 2] = v;
                        } else if xor == 1 {
                            buf[di] = !buf[di];
                            buf[di + 1] = !buf[di + 1];
                            buf[di + 2] = !buf[di + 2];
                        }
                        // and==1 && xor==0 → transparent.
                    }
                    PTR_MASKED_COLOR => {
                        let si = sy * pitch + sx * 4;
                        let Some(px) = self.ptr_shape.get(si..si + 4) else { continue };
                        if px[3] == 0 {
                            buf[di] = px[0];
                            buf[di + 1] = px[1];
                            buf[di + 2] = px[2];
                        } else {
                            buf[di] ^= px[0];
                            buf[di + 1] ^= px[1];
                            buf[di + 2] ^= px[2];
                        }
                    }
                    _ => return,
                }
            }
        }
    }
}
