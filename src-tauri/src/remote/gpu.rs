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

float4 ps(VSOut i) : SV_TARGET {
    // The sampler does the downscale. Trilinear off the generated mip chain gives a
    // filtered read rather than the aliased mess a plain bilinear 4K->1080p would be.
    float3 col = srcTex.Sample(srcSmp, i.uv).rgb;
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

            let mk_sampler = |filter| {
                let d = D3D11_SAMPLER_DESC {
                    Filter: filter,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    ComparisonFunc: D3D11_COMPARISON_NEVER,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                };
                let mut s = None;
                device.CreateSamplerState(&d, Some(&mut s)).ok()?;
                s
            };
            let smp_linear = mk_sampler(D3D11_FILTER_MIN_MAG_MIP_LINEAR)?;
            // Point-sample the cursor: it's tiny and already the right shape; bilinear
            // would smear its 1px edges (and the XOR mask must stay exactly 0 or 255).
            let smp_point = mk_sampler(D3D11_FILTER_MIN_MAG_MIP_POINT)?;

            let (out_tex, out_rtv) = Self::make_target(device, w, h)?;
            Some(Compositor {
                device: device.clone(),
                context: context.clone(),
                vs: vs?,
                ps: ps?,
                cb: cb?,
                smp_linear,
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
    /// composite `cursor` if there is one. Returns false if the GPU work couldn't be
    /// issued — caller should fall back rather than encode a stale/blank target.
    pub fn render(
        &mut self,
        src: &ID3D11ShaderResourceView,
        native_w: u32,
        native_h: u32,
        cursor: Option<(&CursorImage, u64)>,
    ) -> bool {
        if native_w == 0 || native_h == 0 {
            return false;
        }
        let mut p = Params::default();
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
            self.context
                .PSSetSamplers(0, Some(&[Some(self.smp_linear.clone()), Some(self.smp_point.clone())]));
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
        assert!(comp.render(&srv, nw, nh, None));
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
        assert!(comp.render(&srv, nw, nh, Some((&cur, 1))));
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
        assert!(comp.render(&srv, nw, nh, Some((&opaque, 2))));
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
        assert!(comp.render(&srv, nw, nh, Some((&invert, 3))));
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
        assert!(comp.render(&srv, nw, nh, Some((&transparent, 4))));
        assert_eq!(
            read_px(&c, comp.output(), ow, oh, 2, 2)[..3],
            [0x40, 0x40, 0x40],
            "masked XOR with black must leave the screen alone"
        );
    }
}
