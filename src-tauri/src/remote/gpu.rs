//! GPU scale + cursor compositing for the zero-copy capture path.
//!
//! ## Why
//! Even with NVENC doing the encoding, the pipeline still read every frame back to
//! system RAM (`Grab::Frame` → staging → `Map`) just so the CPU could downscale it and
//! paint the cursor on. That readback is the "capture ~7 ms" in the HUD, and it exists
//! only because Desktop Duplication delivers the pointer as *metadata* rather than
//! baked into the frame — so something had to composite it.
//!
//! This does both jobs on the GPU in **one full-screen pass**: the pixel shader samples
//! the duplication texture (the sampler does the downscale, trilinear off the mip chain
//! `grab_gpu` generated) and composites the cursor in the same fetch. The frame never
//! leaves VRAM — duplication texture → this → NVENC.
//!
//! ## Cursor semantics
//! DXGI has three shape types but only two *operations*, because monochrome collapses
//! onto masked-colour (see [`super::dxdupe::CursorImage`]). The 1bpp unpacking happens
//! once per shape change on the CPU; the shader only ever sees BGRA + a `masked` flag:
//!   * `masked = 0` → straight per-pixel alpha blend.
//!   * `masked = 1` → alpha 0 = replace, alpha 255 = XOR into the screen (this is the
//!     inverting I-beam over dark text; a plain alpha blend cannot express it, which is
//!     why the composite has to read the screen value rather than use blend state).
//!
//! ## Shaders
//! Compiled at runtime with `D3DCompile` (`d3dcompiler_47.dll` ships with Windows, so
//! there's no build-time dependency and the repo stays turnkey). Any failure here
//! returns `None` and the caller keeps the CPU path — this is an optimisation, never a
//! requirement.

#![cfg(windows)]

use windows::core::{s, Interface, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{ID3DBlob, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Buffer, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11RenderTargetView,
    ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader, D3D11_BIND_CONSTANT_BUFFER,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BUFFER_DESC, D3D11_COMPARISON_NEVER,
    D3D11_CPU_ACCESS_WRITE, D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_FILTER_MIN_MAG_MIP_POINT, D3D11_MAP_WRITE_DISCARD,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SAMPLER_DESC, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_USAGE_DYNAMIC, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

use super::dxdupe::CursorImage;

/// One full-screen triangle (no vertex buffer — positions come from `SV_VertexID`),
/// then sample + composite. `cur` is in normalized output coords so the shader needs no
/// resolution maths.
const SHADER_HLSL: &str = r#"
cbuffer Params : register(b0) {
    float4 curRect;   // xy = top-left, zw = size, in [0,1] output space
    uint   curOn;     // 0 = no cursor this frame
    uint   curMasked; // 0 = alpha blend, 1 = masked (alpha 0 replace / 255 XOR)
    float2 _pad;
    float4 srcInfo;   // x = mip level, y = 1 area filter / 0 plain sample, zw = tap offset (UV)
};

Texture2D    srcTex : register(t0);
SamplerState srcSmp : register(s0);
Texture2D    curTex : register(t1);
SamplerState curSmp : register(s1);

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

VSOut vs(uint id : SV_VertexID) {
    VSOut o;
    // Oversized triangle covering the viewport: (0,0) (2,0) (0,2) in UV.
    o.uv  = float2((id << 1) & 2, id & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}

// Downscale read. Area filter: four bilinear taps from mip level L (the largest
// level still >= the output size), spaced by the leftover ratio rr = r / 2^L in
// [1,2). At an exact power-of-two ratio the taps coincide on texel centres and
// this is exactly the mip's box filter (4K -> 1080p is unchanged); in between it
// stays sharp where trilinear would blend in the next, 2x-blurrier level.
float3 sampleSrc(float2 uv) {
    if (srcInfo.y < 0.5) return srcTex.Sample(srcSmp, uv).rgb;
    float2 o = srcInfo.zw;
    float lod = srcInfo.x;
    float3 c = srcTex.SampleLevel(srcSmp, uv + float2(-o.x, -o.y), lod).rgb;
    c += srcTex.SampleLevel(srcSmp, uv + float2( o.x, -o.y), lod).rgb;
    c += srcTex.SampleLevel(srcSmp, uv + float2(-o.x,  o.y), lod).rgb;
    c += srcTex.SampleLevel(srcSmp, uv + float2( o.x,  o.y), lod).rgb;
    return c * 0.25;
}

float4 ps(VSOut i) : SV_TARGET {
    float3 col = sampleSrc(i.uv);
    if (curOn != 0) {
        float2 c = (i.uv - curRect.xy) / max(curRect.zw, 1e-6);
        if (all(c >= 0.0) && all(c <= 1.0)) {
            float4 s = curTex.Sample(curSmp, c);
            if (curMasked == 0) {
                col = lerp(col, s.rgb, s.a);
            } else if (s.a < 0.5) {
                col = s.rgb;                  // opaque
            } else {
                // XOR against the screen. Needs the 8-bit integers back, so round-trip
                // through uint — float ops can't express a bitwise invert.
                uint3 d = (uint3)(saturate(col) * 255.0 + 0.5);
                uint3 m = (uint3)(saturate(s.rgb) * 255.0 + 0.5);
                col = (float3)(d ^ m) / 255.0;
            }
        }
    }
    return float4(col, 1.0);
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Params {
    cur_rect: [f32; 4],
    cur_on: u32,
    cur_masked: u32,
    _pad: [f32; 2],
    /// x = mip level, y = 1 area filter / 0 plain sample, zw = tap offset (UV).
    src_info: [f32; 4],
}

/// How to read the source for a `native → out` downscale (see the shader's
/// `sampleSrc`). Returns `[level, mode, offset_u, offset_v]`.
///
/// `mips` says whether the source's mip chain is current. Without it only level 0
/// may be read, so ratios >= 2 fall back to level 0 (still filtered, just wider).
pub(crate) fn downscale_params(native_w: u32, native_h: u32, out_w: u32, out_h: u32, mips: bool) -> [f32; 4] {
    if native_w == 0 || native_h == 0 || out_w == 0 || out_h == 0 {
        return [0.0, 0.0, 0.0, 0.0];
    }
    let r = (native_w as f32 / out_w as f32).max(native_h as f32 / out_h as f32);
    if r <= 1.001 {
        return [0.0, 0.0, 0.0, 0.0]; // no downscale: plain level-0 sample
    }
    let level = if mips { r.log2().floor().max(0.0) } else { 0.0 };
    let rr = r / 2f32.powf(level); // leftover ratio at that level, in [1, 2) with mips
    // Tap half-spread in level-L texels, tuned against a Lanczos3 reference on a
    // text-like card (`area_filter_beats_trilinear`). Level 0 (ratios < 2): the tight
    // (rr-1)/2 keeps glyph edges crisp (+3.8..+5.5 dB over trilinear). Level >= 1: the
    // mip's 2x2 box pre-filter passes more near-Nyquist energy, so spread wider —
    // min((rr-0.5)/2, 1.5(rr-1)) is continuous and reduces to the plain mip box at
    // exact powers of two (4K -> 1080p unchanged). Never worse than trilinear.
    let half = if level < 0.5 {
        ((rr - 1.0) * 0.5).max(0.0)
    } else {
        ((rr - 0.5) * 0.5).min(1.5 * (rr - 1.0)).max(0.0)
    };
    let d = half * 2f32.powf(level);
    [level, 1.0, d / native_w as f32, d / native_h as f32]
}

fn compile(entry: PCSTR, target: PCSTR) -> Option<ID3DBlob> {
    unsafe {
        let mut code: Option<ID3DBlob> = None;
        let mut err: Option<ID3DBlob> = None;
        let r = D3DCompile(
            SHADER_HLSL.as_ptr() as *const _,
            SHADER_HLSL.len(),
            None,
            None,
            None,
            entry,
            target,
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut err),
        );
        if r.is_err() {
            if let Some(e) = err {
                let msg = std::slice::from_raw_parts(e.GetBufferPointer() as *const u8, e.GetBufferSize());
                eprintln!("[gpu] shader compile failed: {}", String::from_utf8_lossy(msg));
            }
            return None;
        }
        code
    }
}

/// Scales the duplication frame to the stream size and composites the cursor, all on
/// the GPU, into a texture NVENC can encode directly.
pub struct Compositor {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    cb: ID3D11Buffer,
    smp_linear: ID3D11SamplerState,
    /// Bilinear clamped to level 0: used whenever the source's mip chain is not
    /// current (no downscale this frame, or mips not generated). A trilinear read
    /// there could blend in a stale level.
    smp_linear_l0: ID3D11SamplerState,
    smp_point: ID3D11SamplerState,
    /// Render target + NVENC input. BGRA8, exactly the stream size.
    out_tex: ID3D11Texture2D,
    out_rtv: ID3D11RenderTargetView,
    w: u32,
    h: u32,
    /// Cursor shape texture, re-uploaded only when the shape id changes.
    cur_tex: Option<ID3D11Texture2D>,
    cur_srv: Option<ID3D11ShaderResourceView>,
    cur_seq: u64,
    cur_w: u32,
    cur_h: u32,
    cur_masked: bool,
    /// Set once a shape has actually been uploaded (seq 0 is a valid "no shape yet").
    cur_ready: bool,
}

impl Compositor {
    /// Build for `w × h` output on `device` (must be the duplicator's device).
    pub fn new(device: &ID3D11Device, context: &ID3D11DeviceContext, w: u32, h: u32) -> Option<Self> {
        unsafe {
            let vs_blob = compile(s!("vs"), s!("vs_4_0"))?;
            let ps_blob = compile(s!("ps"), s!("ps_4_0"))?;
            let vs_code = std::slice::from_raw_parts(vs_blob.GetBufferPointer() as *const u8, vs_blob.GetBufferSize());
            let ps_code = std::slice::from_raw_parts(ps_blob.GetBufferPointer() as *const u8, ps_blob.GetBufferSize());
            let mut vs = None;
            device.CreateVertexShader(vs_code, None, Some(&mut vs)).ok()?;
            let mut ps = None;
            device.CreatePixelShader(ps_code, None, Some(&mut ps)).ok()?;

            let cb_desc = D3D11_BUFFER_DESC {
                ByteWidth: std::mem::size_of::<Params>() as u32,
                Usage: D3D11_USAGE_DYNAMIC,
                BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                CPUAccessFlags: D3D11_CPU_ACCESS_WRITE.0 as u32,
                ..Default::default()
            };
            let mut cb = None;
            device.CreateBuffer(&cb_desc, None, Some(&mut cb)).ok()?;

            let mk_sampler = |filter, max_lod: f32| {
                let d = D3D11_SAMPLER_DESC {
                    Filter: filter,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    ComparisonFunc: D3D11_COMPARISON_NEVER,
                    MaxLOD: max_lod,
                    ..Default::default()
                };
                let mut s = None;
                device.CreateSamplerState(&d, Some(&mut s)).ok()?;
                s
            };
            let smp_linear = mk_sampler(D3D11_FILTER_MIN_MAG_MIP_LINEAR, f32::MAX)?;
            let smp_linear_l0 = mk_sampler(D3D11_FILTER_MIN_MAG_MIP_LINEAR, 0.0)?;
            // Point-sample the cursor: it's tiny and already the right shape; bilinear
            // would smear its 1px edges (and the XOR mask must stay exactly 0 or 255).
            let smp_point = mk_sampler(D3D11_FILTER_MIN_MAG_MIP_POINT, f32::MAX)?;

            let (out_tex, out_rtv) = Self::make_target(device, w, h)?;
            Some(Compositor {
                device: device.clone(),
                context: context.clone(),
                vs: vs?,
                ps: ps?,
                cb: cb?,
                smp_linear,
                smp_linear_l0,
                smp_point,
                out_tex,
                out_rtv,
                w,
                h,
                cur_tex: None,
                cur_srv: None,
                cur_seq: u64::MAX,
                cur_w: 0,
                cur_h: 0,
                cur_masked: false,
                cur_ready: false,
            })
        }
    }

    fn make_target(device: &ID3D11Device, w: u32, h: u32) -> Option<(ID3D11Texture2D, ID3D11RenderTargetView)> {
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                ..Default::default()
            };
            let mut tex = None;
            device.CreateTexture2D(&desc, None, Some(&mut tex)).ok()?;
            let tex = tex?;
            let mut rtv = None;
            device.CreateRenderTargetView(&tex, None, Some(&mut rtv)).ok()?;
            Some((tex, rtv?))
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.w, self.h)
    }

    /// The composited frame. Hand this straight to NVENC.
    pub fn output(&self) -> &ID3D11Texture2D {
        &self.out_tex
    }

    /// Re-upload the cursor shape if it changed. Cheap no-op while the shape is stable
    /// (which is almost always — the pointer moves far more often than it morphs).
    fn sync_cursor(&mut self, img: &CursorImage, seq: u64) -> bool {
        if self.cur_ready && self.cur_seq == seq && self.cur_w == img.w && self.cur_h == img.h {
            return true;
        }
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: img.w,
                Height: img.h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                ..Default::default()
            };
            let init = D3D11_SUBRESOURCE_DATA {
                pSysMem: img.px.as_ptr() as *const _,
                SysMemPitch: img.w * 4,
                SysMemSlicePitch: 0,
            };
            let mut tex = None;
            if self.device.CreateTexture2D(&desc, Some(&init), Some(&mut tex)).is_err() {
                return false;
            }
            let Some(tex) = tex else { return false };
            let mut srv = None;
            if self.device.CreateShaderResourceView(&tex, None, Some(&mut srv)).is_err() {
                return false;
            }
            self.cur_tex = Some(tex);
            self.cur_srv = srv;
            self.cur_seq = seq;
            self.cur_w = img.w;
            self.cur_h = img.h;
            self.cur_masked = img.masked;
            self.cur_ready = true;
            true
        }
    }

    /// Scale `src` (the duplication frame, `native_w × native_h`) into the output and
    /// composite `cursor` if there is one. `src_mips` says whether `src`'s mip chain
    /// is current; when it isn't, sampling is clamped to level 0. Returns false if the
    /// GPU work couldn't be issued — caller should fall back rather than encode a
    /// stale/blank target.
    pub fn render(
        &mut self,
        src: &ID3D11ShaderResourceView,
        native_w: u32,
        native_h: u32,
        src_mips: bool,
        cursor: Option<(&CursorImage, u64)>,
    ) -> bool {
        let info = downscale_params(native_w, native_h, self.w, self.h, src_mips);
        self.render_with(src, native_w, native_h, src_mips, cursor, info)
    }

    /// `render` with explicit source-sampling parameters (see `downscale_params`);
    /// `[_, 0.0, _, _]` is the plain (trilinear when `src_mips`) read.
    fn render_with(
        &mut self,
        src: &ID3D11ShaderResourceView,
        native_w: u32,
        native_h: u32,
        src_mips: bool,
        cursor: Option<(&CursorImage, u64)>,
        src_info: [f32; 4],
    ) -> bool {
        if native_w == 0 || native_h == 0 {
            return false;
        }
        let mut p = Params::default();
        p.src_info = src_info;
        if let Some((img, seq)) = cursor {
            if self.sync_cursor(img, seq) {
                // Cursor rect in normalized OUTPUT space. Working in normalized coords
                // means the shape scales with the stream exactly as the CPU path's
                // native→stream ratio did, at any resolution.
                p.cur_rect = [
                    img.x as f32 / native_w as f32,
                    img.y as f32 / native_h as f32,
                    img.w as f32 / native_w as f32,
                    img.h as f32 / native_h as f32,
                ];
                p.cur_on = 1;
                p.cur_masked = if self.cur_masked { 1 } else { 0 };
            }
        }
        unsafe {
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            let cb_res: windows::Win32::Graphics::Direct3D11::ID3D11Resource = match self.cb.cast() {
                Ok(r) => r,
                Err(_) => return false,
            };
            if self.context.Map(&cb_res, 0, D3D11_MAP_WRITE_DISCARD, 0, Some(&mut mapped)).is_err() {
                return false;
            }
            std::ptr::copy_nonoverlapping(&p as *const Params as *const u8, mapped.pData as *mut u8, std::mem::size_of::<Params>());
            self.context.Unmap(&cb_res, 0);

            let vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.w as f32,
                Height: self.h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.context.RSSetViewports(Some(&[vp]));
            self.context.OMSetRenderTargets(Some(&[Some(self.out_rtv.clone())]), None);
            self.context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.VSSetShader(&self.vs, None);
            self.context.PSSetShader(&self.ps, None);
            self.context.PSSetConstantBuffers(0, Some(&[Some(self.cb.clone())]));
            self.context
                .PSSetShaderResources(0, Some(&[Some(src.clone()), self.cur_srv.clone()]));
            // The area filter picks its level explicitly (SampleLevel), so it uses the
            // full-chain sampler; a plain sample without current mips stays on level 0.
            let src_smp = if src_mips || p.src_info[1] > 0.5 { &self.smp_linear } else { &self.smp_linear_l0 };
            self.context
                .PSSetSamplers(0, Some(&[Some(src_smp.clone()), Some(self.smp_point.clone())]));
            self.context.Draw(3, 0);
            // Unbind the SRVs: the duplication texture is about to be written again by
            // the next CopySubresourceRegion, and D3D11 will noisily drop that copy if
            // the resource is still bound for read.
            self.context.PSSetShaderResources(0, Some(&[None, None]));
            self.context.OMSetRenderTargets(None, None);
        }
        true
    }
}

// Safety: a Compositor owns its D3D11 objects and lives entirely on the capture thread
// (it is created and used there, never shared). Deliberately not Sync.
unsafe impl Send for Compositor {}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
        D3D11_SDK_VERSION, D3D11_USAGE_STAGING,
    };

    struct Ctx {
        device: ID3D11Device,
        context: ID3D11DeviceContext,
    }

    fn ctx() -> Option<Ctx> {
        unsafe {
            let mut device = None;
            D3D11CreateDevice(
                None::<&windows::Win32::Graphics::Dxgi::IDXGIAdapter>,
                D3D_DRIVER_TYPE_HARDWARE,
                windows::Win32::Foundation::HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
            .ok()?;
            let device = device?;
            let context = device.GetImmediateContext().ok()?;
            Some(Ctx { device, context })
        }
    }

    /// A solid-colour BGRA source texture + SRV.
    fn solid_src(c: &Ctx, w: u32, h: u32, bgra: [u8; 4]) -> (ID3D11Texture2D, ID3D11ShaderResourceView) {
        let px: Vec<u8> = bgra.iter().copied().cycle().take((w * h * 4) as usize).collect();
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                ..Default::default()
            };
            let init = D3D11_SUBRESOURCE_DATA {
                pSysMem: px.as_ptr() as *const _,
                SysMemPitch: w * 4,
                SysMemSlicePitch: 0,
            };
            let mut tex = None;
            c.device.CreateTexture2D(&desc, Some(&init), Some(&mut tex)).unwrap();
            let tex = tex.unwrap();
            let mut srv = None;
            c.device.CreateShaderResourceView(&tex, None, Some(&mut srv)).unwrap();
            (tex, srv.unwrap())
        }
    }

    /// Read one pixel back from the compositor output.
    fn read_px(c: &Ctx, tex: &ID3D11Texture2D, w: u32, h: u32, x: u32, y: u32) -> [u8; 4] {
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..Default::default()
            };
            let mut stg = None;
            c.device.CreateTexture2D(&desc, None, Some(&mut stg)).unwrap();
            let stg = stg.unwrap();
            let dst: windows::Win32::Graphics::Direct3D11::ID3D11Resource = stg.cast().unwrap();
            let src: windows::Win32::Graphics::Direct3D11::ID3D11Resource = tex.cast().unwrap();
            c.context.CopyResource(&dst, &src);
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            c.context.Map(&dst, 0, D3D11_MAP_READ, 0, Some(&mut m)).unwrap();
            let row = (m.pData as *const u8).add((y * m.RowPitch + x * 4) as usize);
            let out = [*row, *row.add(1), *row.add(2), *row.add(3)];
            c.context.Unmap(&dst, 0);
            out
        }
    }

    #[test]
    fn downscale_params_pick_the_right_level_and_footprint() {
        // No downscale ⇒ plain sample.
        assert_eq!(downscale_params(1920, 1080, 1920, 1080, true)[1], 0.0);
        // Exact 2× (4K → 1080p): level 1, taps coincide (pure mip box filter).
        let p = downscale_params(3840, 2160, 1920, 1080, true);
        assert_eq!((p[0], p[1]), (1.0, 1.0));
        assert!(p[2].abs() < 1e-9 && p[3].abs() < 1e-9);
        // 1440p → 1080p (1.333×): level 0, taps ±(0.333/2) px.
        let p = downscale_params(2560, 1440, 1920, 1080, false);
        assert_eq!(p[0], 0.0);
        assert!((p[2] * 2560.0 - 0.1667).abs() < 1e-3, "{p:?}");
        // 4K → 1600 (2.4×) with mips: level 1, leftover 1.2 ⇒ min(0.35, 0.3) = 0.3
        // level-1 texels = ±0.6 native px.
        let p = downscale_params(3840, 2160, 1600, 900, true);
        assert_eq!(p[0], 1.0);
        assert!((p[2] * 3840.0 - 0.6).abs() < 1e-3, "{p:?}");
        // …and without current mips it must stay on level 0 (wider taps).
        let p = downscale_params(3840, 2160, 1600, 900, false);
        assert_eq!(p[0], 0.0);
        assert!((p[2] * 3840.0 - 0.7).abs() < 1e-3, "{p:?}");
    }

    /// Text-like BGRA test card: 1px strokes, small glyph blocks, fine diagonals,
    /// a checker patch and a smooth gradient (the content downscaling ruins first).
    fn text_card(w: u32, h: u32) -> Vec<u8> {
        let mut px = vec![0u8; (w * h * 4) as usize];
        let mut seed = 0x1234_5678u32;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let v: u8 = if x < w / 2 {
                    // "text": dark glyph marks on light, 13px line pitch
                    let line = y % 13;
                    if line < 9 && (x / 3 + y / 13) % 5 != 0 && (x % 3 != 2) { 30 } else { 235 }
                } else if y < h / 3 {
                    if (x + y) % 5 == 0 { 20 } else { 240 } // fine diagonals
                } else if y < 2 * h / 3 {
                    if ((x / 2) + (y / 2)) % 2 == 0 { 0 } else { 255 } // 2px checker
                } else {
                    ((x * 255) / w) as u8 // gradient
                };
                let n = (rnd() % 7) as u8;
                px[i] = v.saturating_add(n);
                px[i + 1] = v;
                px[i + 2] = v.saturating_sub(n);
                px[i + 3] = 255;
            }
        }
        px
    }

    fn mipped_src(c: &Ctx, w: u32, h: u32, px: &[u8]) -> (ID3D11Texture2D, ID3D11ShaderResourceView) {
        use windows::Win32::Graphics::Direct3D11::D3D11_RESOURCE_MISC_GENERATE_MIPS;
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 0,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
                MiscFlags: D3D11_RESOURCE_MISC_GENERATE_MIPS.0 as u32,
                ..Default::default()
            };
            let mut tex = None;
            c.device.CreateTexture2D(&desc, None, Some(&mut tex)).unwrap();
            let tex = tex.unwrap();
            let res: windows::Win32::Graphics::Direct3D11::ID3D11Resource = tex.cast().unwrap();
            c.context.UpdateSubresource(&res, 0, None, px.as_ptr() as *const _, w * 4, 0);
            let mut srv = None;
            c.device.CreateShaderResourceView(&tex, None, Some(&mut srv)).unwrap();
            let srv = srv.unwrap();
            c.context.GenerateMips(&srv);
            (tex, srv)
        }
    }

    fn read_all(c: &Ctx, tex: &ID3D11Texture2D, w: u32, h: u32) -> Vec<u8> {
        unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..Default::default()
            };
            let mut stg = None;
            c.device.CreateTexture2D(&desc, None, Some(&mut stg)).unwrap();
            let stg = stg.unwrap();
            let dst: windows::Win32::Graphics::Direct3D11::ID3D11Resource = stg.cast().unwrap();
            let src: windows::Win32::Graphics::Direct3D11::ID3D11Resource = tex.cast().unwrap();
            c.context.CopyResource(&dst, &src);
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            c.context.Map(&dst, 0, D3D11_MAP_READ, 0, Some(&mut m)).unwrap();
            let mut out = vec![0u8; (w * h * 4) as usize];
            for y in 0..h as usize {
                let row = (m.pData as *const u8).add(y * m.RowPitch as usize);
                std::ptr::copy_nonoverlapping(row, out.as_mut_ptr().add(y * w as usize * 4), w as usize * 4);
            }
            c.context.Unmap(&dst, 0);
            out
        }
    }

    fn psnr_rgb(a: &[u8], b: &[u8]) -> f64 {
        let mut se = 0f64;
        let mut n = 0f64;
        for (pa, pb) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
            for ch in 0..3 {
                let d = pa[ch] as f64 - pb[ch] as f64;
                se += d * d;
                n += 1.0;
            }
        }
        10.0 * (255.0f64 * 255.0 / (se / n).max(1e-9)).log10()
    }

    /// Area filter vs the old trilinear read, both scored against a CPU Lanczos3
    /// reference downscale of a text-like card, across the ratios real setups hit.
    ///   `cargo test --lib remote::gpu::tests::area_filter_beats_trilinear -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a GPU"]
    fn area_filter_beats_trilinear() {
        use fast_image_resize::images::{Image as FirImage, ImageRef};
        use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
        let Some(c) = ctx() else {
            eprintln!("no D3D11 device — skipping");
            return;
        };
        for (nw, nh, ow, oh) in [
            (2560u32, 1440u32, 1920u32, 1080u32), // 1.333
            (1920, 1080, 1280, 720),              // 1.5
            (3440, 1440, 1920, 804),              // 1.79 (ultrawide)
            (3840, 2160, 1920, 1080),             // 2.0 (exact)
            (3840, 2160, 1600, 900),              // 2.4
            (3840, 2160, 1280, 720),              // 3.0
            (3840, 2160, 1760, 990),              // 2.18
            (3840, 2160, 1366, 768),              // 2.81
            (5120, 1440, 2400, 675),              // 2.13 (super-ultrawide)
        ] {
            let card = text_card(nw, nh);
            let (_t, srv) = mipped_src(&c, nw, nh, &card);
            let mut comp = Compositor::new(&c.device, &c.context, ow, oh).expect("compositor");
            // Reference: Lanczos3 on the CPU.
            let src = ImageRef::new(nw, nh, &card, PixelType::U8x4).unwrap();
            let mut dst = FirImage::new(ow, oh, PixelType::U8x4);
            Resizer::new()
                .resize(&src, &mut dst, &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3)))
                .unwrap();
            let reference = dst.into_vec();

            assert!(comp.render_with(&srv, nw, nh, true, None, [0.0, 0.0, 0.0, 0.0]));
            let tri = psnr_rgb(&read_all(&c, comp.output(), ow, oh), &reference);
            assert!(comp.render(&srv, nw, nh, true, None));
            let area = psnr_rgb(&read_all(&c, comp.output(), ow, oh), &reference);

            eprintln!(
                "{nw}x{nh} -> {ow}x{oh} ({:.2}x): trilinear {tri:.2} dB, area {area:.2} dB ({:+.2})",
                nw as f32 / ow as f32,
                area - tri
            );
            assert!(area >= tri - 0.05, "area filter must never be worse than trilinear ({area:.2} < {tri:.2})");
        }
    }

    /// Drives the real shader on the real GPU: scaling plus every cursor op.
    /// `#[ignore]`d — needs a D3D11 device, so CI/headless must not run it.
    ///   `cargo test --lib remote::gpu -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a GPU"]
    fn composites_scale_and_every_cursor_op() {
        let Some(c) = ctx() else {
            eprintln!("no D3D11 device — skipping");
            return;
        };
        let (nw, nh) = (256u32, 256u32);
        let (ow, oh) = (128u32, 128u32);
        // Mid-grey screen: 0x40. Chosen so an XOR is unambiguous (0x40^0xFF = 0xBF).
        let (_src_tex, srv) = solid_src(&c, nw, nh, [0x40, 0x40, 0x40, 0xFF]);
        let mut comp = Compositor::new(&c.device, &c.context, ow, oh).expect("compositor");

        // --- no cursor: pure downscale, colour must survive untouched.
        assert!(comp.render(&srv, nw, nh, false, None));
        assert_eq!(
            read_px(&c, comp.output(), ow, oh, 64, 64)[..3],
            [0x40, 0x40, 0x40],
            "plain scale must not alter colour"
        );

        // --- colour cursor, fully opaque red, at the origin.
        let cur = CursorImage {
            px: [0x00, 0x00, 0xFF, 0xFF].repeat(16 * 16), // BGRA red, a=255
            w: 16,
            h: 16,
            x: 0,
            y: 0,
            masked: false,
        };
        assert!(comp.render(&srv, nw, nh, false, Some((&cur, 1))));
        assert_eq!(
            read_px(&c, comp.output(), ow, oh, 2, 2)[..3],
            [0x00, 0x00, 0xFF],
            "opaque colour cursor must replace the screen"
        );
        assert_eq!(
            read_px(&c, comp.output(), ow, oh, 100, 100)[..3],
            [0x40, 0x40, 0x40],
            "outside the cursor rect must be untouched"
        );

        // --- masked cursor, alpha 0 = opaque replace.
        let opaque = CursorImage {
            px: [0xFF, 0x00, 0x00, 0x00].repeat(16 * 16), // BGRA blue, a=0
            w: 16,
            h: 16,
            x: 0,
            y: 0,
            masked: true,
        };
        assert!(comp.render(&srv, nw, nh, false, Some((&opaque, 2))));
        assert_eq!(
            read_px(&c, comp.output(), ow, oh, 2, 2)[..3],
            [0xFF, 0x00, 0x00],
            "masked alpha=0 must replace with rgb"
        );

        // --- masked cursor, alpha 255 + white = XOR the screen (the inverting I-beam).
        // This is the case a plain alpha blend cannot express, and the reason the
        // composite reads the screen value in-shader.
        let invert = CursorImage {
            px: [0xFF, 0xFF, 0xFF, 0xFF].repeat(16 * 16),
            w: 16,
            h: 16,
            x: 0,
            y: 0,
            masked: true,
        };
        assert!(comp.render(&srv, nw, nh, false, Some((&invert, 3))));
        assert_eq!(
            read_px(&c, comp.output(), ow, oh, 2, 2)[..3],
            [0xBF, 0xBF, 0xBF],
            "masked alpha=255 must XOR (0x40 ^ 0xFF = 0xBF)"
        );

        // --- masked cursor, alpha 255 + black = XOR with 0 = transparent.
        // This is how monochrome's and=1,xor=0 arrives after normalization.
        let transparent = CursorImage {
            px: [0x00, 0x00, 0x00, 0xFF].repeat(16 * 16),
            w: 16,
            h: 16,
            x: 0,
            y: 0,
            masked: true,
        };
        assert!(comp.render(&srv, nw, nh, false, Some((&transparent, 4))));
        assert_eq!(
            read_px(&c, comp.output(), ow, oh, 2, 2)[..3],
            [0x40, 0x40, 0x40],
            "masked XOR with black must leave the screen alone"
        );
    }
}
