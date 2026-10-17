//! Isolated Windows overlay proof. Never opens app/DB/network or restarts a
//! service. Small owned target patches receive the test clicks; user apps do not.
#[path="../src/remote/display.rs"] mod display;
#[path="../src/remote/appearance.rs"]mod appearance;
#[path="../src/remote/overlay/mod.rs"] mod overlay;
#[path="../src/remote/dxdupe.rs"] mod dxdupe;
#[path="../src/remote/gpusched.rs"] mod gpusched;
mod hostproc {pub fn is_remote_host()->bool{false}}

#[cfg(windows)]
mod probe {
    use std::{sync::atomic::{AtomicUsize,Ordering},time::{Duration,Instant}};
    use windows::{core::w,Win32::{Foundation::{HWND,LPARAM,LRESULT,POINT,WPARAM},Graphics::{Gdi::*,Dwm::DwmFlush},System::{LibraryLoader::GetModuleHandleW,Threading::{GetCurrentProcess,GetGuiResources,GR_USEROBJECTS,GR_GDIOBJECTS}},UI::{Input::KeyboardAndMouse::*,WindowsAndMessaging::*}}};
    use super::{display,dxdupe,overlay::windows::{RenderDevice,OverlayWindow,pump_messages}};
    static CLICKS:AtomicUsize=AtomicUsize::new(0);
    unsafe extern "system" fn target_proc(hwnd:HWND,msg:u32,wp:WPARAM,lp:LPARAM)->LRESULT {
        match msg {
            WM_PAINT=>{let mut paint=PAINTSTRUCT::default();let dc=BeginPaint(hwnd,&mut paint);SetDCBrushColor(dc,windows::Win32::Foundation::COLORREF(0x00604020));FillRect(dc,&paint.rcPaint,HBRUSH(GetStockObject(DC_BRUSH).0));let _=EndPaint(hwnd,&paint);LRESULT(0)},
            WM_MOUSEACTIVATE=>LRESULT(MA_NOACTIVATE as isize),
            WM_LBUTTONDOWN|WM_LBUTTONUP=>{CLICKS.fetch_add(1,Ordering::Relaxed);LRESULT(0)},
            _=>DefWindowProcW(hwnd,msg,wp,lp),
        }
    }
    struct Targets(Vec<HWND>);
    impl Drop for Targets {fn drop(&mut self){unsafe{for hwnd in self.0.drain(..){let _=DestroyWindow(hwnd);}}}}
    fn wait(ms:u64){let end=Instant::now()+Duration::from_millis(ms);while Instant::now()<end {pump_messages();std::thread::sleep(Duration::from_millis(3));}}
    unsafe fn move_pointer(point:POINT) {
        let x=GetSystemMetrics(SM_XVIRTUALSCREEN);let y=GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w=(GetSystemMetrics(SM_CXVIRTUALSCREEN)-1).max(1) as i64;let h=(GetSystemMetrics(SM_CYVIRTUALSCREEN)-1).max(1) as i64;
        let input=INPUT{r#type:INPUT_MOUSE,Anonymous:INPUT_0{mi:MOUSEINPUT{dx:(((point.x-x) as i64*65535+w/2)/w) as i32,dy:(((point.y-y) as i64*65535+h/2)/h) as i32,dwFlags:MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK,..Default::default()}}};
        SendInput(&[input],std::mem::size_of::<INPUT>() as i32);
    }
    struct CursorRestore(Option<POINT>);
    impl Drop for CursorRestore {fn drop(&mut self){if let Some(point)=self.0{unsafe{move_pointer(point);}}}}
    fn sample_bgra(px:&[u8],w:u32,points:&[(i32,i32)])->Vec<[u8;4]> {points.iter().map(|(x,y)|{let i=(*y as usize*w as usize+*x as usize)*4;px[i..i+4].try_into().unwrap()}).collect()}
    pub fn run()->Result<(),Box<dyn std::error::Error>> {unsafe{
        let out=std::env::args().nth(1).unwrap_or_else(||"docs/remote-implementation/evidence".into());std::fs::create_dir_all(&out)?;
        let prefix=std::env::args().nth(2).filter(|s|s.starts_with("stage-")).unwrap_or_else(||"stage-d-static-overlay".into());
        if !prefix.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){return Err("invalid evidence prefix".into());}
        let animated=std::env::args().any(|s|s=="--animated");let no_input=std::env::args().any(|s|s=="--no-input");
        let foreground=GetForegroundWindow();let mut original=POINT::default();GetCursorPos(&mut original)?;
        let safe_input=!no_input&&[VK_LBUTTON,VK_RBUTTON,VK_MBUTTON,VK_CONTROL,VK_SHIFT,VK_MENU,VK_LWIN,VK_RWIN].iter().all(|key|GetAsyncKeyState(key.0 as i32)>=0);
        let _restore=CursorRestore(if safe_input{Some(original)}else{None});
        let topology=display::snapshot();
        let before_user=GetGuiResources(GetCurrentProcess(),GR_USEROBJECTS);let before_gdi=GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS);
        let renderer=RenderDevice::new()?;let module=GetModuleHandleW(None)?;
        let aurora=if animated{Some(super::overlay::aurora::Aurora::new(&renderer)?)}else{None};
        RegisterClassW(&WNDCLASSW{lpfnWndProc:Some(target_proc),hInstance:module.into(),lpszClassName:w!("GameTrackerOverlayProbeTarget"),..Default::default()});
        let monitors=xcap::Monitor::all()?;let mut records=Vec::new();
        for (index,d) in topology.displays.iter().enumerate() {
            let m=monitors.iter().find(|m|m.x().ok()==Some(d.x)&&m.y().ok()==Some(d.y)).ok_or("xcap output missing")?;
            let mut local=vec![(2,d.height as i32/2),(d.width as i32-3,d.height as i32/2),(d.width as i32/2,2),(d.width as i32/2,d.height as i32-3),(d.width as i32/2,34)];
            if animated{local.extend([(d.width as i32/2,d.height as i32/2),(d.width as i32/2+20,d.height as i32/2),(d.width as i32/2+40,d.height as i32/2)]);}
            let mut targets=Targets(Vec::new());
            for &(x,y) in &local {
                let hwnd=CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,w!("GameTrackerOverlayProbeTarget"),w!("Owned input/exclusion probe"),WS_POPUP,d.x+(x-12).max(0).min(d.width as i32-32),d.y+(y-12).max(0).min(d.height as i32-32),32,32,None,None,module,None)?;
                targets.0.push(hwnd);SetWindowPos(hwnd,HWND_TOPMOST,0,0,0,0,SWP_NOACTIVATE|SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW)?;
            }
            wait(100);DwmFlush()?;
            let mut duplication=dxdupe::Duplicator::new_for(d.x,d.y).ok_or("DXGI duplication unavailable for probe")?;
            // DuplicateOutput may first yield its initialized/blank surface.
            // Force our owned patches to repaint, then verify actual pixels.
            for _ in 0..10 {
                for target in &targets.0 {let _=InvalidateRect(*target,None,true);}
                wait(30);DwmFlush()?;let _=duplication.grab(50,d.width);
                if sample_bgra(duplication.buffer(),d.width,&local).iter().all(|p|*p==[96,64,32,255]) {break;}
            }
            if duplication.buffer().len()!=d.width as usize*d.height as usize*4{return Err("unexpected native readback size".into());}
            let dxgi_before=sample_bgra(duplication.buffer(),d.width,&local);
            let gdi_before=m.capture_image()?;let gdi_samples:Vec<_>=local.iter().map(|&(x,y)|gdi_before.get_pixel(x as u32,y as u32).0).collect();
            let mut overlay=OverlayWindow::new(&renderer,d.rect())?;
            let paint=|window:&mut OverlayWindow,seconds:f32|->windows::core::Result<()> {
                if let Some(aurora)=aurora.as_ref(){
                    let a=super::appearance::Appearance::preset("Expressive");let now=Instant::now();let cursor=(d.x+d.width as i32/2,d.y+d.height as i32/2);
                    let click=super::overlay::effects::Reaction{session_id:"capture-probe".into(),x:cursor.0,y:cursor.1,at:now-Duration::from_millis(180)};
                    let notice=super::overlay::effects::Notice::new(None,now,3.).sample(now,3.,false);
                    let p=super::overlay::aurora::Parameters::new(d.rect(),&a,window.dpi_scale(),seconds,1.,false,Some(cursor),[300.,0.],&[click],now);
                    window.draw_animated_unpresented(aurora,&p,"Remote User",notice,&a)
                }else{window.draw_static_unpresented("Remote User")}
            };
            paint(&mut overlay,0.)?;
            let (w,h,mut pixels)=overlay.export_pixels()?;let colored=pixels.chunks_exact(4).filter(|p|p[3]>0 && (p[0]>0||p[1]>0||p[2]>0)).count();
            for p in pixels.chunks_exact_mut(4){p.swap(0,2);}
            image::save_buffer(format!("{out}/{prefix}-{index}.png"),&pixels,w,h,image::ColorType::Rgba8)?;
            overlay.present()?;overlay.show()?;wait(150);DwmFlush()?;
            let mut animated_samples_ok=true;
            if animated {for frame in 0..30 {paint(&mut overlay,frame as f32/20.)?;overlay.present()?;wait(20);let _=duplication.grab(30,d.width);animated_samples_ok&=sample_bgra(duplication.buffer(),d.width,&local)==dxgi_before;}}
            let mut affinity=0;GetWindowDisplayAffinity(overlay.hwnd(),&mut affinity)?;
            let mut hit_results=Vec::new();let mut per_point=Vec::new();
            let initial_clicks=CLICKS.load(Ordering::Relaxed);
            for (&(x,y),target) in local.iter().zip(&targets.0) {
                let point=POINT{x:d.x+x,y:d.y+y};let hit=WindowFromPoint(point)==*target;hit_results.push(hit);
                if safe_input && hit {
                    let count=CLICKS.load(Ordering::Relaxed);
                    move_pointer(point);wait(100);
                    let mut before_click=POINT::default();GetCursorPos(&mut before_click)?;
                    // Hover can raise an auto-hidden taskbar, and the human can
                    // move the real pointer. Never click on that intervening UI.
                    if WindowFromPoint(before_click)!=*target {
                        per_point.push(serde_json::json!({"expected":[point.x,point.y],"actual":[before_click.x,before_click.y],"hitAtActual":false,"delivered":0,"skipped":"owned target no longer under pointer"}));
                        continue;
                    }
                    let events=[MOUSEEVENTF_LEFTDOWN,MOUSEEVENTF_LEFTUP].map(|flags|INPUT{r#type:INPUT_MOUSE,Anonymous:INPUT_0{mi:MOUSEINPUT{dwFlags:flags,..Default::default()}}});
                    if SendInput(&events,std::mem::size_of::<INPUT>() as i32)!=2{return Err("input probe injection rejected".into());}
                    let deadline=Instant::now()+Duration::from_millis(300);
                    while CLICKS.load(Ordering::Relaxed)<count+2&&Instant::now()<deadline {wait(5);}
                    let mut actual=POINT::default();GetCursorPos(&mut actual)?;
                    per_point.push(serde_json::json!({"expected":[point.x,point.y],"actual":[actual.x,actual.y],"hitAtActual":WindowFromPoint(actual)==*target,"delivered":CLICKS.load(Ordering::Relaxed)-count}));
                }
            }
            if safe_input {move_pointer(original);}wait(100);
            for _ in 0..4 {let _=duplication.grab(30,d.width);}
            let dxgi_after=sample_bgra(duplication.buffer(),d.width,&local);
            let gdi_after=m.capture_image()?;let gdi_after_samples:Vec<_>=local.iter().map(|&(x,y)|gdi_after.get_pixel(x as u32,y as u32).0).collect();
            let click_events=CLICKS.load(Ordering::Relaxed)-initial_clicks;
            let stable_foreground=GetForegroundWindow()==foreground;
            let record=serde_json::json!({"display":d,"animated":animated,"animatedSamplesExcluded":animated_samples_ok,"visible":IsWindowVisible(overlay.hwnd()).as_bool(),"affinity":affinity,"hitTests":hit_results,"inputPoints":per_point,"clickInjectionAttempted":safe_input,"deliveredMouseEvents":click_events,"foregroundUnchanged":stable_foreground,"dxgiExcluded":dxgi_before==dxgi_after,"xcapGdiExcluded":gdi_samples==gdi_after_samples,"dxgiBefore":dxgi_before,"dxgiAfter":dxgi_after,"gdiBefore":gdi_samples,"gdiAfter":gdi_after_samples,"renderedColoredPixels":colored,"limits":"GPU export proves rendered pixels, not physical observation. Actual DXGI and xcap paths sampled at each edge, identity, and (animated mode) simulated cursor/ripple positions. Other application/taskbar/fullscreen interactions still need physical review."});
            records.push(record);
            drop(overlay);drop(duplication);drop(targets);wait(30);
        }
        // Repeated create/show/hide/destroy cycles reveal HWND/D2D lifetime leaks.
        let d=topology.displays.first().ok_or("no display")?;
        for _ in 0..10 {let overlay=OverlayWindow::new(&renderer,d.rect())?;overlay.draw_static("Remote User")?;overlay.show()?;wait(10);overlay.hide();drop(overlay);pump_messages();}
        DwmFlush()?;wait(100);
        let warm_user=GetGuiResources(GetCurrentProcess(),GR_USEROBJECTS);let warm_gdi=GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS);
        for _ in 0..12 {let overlay=OverlayWindow::new(&renderer,d.rect())?;overlay.draw_static("Remote User")?;overlay.show()?;overlay.hide();drop(overlay);pump_messages();}
        DwmFlush()?;wait(50);
        let after_cycles_user=GetGuiResources(GetCurrentProcess(),GR_USEROBJECTS);let after_cycles_gdi=GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS);
        drop(aurora);drop(renderer);DwmFlush()?;wait(50);
        let result=serde_json::json!({"displays":records,"inputInjectionDisabledByFlag":no_input,"inputSkippedBecausePhysicalKeysHeld":!safe_input&&!no_input,"foregroundUnchanged":GetForegroundWindow()==foreground,"userObjectsBefore":before_user,"userObjectsAfter":GetGuiResources(GetCurrentProcess(),GR_USEROBJECTS),"gdiObjectsBefore":before_gdi,"gdiObjectsAfter":GetGuiResources(GetCurrentProcess(),GR_GDIOBJECTS),"warmedUserObjects":warm_user,"afterCyclesUserObjects":after_cycles_user,"warmedGdiObjects":warm_gdi,"afterCyclesGdiObjects":after_cycles_gdi,"repeatedShowHideCycles":12});
        std::fs::write(format!("{out}/{prefix}-probe.json"),serde_json::to_vec_pretty(&result)?)?;
        println!("{result}");
        let passed=result["displays"].as_array().unwrap().iter().all(|r|r["visible"]==true&&r["affinity"]==17&&r["foregroundUnchanged"]==true&&r["dxgiExcluded"]==true&&r["animatedSamplesExcluded"]==true&&r["xcapGdiExcluded"]==true&&r["renderedColoredPixels"].as_u64().unwrap_or(0)>1000&&r["hitTests"].as_array().unwrap().iter().all(|h|h==true)&&(!safe_input||r["deliveredMouseEvents"]==local_expected_events(animated)));
        if !passed||after_cycles_user!=warm_user||after_cycles_gdi!=warm_gdi{return Err("one or more actual overlay gates failed; inspect JSON".into());}
        Ok(())
    }}
    fn local_expected_events(animated:bool)->u64 {if animated{16}else{10}}
}
#[cfg(windows)]fn main(){if let Err(e)=probe::run(){eprintln!("overlay probe failed: {e}");std::process::exit(1);}}
#[cfg(not(windows))]fn main(){eprintln!("Windows required");}
