//! Isolated shipping broker/compositor/NVENC proof. Small owned nonactivating
//! paint targets supply distinct motion. No pointer/input/app/DB/network service.
#[path="../src/remote/display.rs"]mod display;
#[path="../src/remote/view.rs"]mod view;
#[path="../src/remote/dxdupe.rs"]mod dxdupe;
#[path="../src/remote/gpusched.rs"]mod gpusched;
#[path="../src/remote/gpu.rs"]mod gpu;
#[path="../src/remote/gpu_transfer.rs"]mod gpu_transfer;
#[path="../src/remote/system_cursor.rs"]mod system_cursor;
#[path="../src/remote/capture_broker.rs"]mod capture_broker;
#[path="../src/remote/capture_surface.rs"]mod capture_surface;
#[path="../src/remote/native.rs"]mod native;
#[path="../src/remote/nvenc/mod.rs"]mod nvenc;
#[cfg(test)]#[path="../src/remote/delivery.rs"]mod delivery;
#[path="../src/remote/appearance.rs"]mod appearance;
#[path="../src/remote/overlay/mod.rs"]mod overlay;
mod hostproc{pub fn is_remote_host()->bool{false}}
#[cfg(windows)]fn main(){if let Err(error)=run(){eprintln!("combined probe failed: {error}");std::process::exit(1);}}
#[cfg(not(windows))]fn main(){eprintln!("Windows required");}
#[cfg(windows)]fn run()->Result<(),Box<dyn std::error::Error>>{unsafe{
    use std::{sync::atomic::{AtomicU32,Ordering},time::{Duration,Instant}};
    use windows::{core::w,Win32::{Foundation::*,Graphics::Gdi::*,System::LibraryLoader::GetModuleHandleW,UI::WindowsAndMessaging::*}};
    static TICK:AtomicU32=AtomicU32::new(0);
    fn color(index:usize)->COLORREF{let phase=TICK.load(Ordering::Relaxed)%2;let(r,g,b)=if index%2==0{(210,35,35+phase*60)}else{(35+phase*60,180,55)};COLORREF(r|(g<<8)|(b<<16))}
    unsafe extern "system" fn paint(hwnd:HWND,msg:u32,wp:WPARAM,lp:LPARAM)->LRESULT{
        if msg==WM_PAINT{let mut p=PAINTSTRUCT::default();let dc=BeginPaint(hwnd,&mut p);SetDCBrushColor(dc,color(GetWindowLongPtrW(hwnd,GWLP_USERDATA) as usize));FillRect(dc,&p.rcPaint,HBRUSH(GetStockObject(DC_BRUSH).0));let _=EndPaint(hwnd,&p);LRESULT(0)}else if msg==WM_MOUSEACTIVATE{LRESULT(MA_NOACTIVATE as isize)}else{DefWindowProcW(hwnd,msg,wp,lp)}
    }
    fn pump(){unsafe{let mut message=MSG::default();while PeekMessageW(&mut message,None,0,0,PM_REMOVE).as_bool(){let _=TranslateMessage(&message);DispatchMessageW(&message);}}}
    struct Targets(Vec<HWND>);impl Drop for Targets{fn drop(&mut self){for hwnd in self.0.drain(..){unsafe{let _=DestroyWindow(hwnd);}}}}
    let output=std::env::args().nth(1).unwrap_or_else(||"docs/remote-implementation/evidence".into());let prefix=std::env::args().nth(2).unwrap_or_else(||"stage-g-combined-v1".into());
    if !prefix.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){return Err("invalid prefix".into());}std::fs::create_dir_all(&output)?;
    let _dpi=display::DpiScope::physical();let foreground=GetForegroundWindow();let snapshot=display::snapshot();if snapshot.displays.len()<2{return Err("two outputs required".into());}
    let module=GetModuleHandleW(None)?;RegisterClassW(&WNDCLASSW{hInstance:module.into(),lpfnWndProc:Some(paint),lpszClassName:w!("GameTrackerCombinedProbeTarget"),..Default::default()});
    let mut targets=Targets(Vec::new());
    for (index,d) in snapshot.displays.iter().enumerate(){for(x,y)in[(d.x+64,d.y),(d.x+d.width as i32/2-256,d.y),(d.x+d.width as i32/2-256,d.y+d.height as i32/2-128)]{
        let hwnd=CreateWindowExW(WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_TOPMOST,w!("GameTrackerCombinedProbeTarget"),w!("Owned combined capture target"),WS_POPUP,x,y,512,256,None,None,module,None)?;
        SetWindowLongPtrW(hwnd,GWLP_USERDATA,index as isize);SetWindowPos(hwnd,HWND_TOPMOST,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_SHOWWINDOW)?;targets.0.push(hwnd);
    }}
    let view=view::AppliedView::create(&snapshot,view::ViewMode::All,&snapshot.displays[0].id,7,1920,4096,8_294_400).ok_or("combined view")?;
    for d in &snapshot.displays{let binding=dxdupe::OutputBinding::find(d.x,d.y);eprintln!("source binding {} ({},{}) found={} device={}",d.index,d.x,d.y,binding.is_some(),binding.as_ref().is_some_and(|b|b.create_device().is_some()));}
    let mut combined=capture_surface::Surface::new(view.clone()).ok_or("combined surface")?;
    let mut singles:Vec<_>=snapshot.displays.iter().map(|d|view::AppliedView::create(&snapshot,view::ViewMode::Single,&d.id,0,640,4096,8_294_400).and_then(capture_surface::Surface::new).unwrap()).collect();
    let mut display_frames=vec![0;singles.len()];let mut frames=0;let mut compositions=Vec::new();let mut encoded=Vec::new();let mut encoded_frames=0;let mut encoder=None;let mut comp=None;let mut readback=gpu_transfer::Readback::default();let mut samples=Vec::new();let mut exported=false;
    let started=Instant::now();let mut frozen_before=None;let mut frozen_frame_start=0;
    while started.elapsed()<Duration::from_secs(3){let tick=Instant::now();TICK.fetch_add(1,Ordering::Relaxed);for hwnd in &targets.0{let _=InvalidateRect(*hwnd,None,false);}pump();
        if started.elapsed()>Duration::from_millis(1500)&&frozen_before.is_none(){combined.freeze_snapshot(&snapshot.displays[0].id,true);frozen_before=Some(capture_broker::statistics());frozen_frame_start=frames;}
        {let mut frame=combined.lock();let began=Instant::now();if matches!(frame.grab_gpu(0,true),dxdupe::Grab::Frame{..}){
            let compositor=comp.get_or_insert_with(||gpu::Compositor::new(frame.device(),frame.context(),view.width,view.height).unwrap());
            if !frame.render(compositor){return Err("combined render failed".into());}compositions.push(began.elapsed().as_secs_f64()*1000.);frames+=1;
            if encoder.is_none(){encoder=native::NativeEncoder::new(Some(frame.device()),view.width,view.height,30,12_000_000,Default::default());}
            if let Some(encoder)=&mut encoder{if let Some(packet)=encoder.encode_texture(compositor.output(),encoded_frames==0,started.elapsed().as_micros() as u64){encoded.extend_from_slice(&packet[native::NATIVE_HEADER_LEN..]);encoded_frames+=1;}}
            if readback.copy(frame.device(),frame.context(),compositor.output(),view.width,view.height){
                let points:Vec<_>=snapshot.displays.iter().map(|d|{let x=((d.x-view.source.x+d.width as i32/2) as f64/view.source.width as f64*view.width as f64) as usize;let y=((d.y-view.source.y+d.height as i32/2) as f64/view.source.height as f64*view.height as f64) as usize;let i=(y*view.width as usize+x)*4;readback.bytes[i..i+4].to_vec()}).collect();samples.push(points);
                if frames>10&&!exported{let mut rgba=readback.bytes.clone();for p in rgba.chunks_exact_mut(4){p.swap(0,2);}image::save_buffer(format!("{output}/{prefix}.png"),&rgba,view.width,view.height,image::ColorType::Rgba8)?;exported=true;}
            }
        }}
        for(index,single)in singles.iter_mut().enumerate(){let mut frame=single.lock();if matches!(frame.grab(0,640),dxdupe::Grab::Frame{..}){display_frames[index]+=1;}}
        std::thread::sleep(Duration::from_millis(33).saturating_sub(tick.elapsed()));
    }
    let frozen_after=capture_broker::statistics();combined.freeze_snapshot(&snapshot.displays[0].id,false);
    let frozen_before=frozen_before.unwrap();let frozen_before_left=frozen_before.iter().find(|s|s.id==snapshot.displays[0].id).unwrap();let frozen_after_left=frozen_after.iter().find(|s|s.id==snapshot.displays[0].id).unwrap();
    let frozen_progress=frozen_before_left.sequence==frozen_after_left.sequence&&frames-frozen_frame_start>15;
    drop(encoder.take());let single_view=view::AppliedView::create(&snapshot,view::ViewMode::Single,&snapshot.displays[1].id,8,1920,4096,8_294_400).unwrap();
    let mut primary_single=capture_surface::Surface::new(single_view.clone()).ok_or("single GPU source")?;let mut single_encoder=None;let mut single_comp=None;let mut single_packets=Vec::new();let mut single_native_frames=0;
    for _ in 0..30{let began=Instant::now();TICK.fetch_add(1,Ordering::Relaxed);for hwnd in &targets.0{let _=InvalidateRect(*hwnd,None,false);}pump();
        {let mut frame=primary_single.lock();if matches!(frame.grab_gpu(0,true),dxdupe::Grab::Frame{..}){
            let compositor=single_comp.get_or_insert_with(||gpu::Compositor::new(frame.device(),frame.context(),single_view.width,single_view.height).unwrap());
            if frame.render(compositor){
                if single_encoder.is_none(){single_encoder=native::NativeEncoder::new(Some(frame.device()),single_view.width,single_view.height,30,12_000_000,Default::default());}
                if let Some(encoder)=&mut single_encoder{if let Some(packet)=encoder.encode_texture(compositor.output(),single_native_frames==0,started.elapsed().as_micros() as u64){single_packets.extend_from_slice(&packet[native::NATIVE_HEADER_LEN..]);single_native_frames+=1;}}
            }
        }}std::thread::sleep(Duration::from_millis(33).saturating_sub(began.elapsed()));
    }
    let single_shared=capture_broker::statistics();drop(single_encoder);drop(single_comp);drop(primary_single);std::fs::write(format!("{output}/{prefix}-single.h264"),&single_packets)?;
    let mut exclusion_samples=Vec::new();
    {
        let renderer=overlay::windows::RenderDevice::new()?;let aurora=overlay::aurora::Aurora::new(&renderer)?;let appearance=appearance::Appearance::preset("Expressive");
        let mut windows=snapshot.displays.iter().map(|d|overlay::windows::OverlayWindow::new(&renderer,d.rect())).collect::<Result<Vec<_>,_>>()?;
        for index in 0..30 {
            TICK.fetch_add(1,Ordering::Relaxed);for hwnd in &targets.0{let _=InvalidateRect(*hwnd,None,false);}pump();
            for(d,window)in snapshot.displays.iter().zip(&mut windows){let now=Instant::now();let notice=overlay::effects::Notice::new(None,now,3.).sample(now,3.,false);let p=overlay::aurora::Parameters::new(d.rect(),&appearance,window.dpi_scale(),index as f32/15.,1.,false,None,[0.,0.],&[],now);window.draw_animated(&aurora,&p,"Remote User",notice,&appearance)?;window.show()?;}
            std::thread::sleep(Duration::from_millis(20));let mut frame=combined.lock();
            if matches!(frame.grab_gpu(0,true),dxdupe::Grab::Frame{..}){
                let compositor=comp.as_mut().unwrap();if frame.render(compositor)&&readback.copy(frame.device(),frame.context(),compositor.output(),view.width,view.height){
                    let colors:Vec<_>=snapshot.displays.iter().map(|d|[(192,4),(d.width as i32/2,34),(d.width as i32/2,d.height as i32/2)].into_iter().map(|(x,y)|{let x=((d.x-view.source.x+x) as f64/view.source.width as f64*view.width as f64) as usize;let y=((d.y-view.source.y+y) as f64/view.source.height as f64*view.height as f64) as usize;let i=(y*view.width as usize+x)*4;readback.bytes[i..i+4].to_vec()}).collect::<Vec<_>>()).collect();exclusion_samples.push(colors);
                }
            }
        }
    }
    let excluded=exclusion_samples.len()>=10&&exclusion_samples.iter().all(|frame|frame.iter().enumerate().all(|(index,points)|points.iter().all(|p|if index%2==0{p[2].abs_diff(210)<=2&&p[1].abs_diff(35)<=2&&(p[0].abs_diff(35)<=2||p[0].abs_diff(95)<=2)}else{p[1].abs_diff(180)<=2&&p[0].abs_diff(55)<=2&&(p[2].abs_diff(35)<=2||p[2].abs_diff(95)<=2)})));
    let shared=capture_broker::statistics();
    combined.force_output_fallback(&snapshot.displays[1].id);let fallback_start=Instant::now();let mut fallback_count=0;
    while fallback_start.elapsed()<Duration::from_millis(400){pump();let mut frame=combined.lock();if matches!(frame.grab_gpu(0,true),dxdupe::Grab::Frame{..}){fallback_count+=1;}drop(frame);std::thread::sleep(Duration::from_millis(20));}
    let fallback=capture_broker::statistics();if !combined.prepare_recovery(&snapshot.displays[1].id){return Err("native recovery unavailable".into());}let prepared=capture_broker::statistics();let recovery_start=Instant::now();let mut recovered_frames=0;
    while recovery_start.elapsed()<Duration::from_millis(400){pump();let mut frame=combined.lock();if matches!(frame.grab_gpu(0,true),dxdupe::Grab::Frame{..}){recovered_frames+=1;}drop(frame);std::thread::sleep(Duration::from_millis(20));}
    let recovered=capture_broker::statistics();drop(encoder);drop(comp);drop(combined);drop(singles);let after_drop=capture_broker::statistics();
    std::fs::write(format!("{output}/{prefix}.h264"),&encoded)?;
    // Two real D3D devices per physical adapter exercise foreign texture transfer
    // and opposite-selection lock ordering on this single-adapter workstation.
    let mut left=view.clone();left.width=640;left.height=(view.height as f64*640./view.width as f64).round() as u32;
    let mut right=left.clone();right.selected_display_id=snapshot.displays[1].id.clone();
    let a=capture_surface::Surface::separate_devices(left).ok_or("separate-device A")?;let b=capture_surface::Surface::separate_devices(right).ok_or("separate-device B")?;
    let(tx,rx)=std::sync::mpsc::channel();let mut joins=Vec::new();
    for(mut surface,tx)in[(a,tx.clone()),(b,tx.clone())]{joins.push(std::thread::spawn(move||{
        let began=Instant::now();let mut frames=0;let mut correct=0;let mut comp=None;let mut read=gpu_transfer::Readback::default();let view=surface.view.clone();
        while began.elapsed()<Duration::from_secs(2){let mut frame=surface.lock();if matches!(frame.grab_gpu(0,true),dxdupe::Grab::Frame{..}){
            frames+=1;let compositor=comp.get_or_insert_with(||gpu::Compositor::new(frame.device(),frame.context(),view.width,view.height).unwrap());
            if frame.render(compositor)&&read.copy(frame.device(),frame.context(),compositor.output(),view.width,view.height){
                let points:Vec<_>=view.displays.iter().map(|d|{let x=((d.x-view.source.x+d.width as i32/2) as f64/view.source.width as f64*view.width as f64) as usize;let y=((d.y-view.source.y+d.height as i32/2) as f64/view.source.height as f64*view.height as f64) as usize;let i=(y*view.width as usize+x)*4;read.bytes[i..i+4].to_vec()}).collect();
                if points.len()>=2&&points[0][2]>150&&points[0][1]<80&&points[1][1]>130&&points[1][2]<120{correct+=1;}
            }
        }drop(frame);std::thread::sleep(Duration::from_millis(3));}
        let _=tx.send((frames,surface.cross_adapter_bytes,began.elapsed().as_secs_f64(),correct));
    }));}

    let first=rx.recv_timeout(Duration::from_secs(5)).map_err(|_|"opposite-selection lock timeout")?;let second=rx.recv_timeout(Duration::from_secs(5)).map_err(|_|"opposite-selection lock timeout")?;for join in joins{let _=join.join();}
    let after_concurrent=capture_broker::statistics();drop(targets);pump();
    let orientation=gpu_orientation_fixture(&snapshot.displays[0])?;
    let colored=samples.iter().filter(|p|p.len()>=2&&p[0][2]>150&&p[0][1]<80&&p[1][1]>130&&p[1][2]<120).count();
    let recovery_prepared=prepared.iter().find(|s|s.id==snapshot.displays[1].id).unwrap();let fallback_source=fallback.iter().find(|s|s.id==snapshot.displays[1].id).unwrap();
    let recovery_identity=recovery_prepared.source=="dxgi"&&!recovery_prepared.valid_image&&recovery_prepared.cursor_key!=fallback_source.cursor_key&&recovery_prepared.rotation==snapshot.displays[1].rotation;
    let result=serde_json::json!({"view":view,"frames":frames,"singleFrames":display_frames,"singleNative":{"view":single_view,"encodedFrames":single_native_frames,"shared":single_shared},"encodedFrames":encoded_frames,"encodedBytes":encoded.len(),"correctDistinctColorFrames":colored,"samples":samples,"compositionSubmitMs":compositions,"shared":shared,"oneRetainedSnapshotOneMoving":{"passed":frozen_progress,"before":frozen_before,"after":frozen_after,"continuedFrames":frames-frozen_frame_start,"scope":"Native test-only frozen retained GPU snapshot on one output; other output remains actual moving DXGI. This is not a physically static full desktop or encoder-idle proof. Freeze hooks are absent from production builds."},"animatedOverlayExcludedFromCombined":excluded,"animatedExclusionSamples":exclusion_samples,"fallbackFrames":fallback_count,"fallback":fallback,"preparedRecovery":prepared,"recoveryIdentityCorrectBeforeFirstFrame":recovery_identity,"recoveredFrames":recovered_frames,"recovered":recovered,"afterDrop":after_drop,"oppositeSelectionConcurrent":[first,second],"afterConcurrent":after_concurrent,"orientationAndForeignDevice":orientation,"foregroundUnchanged":GetForegroundWindow()==foreground,"limits":"Owned small paint targets, shipping broker/surface and native encoder in an isolated process. Separate-device fixture uses real devices on one physical adapter; different physical GPUs, portrait/mixed-DPI hardware and actual network clients remain unproved. No pointer/input injection."});
    std::fs::write(format!("{output}/{prefix}.json"),serde_json::to_vec_pretty(&result)?)?;println!("{result}");
    if frames<20||display_frames.iter().any(|n|*n<15)||single_native_frames<20||single_shared.iter().any(|s|s.acquisitions!=1)||colored<frames/2||!frozen_progress||shared.iter().any(|s|s.acquisitions!=1||s.consumers<2)||!after_drop.is_empty()||!excluded||fallback_count==0||recovered_frames==0||!recovery_identity||first.0==0||second.0==0||first.1==0||second.1==0||first.3==0||second.3==0||!after_concurrent.is_empty(){return Err("one or more combined gates failed".into());}Ok(())
}}

#[cfg(windows)]fn gpu_orientation_fixture(display:&display::DisplayInfo)->Result<serde_json::Value,Box<dyn std::error::Error>>{
    let binding=dxdupe::OutputBinding::find(display.x,display.y).ok_or("fixture binding")?;
    let(device,context)=binding.create_device().ok_or("fixture device")?;let(foreign_device,_)=binding.create_device().ok_or("foreign fixture device")?;
    let source=gpu_transfer::Texture::new(&device,8,4).ok_or("fixture texture")?;let mut bytes=Vec::new();let colors=[[0,0,220,255],[0,200,0,255],[210,0,0,255],[0,200,210,255]];
    for y in 0..4{for x in 0..8{bytes.extend_from_slice(&colors[(y/2)*2+x/4]);}}source.upload(&context,&bytes);
    let mut results=Vec::new();let mut all=true;
    for(rotation,expected)in[(0,[0,1,2,3]),(90,[2,0,3,1]),(180,[3,2,1,0]),(270,[1,3,0,2])]{
        let(w,h)=if rotation==90||rotation==270{(4,8)}else{(8,4)};let mut comp=gpu::Compositor::new(&device,&context,w,h).ok_or("rotation fixture compositor")?;
        if !comp.render_region(&source.srv,8,4,false,None,[0.,0.,w as f32,h as f32],rotation){return Err("rotation render failed".into());}
        let mut read=gpu_transfer::Readback::default();if !read.copy(&device,&context,comp.output(),w,h){return Err("rotation readback".into());}
        let actual:Vec<_>=[(w/4,h/4),(w*3/4,h/4),(w/4,h*3/4),(w*3/4,h*3/4)].into_iter().map(|(x,y)|{let i=(y*w+x) as usize*4;read.bytes[i..i+4].to_vec()}).collect();
        let passed=actual.iter().zip(expected).all(|(a,index)|a==&colors[index]);all&=passed;results.push(serde_json::json!({"rotation":rotation,"pixels":actual,"passed":passed}));
    }
    let foreign=gpu_transfer::Texture::new(&foreign_device,8,4).ok_or("foreign texture")?;let mut destination=gpu::Compositor::new(&device,&context,8,4).ok_or("foreign rejection destination")?;
    let rejected=!destination.render(&foreign.srv,8,4,false,None);if !all||!rejected{return Err("rotation/foreign resource gates failed".into());}
    // Retained, cursor-free foreign tile simulates an asynchronously delayed
    // background while a normal shape straddles and then crosses its seam.
    let scene=gpu_transfer::Texture::new(&device,32,16).ok_or("cursor scene")?;let mut background=Vec::new();for _ in 0..16{for x in 0..32{background.extend_from_slice(&colors[if x<16{0}else{1}]);}}scene.upload(&context,&background);
    let mut compositor=gpu::Compositor::new(&device,&context,32,16).ok_or("cursor scene compositor")?;let mut read=gpu_transfer::Readback::default();
    let cursor=dxdupe::CursorImage{px:vec![255;6*4*4],w:6,h:4,x:0,y:0,masked:false};
    let pixel=|bytes:&[u8],x:usize,y:usize|bytes[(y*32+x)*4..(y*32+x+1)*4].to_vec();
    compositor.render_scene_cursor(&scene.srv,32,16,Some((&cursor,101,[14./32.,6./16.,6./32.,4./16.])));read.copy(&device,&context,compositor.output(),32,16);
    let straddle=pixel(&read.bytes,15,7)==[255,255,255,255]&&pixel(&read.bytes,17,7)==[255,255,255,255];
    compositor.render_scene_cursor(&scene.srv,32,16,Some((&cursor,101,[18./32.,6./16.,6./32.,4./16.])));read.copy(&device,&context,compositor.output(),32,16);
    let lag_clear=pixel(&read.bytes,15,7)==colors[0]&&pixel(&read.bytes,17,7)==colors[1]&&pixel(&read.bytes,20,7)==[255,255,255,255];
    let masked=dxdupe::CursorImage{masked:true,..cursor};compositor.render_scene_cursor(&scene.srv,32,16,Some((&masked,102,[14./32.,6./16.,6./32.,4./16.])));read.copy(&device,&context,compositor.output(),32,16);
    let masked_straddle=pixel(&read.bytes,15,7)==[255,255,35,255]&&pixel(&read.bytes,17,7)==[255,55,255,255];
    if !straddle||!lag_clear||!masked_straddle{return Err("single cursor seam/lag fixture failed".into());}
    let mut ring=gpu_transfer::AsyncReadback::default();let queued_first=ring.submit(&device,&context,&scene.texture,32,16,1);let queued_second=ring.submit(&device,&context,&scene.texture,32,16,2);let bounded=!ring.submit(&device,&context,&scene.texture,32,16,3);
    let deadline=std::time::Instant::now()+std::time::Duration::from_secs(1);while ring.pending()&&std::time::Instant::now()<deadline{ring.poll(&context);std::thread::sleep(std::time::Duration::from_millis(1));}
    let mut capacity=0;for sequence in 4..14{ring.submit(&device,&context,&scene.texture,32,16,sequence);let deadline=std::time::Instant::now()+std::time::Duration::from_secs(1);while ring.pending()&&std::time::Instant::now()<deadline{ring.poll(&context);std::thread::sleep(std::time::Duration::from_millis(1));}if sequence==7{capacity=ring.allocated_cpu_bytes();}}
    let reused=capacity==ring.allocated_cpu_bytes()&&ring.bytes==background;let ring_pass=queued_first&&queued_second&&bounded&&ring.dropped==1&&!ring.pending()&&ring.ready_sequence==13&&reused;
    if !ring_pass{return Err("bounded transfer ring fixture failed".into());}
    Ok(serde_json::json!({"rotations":results,"foreignSrvRejected":rejected,"transferRing":{"passed":ring_pass,"submitted":ring.submitted,"dropped":ring.dropped,"reusedCpuCapacity":ring.allocated_cpu_bytes(),"slots":2},"cursorSeam":{"fullShapeStraddles":straddle,"oldForeignTileHasNoGhost":lag_clear,"maskedIBeamOperationSpansSeam":masked_straddle,"scope":"Injected native GPU cursor images; actual OS pointer was not moved. CPU/JPEG and NVENC both use this same final compositor pass."}}))
}
