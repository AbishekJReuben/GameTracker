//! GPU-composited, capture-excluded, nonactivating top-level window. All COM and
//! HWND resources stay on the owning rendering/message thread.
#![cfg(windows)]
use windows::{core::{w,Interface,Result},Win32::{
    Foundation::{HWND,LPARAM,LRESULT,WPARAM},
    Graphics::{Direct2D::*,Direct2D::Common::*,Direct3D::D3D_DRIVER_TYPE_HARDWARE,Direct3D11::*,DirectComposition::*,DirectWrite::*,Dwm::DwmIsCompositionEnabled,Dxgi::*,Dxgi::Common::*},
    System::LibraryLoader::GetModuleHandleW,
    UI::{HiDpi::*,WindowsAndMessaging::*},
}};
use super::super::display::PhysicalRect;

pub const WINDOW_CLASS:&str="GameTrackerRemotePresenceOverlay";
unsafe extern "system" fn window_proc(hwnd:HWND,msg:u32,wp:WPARAM,lp:LPARAM)->LRESULT {
    match msg {WM_NCHITTEST=>LRESULT(HTTRANSPARENT as isize),WM_MOUSEACTIVATE=>LRESULT(MA_NOACTIVATE as isize),WM_ERASEBKGND=>LRESULT(1),_=>DefWindowProcW(hwnd,msg,wp,lp)}
}
struct OwnedWindow(HWND);
impl Drop for OwnedWindow {fn drop(&mut self){unsafe{let _=DestroyWindow(self.0);}}}
struct Apartment;
impl Drop for Apartment {fn drop(&mut self){unsafe{windows::Win32::System::Com::CoUninitialize();}}}

pub struct RenderDevice {pub device:ID3D11Device,pub context:ID3D11DeviceContext,d2d:ID2D1Device,write:IDWriteFactory,composition:IDCompositionDevice,factory:IDXGIFactory2,_apartment:Apartment}
impl RenderDevice {
    pub fn new()->Result<Self> {unsafe{
        windows::Win32::System::Com::CoInitializeEx(None,windows::Win32::System::Com::COINIT_MULTITHREADED).ok()?;
        let apartment=Apartment;
        let _=SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if !DwmIsCompositionEnabled()?.as_bool() {return Err(windows::core::Error::from_win32());}
        // WDA_EXCLUDEFROMCAPTURE used to mean a black rectangle before 2004.
        // Detect the real build through ntdll rather than manifest-virtualized APIs.
        type Version=unsafe extern "system" fn(*mut windows::Win32::System::SystemInformation::OSVERSIONINFOW)->i32;
        let module=GetModuleHandleW(w!("ntdll.dll"))?;
        let proc=windows::Win32::System::LibraryLoader::GetProcAddress(module,windows::core::s!("RtlGetVersion")).ok_or_else(windows::core::Error::from_win32)?;
        let version:Version=std::mem::transmute(proc);
        let mut info=windows::Win32::System::SystemInformation::OSVERSIONINFOW{dwOSVersionInfoSize:std::mem::size_of::<windows::Win32::System::SystemInformation::OSVERSIONINFOW>() as u32,..Default::default()};
        if version(&mut info)!=0 || info.dwMajorVersion<10 || info.dwBuildNumber<19041 {return Err(windows::core::Error::new(windows::core::HRESULT(0x80004001u32 as i32),"Capture exclusion needs Windows 10 version 2004 or newer"));}
        let mut device=None;let mut context=None;
        D3D11CreateDevice(None::<&IDXGIAdapter>,D3D_DRIVER_TYPE_HARDWARE,None,D3D11_CREATE_DEVICE_BGRA_SUPPORT,None,D3D11_SDK_VERSION,Some(&mut device),None,Some(&mut context))?;
        let device=device.ok_or_else(windows::core::Error::from_win32)?;let context=context.ok_or_else(windows::core::Error::from_win32)?;
        let dxgi:IDXGIDevice=device.cast()?;
        let factory:IDXGIFactory2=dxgi.GetAdapter()?.GetParent()?;
        let d2d_factory:ID2D1Factory1=D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED,None)?;
        Ok(Self{d2d:d2d_factory.CreateDevice(&dxgi)?,write:DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?,composition:DCompositionCreateDevice(&dxgi)?,factory,device,context,_apartment:apartment})
    }}
}
pub struct OverlayWindow {
    window:OwnedWindow,pub rect:PhysicalRect,
    swap:IDXGISwapChain1,canvas:ID2D1DeviceContext,_bitmap:ID2D1Bitmap1,
    _target:IDCompositionTarget,_visual:IDCompositionVisual,
    write:IDWriteFactory,composition:IDCompositionDevice,
    pub device:ID3D11Device,pub context:ID3D11DeviceContext,
    render_target:ID3D11RenderTargetView,label_cache:Option<LabelCache>,
}
struct LabelCache {text:String,font_key:u32,layout:IDWriteTextLayout,width:f32,height:f32}
impl OverlayWindow {
    pub fn new(device:&RenderDevice,rect:PhysicalRect)->Result<Self> {unsafe {
        let module=GetModuleHandleW(None)?;
        let class=WNDCLASSW{lpfnWndProc:Some(window_proc),hInstance:module.into(),lpszClassName:w!("GameTrackerRemotePresenceOverlay"),..Default::default()};
        RegisterClassW(&class);
        let hwnd=CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_TRANSPARENT|WS_EX_LAYERED|WS_EX_NOREDIRECTIONBITMAP,
            w!("GameTrackerRemotePresenceOverlay"),w!("Remote desktop presence"),WS_POPUP,rect.x,rect.y,rect.width as i32,rect.height as i32,None,None,module,None)?;
        let window=OwnedWindow(hwnd);
        // This must succeed before the window can ever become visible.
        SetWindowDisplayAffinity(hwnd,WDA_EXCLUDEFROMCAPTURE)?;
        SetLayeredWindowAttributes(hwnd,windows::Win32::Foundation::COLORREF(0),255,LWA_ALPHA)?;
        let desc=DXGI_SWAP_CHAIN_DESC1{Width:rect.width,Height:rect.height,Format:DXGI_FORMAT_B8G8R8A8_UNORM,SampleDesc:DXGI_SAMPLE_DESC{Count:1,Quality:0},BufferUsage:DXGI_USAGE_RENDER_TARGET_OUTPUT,BufferCount:2,Scaling:DXGI_SCALING_STRETCH,SwapEffect:DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,AlphaMode:DXGI_ALPHA_MODE_PREMULTIPLIED,..Default::default()};
        let swap=device.factory.CreateSwapChainForComposition(&device.device,&desc,None::<&IDXGIOutput>)?;
        let surface:IDXGISurface=swap.GetBuffer(0)?;
        let texture:ID3D11Texture2D=surface.cast()?;let mut render_target=None;
        device.device.CreateRenderTargetView(&texture,None,Some(&mut render_target))?;
        let canvas=device.d2d.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
        let bitmap=canvas.CreateBitmapFromDxgiSurface(&surface,Some(&D2D1_BITMAP_PROPERTIES1{pixelFormat:D2D1_PIXEL_FORMAT{format:DXGI_FORMAT_B8G8R8A8_UNORM,alphaMode:D2D1_ALPHA_MODE_PREMULTIPLIED},dpiX:96.,dpiY:96.,bitmapOptions:D2D1_BITMAP_OPTIONS_TARGET|D2D1_BITMAP_OPTIONS_CANNOT_DRAW,..Default::default()}))?;
        canvas.SetTarget(&bitmap);canvas.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        let target=device.composition.CreateTargetForHwnd(hwnd,true)?;let visual=device.composition.CreateVisual()?;
        visual.SetContent(&swap)?;target.SetRoot(&visual)?;device.composition.Commit()?;
        Ok(Self{window,rect,swap,canvas,_bitmap:bitmap,_target:target,_visual:visual,write:device.write.clone(),composition:device.composition.clone(),device:device.device.clone(),context:device.context.clone(),render_target:render_target.unwrap(),label_cache:None})
    }}
    pub fn hwnd(&self)->HWND {self.window.0}
    pub fn show(&self)->Result<()> {unsafe {SetWindowPos(self.hwnd(),HWND_TOPMOST,self.rect.x,self.rect.y,self.rect.width as i32,self.rect.height as i32,SWP_NOACTIVATE|SWP_SHOWWINDOW)}}
    pub fn hide(&self){unsafe{let _=ShowWindow(self.hwnd(),SW_HIDE);}}
    pub fn dpi_scale(&self)->f32 {unsafe{(GetDpiForWindow(self.hwnd()).max(96) as f32/96.).clamp(1.,4.)}}
    pub fn draw_animated(&mut self,aurora:&super::aurora::Aurora,parameters:&super::aurora::Parameters,name:&str,notice:super::effects::NoticeFrame,appearance:&super::super::appearance::Appearance)->Result<bool> {
        self.draw_animated_unpresented(aurora,parameters,name,notice,appearance)?;
        unsafe{let status=self.swap.Present(0,DXGI_PRESENT_DO_NOT_WAIT);if status==DXGI_ERROR_WAS_STILL_DRAWING {return Ok(false);}status.ok()?;self.composition.Commit()?;Ok(true)}
    }
    pub fn draw_animated_unpresented(&mut self,aurora:&super::aurora::Aurora,parameters:&super::aurora::Parameters,name:&str,notice:super::effects::NoticeFrame,appearance:&super::super::appearance::Appearance)->Result<()> {unsafe{
        self.canvas.SetTarget(None::<&ID2D1Image>);
        aurora.draw(&self.render_target,parameters);
        self.canvas.SetTarget(&self._bitmap);
        let dpi=self.dpi_scale();let size=appearance.number("label.size")*dpi*(1.+notice.expansion*0.6);
        let font_key=(size*8.).round() as u32;let text=format!("Controlled remotely by {name}");
        if self.label_cache.as_ref().map_or(true,|c|c.text!=text||c.font_key!=font_key) {
            let format=self.write.CreateTextFormat(w!("Segoe UI"),None::<&IDWriteFontCollection>,DWRITE_FONT_WEIGHT_SEMI_BOLD,DWRITE_FONT_STYLE_NORMAL,DWRITE_FONT_STRETCH_NORMAL,font_key as f32/8.,w!("en-US"))?;
            format.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
            let sign=self.write.CreateEllipsisTrimmingSign(&format)?;
            format.SetTrimming(&DWRITE_TRIMMING{granularity:DWRITE_TRIMMING_GRANULARITY_CHARACTER,..Default::default()},&sign)?;
            let width=(self.rect.width as f32-64.*dpi).max(32.).min(1300.*dpi);
            let wide:Vec<_>=text.encode_utf16().collect();let layout=self.write.CreateTextLayout(&wide,&format,width,160.*dpi)?;
            let mut metrics=DWRITE_TEXT_METRICS::default();layout.GetMetrics(&mut metrics)?;
            self.label_cache=Some(LabelCache{text,font_key,layout,width:metrics.widthIncludingTrailingWhitespace.min(width),height:metrics.height});
        }
        let label=self.label_cache.as_ref().unwrap();let width=label.width+28.*dpi;let height=label.height+16.*dpi;
        let centered=(self.rect.width as f32-width)/2.;
        let compact=match appearance.text("label.placement") {"topLeft"=>20.*dpi,"topRight"=>self.rect.width as f32-width-20.*dpi,_=>centered};
        let x=compact+(centered-compact)*notice.expansion;let y=(12.+notice.expansion*10.)*dpi;
        self.canvas.BeginDraw();
        let backing=self.canvas.CreateSolidColorBrush(&D2D1_COLOR_F{r:0.025,g:0.035,b:0.055,a:appearance.number("label.backing")*notice.opacity},None)?;
        self.canvas.FillRoundedRectangle(&D2D1_ROUNDED_RECT{rect:D2D_RECT_F{left:x,top:y,right:x+width,bottom:y+height},radiusX:10.*dpi,radiusY:10.*dpi},&backing);
        let ink=self.canvas.CreateSolidColorBrush(&D2D1_COLOR_F{r:1.,g:1.,b:1.,a:notice.opacity},None)?;
        self.canvas.DrawTextLayout(D2D_POINT_2F{x:x+14.*dpi,y:y+8.*dpi},&label.layout,&ink,D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT);
        self.canvas.EndDraw(None,None)
    }}
    /// Stage D deliberately starts with a static border and native text.
    pub fn draw_static(&self,name:&str)->Result<()> {self.draw_static_unpresented(name)?;self.present()}
    pub fn draw_static_unpresented(&self,name:&str)->Result<()> {unsafe {
        self.canvas.BeginDraw();self.canvas.Clear(Some(&D2D1_COLOR_F{r:0.,g:0.,b:0.,a:0.}));
        let edge=self.canvas.CreateSolidColorBrush(&D2D1_COLOR_F{r:0.1,g:0.85,b:0.75,a:0.6},None)?;
        let rect=D2D_RECT_F{left:1.5,top:1.5,right:self.rect.width as f32-1.5,bottom:self.rect.height as f32-1.5};
        self.canvas.DrawRectangle(&rect,&edge,3.,None::<&ID2D1StrokeStyle>);
        let text=format!("Controlled remotely by {name}");
        let format=self.write.CreateTextFormat(w!("Segoe UI"),None::<&IDWriteFontCollection>,DWRITE_FONT_WEIGHT_SEMI_BOLD,DWRITE_FONT_STYLE_NORMAL,DWRITE_FONT_STRETCH_NORMAL,18.,w!("en-US"))?;
        format.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER)?;
        let wide:Vec<_>=text.encode_utf16().collect();let width=(self.rect.width as f32-32.).min(800.);
        let layout=self.write.CreateTextLayout(&wide,&format,width,60.)?;
        let x=(self.rect.width as f32-width)/2.;
        let backing=self.canvas.CreateSolidColorBrush(&D2D1_COLOR_F{r:0.025,g:0.035,b:0.055,a:0.78},None)?;
        self.canvas.FillRoundedRectangle(&D2D1_ROUNDED_RECT{rect:D2D_RECT_F{left:x-12.,top:12.,right:x+width+12.,bottom:58.},radiusX:12.,radiusY:12.},&backing);
        let ink=self.canvas.CreateSolidColorBrush(&D2D1_COLOR_F{r:1.,g:1.,b:1.,a:1.},None)?;
        self.canvas.DrawTextLayout(D2D_POINT_2F{x,y:22.},&layout,&ink,D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT);
        self.canvas.EndDraw(None,None)
    }}
    pub fn present(&self)->Result<()> {unsafe{self.swap.Present(1,DXGI_PRESENT(0)).ok()?;self.composition.Commit()}}
    pub fn export_pixels(&self)->Result<(u32,u32,Vec<u8>)> {unsafe{
        // Read the surface Direct2D actually painted. Flip presentation can move
        // the swap-chain's current buffer index after Present.
        let source:ID3D11Texture2D=self._bitmap.GetSurface()?.cast()?;
        let desc=D3D11_TEXTURE2D_DESC{Width:self.rect.width,Height:self.rect.height,MipLevels:1,ArraySize:1,Format:DXGI_FORMAT_B8G8R8A8_UNORM,SampleDesc:DXGI_SAMPLE_DESC{Count:1,Quality:0},Usage:D3D11_USAGE_STAGING,CPUAccessFlags:D3D11_CPU_ACCESS_READ.0 as u32,..Default::default()};
        let mut staging=None;self.device.CreateTexture2D(&desc,None,Some(&mut staging))?;let staging=staging.ok_or_else(windows::core::Error::from_win32)?;
        self.context.CopyResource(&staging,&source);let mut mapped=D3D11_MAPPED_SUBRESOURCE::default();self.context.Map(&staging,0,D3D11_MAP_READ,0,Some(&mut mapped))?;
        let mut bytes=vec![0;self.rect.width as usize*self.rect.height as usize*4];
        for y in 0..self.rect.height as usize {let row=std::slice::from_raw_parts((mapped.pData as *const u8).add(y*mapped.RowPitch as usize),self.rect.width as usize*4);bytes[y*self.rect.width as usize*4..(y+1)*self.rect.width as usize*4].copy_from_slice(row);}
        self.context.Unmap(&staging,0);Ok((self.rect.width,self.rect.height,bytes))
    }}
}
impl Drop for OverlayWindow {fn drop(&mut self){self.hide();unsafe{let _=self._target.SetRoot(None::<&IDCompositionVisual>);let _=self.composition.Commit();self.canvas.SetTarget(None::<&ID2D1Image>);}}}
pub fn pump_messages(){unsafe{let mut msg=MSG::default();while PeekMessageW(&mut msg,None,0,0,PM_REMOVE).as_bool(){let _=TranslateMessage(&msg);DispatchMessageW(&msg);}}}
