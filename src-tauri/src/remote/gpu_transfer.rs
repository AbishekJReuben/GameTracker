//! Reused output-sized GPU uploads/readbacks. Cross-adapter callers use the
//! two-slot nonblocking ring; no foreign-device resource is ever sampled.
#![cfg(windows)]
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

pub(crate) struct Texture {
    pub texture: ID3D11Texture2D,
    pub srv: ID3D11ShaderResourceView,
    pub width: u32,
    pub height: u32,
}
impl Texture {
    pub fn new(device: &ID3D11Device, width: u32, height: u32) -> Option<Self> {
        unsafe {
            if width == 0
                || height == 0
                || width > 8192
                || height > 8192
                || width as u64 * height as u64 > 33_177_600
            {
                return None;
            }
            let mut texture = None;
            device
                .CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: width,
                        Height: height,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_DEFAULT,
                        BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                        ..Default::default()
                    },
                    None,
                    Some(&mut texture),
                )
                .ok()?;
            let texture = texture?;
            let mut srv = None;
            device
                .CreateShaderResourceView(&texture, None, Some(&mut srv))
                .ok()?;
            Some(Self {
                texture,
                srv: srv?,
                width,
                height,
            })
        }
    }
    pub fn upload(&self, context: &ID3D11DeviceContext, bytes: &[u8]) -> bool {
        if bytes.len() != self.width as usize * self.height as usize * 4 {
            return false;
        }
        unsafe {
            context.UpdateSubresource(
                &self.texture,
                0,
                None,
                bytes.as_ptr().cast(),
                self.width * 4,
                0,
            );
        }
        true
    }
}

#[derive(Default)]
pub(crate) struct Readback {
    staging: Option<ID3D11Texture2D>,
    size: (u32, u32),
    pub bytes: Vec<u8>,
}
impl Readback {
    fn ensure(&mut self, device: &ID3D11Device, w: u32, h: u32) -> Option<()> {
        unsafe {
            if self.staging.is_some() && self.size == (w, h) {
                return Some(());
            }
            let mut staging = None;
            device
                .CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: w,
                        Height: h,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        Usage: D3D11_USAGE_STAGING,
                        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                        ..Default::default()
                    },
                    None,
                    Some(&mut staging),
                )
                .ok()?;
            self.staging = staging;
            self.size = (w, h);
            self.bytes.resize(w as usize * h as usize * 4, 0);
            Some(())
        }
    }
    fn read(&mut self, context: &ID3D11DeviceContext, nonblocking: bool) -> bool {
        unsafe {
            let Some(staging) = &self.staging else {
                return false;
            };
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if context
                .Map(
                    staging,
                    0,
                    D3D11_MAP_READ,
                    if nonblocking {
                        D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32
                    } else {
                        0
                    },
                    Some(&mut mapped),
                )
                .is_err()
            {
                return false;
            }
            self.bytes
                .resize(self.size.0 as usize * self.size.1 as usize * 4, 0);
            let row = self.size.0 as usize * 4;
            for y in 0..self.size.1 as usize {
                std::ptr::copy_nonoverlapping(
                    (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                    self.bytes.as_mut_ptr().add(y * row),
                    row,
                );
            }
            context.Unmap(staging, 0);
            true
        }
    }
    pub fn copy(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D,
        w: u32,
        h: u32,
    ) -> bool {
        if self.ensure(device, w, h).is_none() {
            return false;
        }
        unsafe {
            context.CopyResource(self.staging.as_ref().unwrap(), source);
        }
        self.read(context, false)
    }
}

#[derive(Default)]
pub(crate) struct AsyncReadback {
    slots: [Readback; 2],
    pending: [Option<u64>; 2],
    next: usize,
    pub bytes: Vec<u8>,
    pub ready_sequence: u64,
    pub submitted: u64,
    pub dropped: u64,
}
impl AsyncReadback {
    pub fn allocated_cpu_bytes(&self)->usize{self.bytes.capacity()+self.slots.iter().map(|s|s.bytes.capacity()).sum::<usize>()}
    pub fn submit(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D,
        w: u32,
        h: u32,
        sequence: u64,
    ) -> bool {
        if self.pending.contains(&Some(sequence)) || sequence <= self.ready_sequence {
            return false;
        }
        let index = if self.pending[self.next].is_none() {
            self.next
        } else {
            1 - self.next
        };
        if self.pending[index].is_some() {
            self.dropped += 1;
            return false;
        }
        if self.slots[index].ensure(device, w, h).is_none() {
            return false;
        }
        unsafe {
            context.CopyResource(self.slots[index].staging.as_ref().unwrap(), source);
            context.Flush();
        }
        self.pending[index] = Some(sequence);
        self.next = 1 - index;
        self.submitted += 1;
        true
    }
    pub fn poll(&mut self, context: &ID3D11DeviceContext) -> bool {
        let mut changed = false;
        for index in 0..2 {
            let Some(sequence) = self.pending[index] else {
                continue;
            };
            if self.slots[index].read(context, true) {
                self.pending[index] = None;
                if sequence > self.ready_sequence {
                    std::mem::swap(&mut self.bytes, &mut self.slots[index].bytes);
                    self.ready_sequence = sequence;
                    changed = true;
                }
            }
        }
        changed
    }
    pub fn pending(&self) -> bool {
        self.pending.iter().any(Option::is_some)
    }
}
