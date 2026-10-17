//! Native renderer exports and matched overlay/capture measurements. No pointer
//! injection, no app/database/network startup, and no live service changes.
#[path="../src/remote/display.rs"]mod display;
#[path="../src/remote/appearance.rs"]mod appearance;
#[path="../src/remote/overlay/mod.rs"]mod overlay;
#[path="../src/remote/dxdupe.rs"]mod dxdupe;
#[path="../src/remote/gpusched.rs"]mod gpusched;
mod hostproc {pub fn is_remote_host()->bool{false}}
#[cfg(windows)]fn main(){if let Err(e)=run(){eprintln!("visual probe failed: {e}");std::process::exit(1);}}
#[cfg(not(windows))]fn main(){eprintln!("Windows required");}
#[cfg(windows)]fn run()->Result<(),Box<dyn std::error::Error>> {
    use std::time::{Duration,Instant};
    use overlay::{windows::{RenderDevice,OverlayWindow,pump_messages},aurora::{Aurora,Parameters},effects::{Notice,Reaction}};
    let output=std::env::args().nth(1).unwrap_or_else(||"docs/remote-implementation/evidence".into());std::fs::create_dir_all(&output)?;
    let device=RenderDevice::new()?;let aurora=Aurora::new(&device)?;let start=Instant::now();
    let rect=display::PhysicalRect{x:0,y:0,width:1920,height:1080};let mut window=OverlayWindow::new(&device,rect)?;let mut exports=Vec::new();
    for preset in ["Subtle","Balanced","Expressive"] {
        let a=appearance::Appearance::preset(preset);
        for (ms,label) in [(200,"arrival"),(1800,"announcement"),(3600,"settling"),(4200,"compact")] {
            let now=start+Duration::from_millis(ms);let notice=Notice::new(Some(start),start,3.).sample(now,3.,false);
            let click=Reaction{session_id:"preview-only".into(),x:1350,y:700,at:now-Duration::from_millis(180)};
            let p=Parameters::new(rect,&a,1.,ms as f32/1000.*a.number("aurora.speed"),notice.opacity,false,Some((1350,700)),[500.,-20.],&[click],now);
            let began=Instant::now();window.draw_animated_unpresented(&aurora,&p,"Remote User",notice,&a)?;let (w,h,bytes)=window.export_pixels()?;
            let elapsed=began.elapsed().as_secs_f32()*1000.;let count=bytes.chunks_exact(4).filter(|p|p[3]>0).count();
            let center_alpha=bytes[(540*1920+960)*4+3];let name=format!("stage-e-native-{preset}-{label}.png");save_png(&format!("{output}/{name}"),w,h,bytes)?;
            exports.push(serde_json::json!({"file":name,"preset":preset,"noticeState":format!("{:?}",notice.state),"coloredPixels":count,"centerAlpha":center_alpha,"renderAndSynchronousExportMs":elapsed}));
        }
    }
    let mut zero=serde_json::to_value(appearance::Appearance::default())?;zero["intensity"]=0.into();let zero=appearance::Appearance::validate(&zero);
    let now=start+Duration::from_secs(10);let notice=Notice::new(Some(start),start,3.).sample(now,3.,true);
    let p=Parameters::new(rect,&zero,1.,0.,1.,true,None,[0.,0.],&[],now);window.draw_animated_unpresented(&aurora,&p,"அருள்",notice,&zero)?;
    let (w,h,bytes)=window.export_pixels()?;let label_pixels=bytes.chunks_exact(4).filter(|p|p[3]>0).count();let zero_edge=bytes[(540*1920+2)*4+3];save_png(&format!("{output}/stage-e-native-zero-intensity.png"),w,h,bytes)?;
    let mut measure=serde_json::Value::Null;
    if std::env::args().any(|s|s=="--video") {
        use std::{io::Write,process::{Command,Stdio}};
        let video_rect=display::PhysicalRect{x:0,y:0,width:1280,height:720};let mut video=OverlayWindow::new(&device,video_rect)?;let a=appearance::Appearance::preset("Balanced");
        let mut encoder=Command::new("ffmpeg").args(["-y","-loglevel","error","-f","rawvideo","-pixel_format","rgb24","-video_size","1280x720","-framerate","30","-i","pipe:0","-an","-c:v","libx264","-preset","veryfast","-crf","16","-pix_fmt","yuv420p"])
            .arg(format!("{output}/stage-e-native-motion-preview.mp4")).stdin(Stdio::piped()).spawn()?;
        let mut input=encoder.stdin.take().ok_or("video encoder stdin unavailable")?;
        for frame in 0..180 {
            let seconds=frame as f32/30.;let now=start+Duration::from_secs_f32(seconds);let cursor=(900+(seconds*2.).sin().mul_add(80.,0.) as i32,490+(seconds*1.2).cos().mul_add(60.,0.) as i32);
            let reactions=if seconds>1.&&seconds<1.7{vec![Reaction{session_id:"preview-only".into(),x:900+(2_f32.sin()*80.) as i32,y:490+(1.2_f32.cos()*60.) as i32,at:start+Duration::from_secs(1)}]}else{Vec::new()};
            let notice=Notice::new(Some(start),start,3.).sample(now,3.,false);let p=Parameters::new(video_rect,&a,1.,seconds*a.number("aurora.speed"),notice.opacity,false,Some(cursor),[50.,20.],&reactions,now);
            video.draw_animated_unpresented(&aurora,&p,"Remote User",notice,&a)?;let(_,_,pixels)=video.export_pixels()?;
            let bg=if frame<90{[22_u8,27,38]}else{[238_u8,240,245]};let mut rgb=Vec::with_capacity(1280*720*3);
            for p in pixels.chunks_exact(4){for(source,bg)in[p[2],p[1],p[0]].into_iter().zip(bg){rgb.push((source as u32+(bg as u32*(255-p[3] as u32)+127)/255).min(255) as u8);}}
            input.write_all(&rgb)?;
        }
        drop(input);if !encoder.wait()?.success(){return Err("preview video encode failed".into());}
    }
    if std::env::args().any(|s|s=="--measure") {
        drop(window);
        let topology=display::snapshot();let d=topology.displays.iter().find(|d|d.is_primary).ok_or("primary display missing")?;
        let mut capture=dxdupe::Duplicator::new_for(d.x,d.y).ok_or("DXGI ownership unavailable")?;
        let mut actual=OverlayWindow::new(&device,d.rect())?;let a=appearance::Appearance::default();
        let mut scenarios=Vec::new();
        for enabled in [false,true,false] {
            if !enabled{actual.hide();}
            let began=Instant::now();let mut frames=0_u32;let mut equal=0_u32;let mut changed=0_u32;let mut previous=Vec::new();let mut render=Vec::new();let mut grabs=Vec::new();
            while began.elapsed()<Duration::from_secs(4) {
                let tick=Instant::now();
                if enabled {
                    let notice=Notice::new(None,tick,3.).sample(tick,3.,false);
                    let p=Parameters::new(d.rect(),&a,actual.dpi_scale(),began.elapsed().as_secs_f32()*a.number("aurora.speed"),1.,false,None,[0.,0.],&[],tick);
                    let r=Instant::now();actual.draw_animated(&aurora,&p,"Remote User",notice,&a)?;actual.show()?;render.push(r.elapsed().as_secs_f64()*1000.);
                }
                // Read actual underlying captured pixels at output-sized 1920w.
                // No dirty-region mask or overlay-area exclusion is used.
                let g=Instant::now();if let dxdupe::Grab::Frame{..}=capture.grab(0,1920) {
                    frames+=1;let pixels=capture.buffer();if previous==pixels {equal+=1;}else{changed+=1;previous.clear();previous.extend_from_slice(pixels);}
                }grabs.push(g.elapsed().as_secs_f64()*1000.);pump_messages();
                if let Some(remaining)=Duration::from_millis(33).checked_sub(tick.elapsed()){std::thread::sleep(remaining);}
            }
            scenarios.push(serde_json::json!({"overlayEnabled":enabled,"seconds":began.elapsed().as_secs_f64(),"dxgiFrames":frames,"pixelChangedFrames":changed,"identicalPixelFrames":equal,"renderSubmitAndPresentP50Ms":percentile(&render,0.5),"renderSubmitAndPresentP95Ms":percentile(&render,0.95),"captureReadbackP50Ms":percentile(&grabs,0.5),"captureReadbackP95Ms":percentile(&grabs,0.95)}));
        }
        measure=serde_json::json!({"display":d,"scenarios":scenarios,"limits":"Underlying normal workstation content was not frozen. Exact pixel comparison is at 1920w output, not a live encoder/client test. Render timing includes submission/Present, not GPU timestamp duration."});
    }
    let result=serde_json::json!({"exports":exports,"zeroIntensity":{"labelPixels":label_pixels,"edgeAlpha":zero_edge},"measure":measure,"limits":"Native GPU exports are unpremultiplied for PNG inspection. They do not prove physical local visibility. No OS cursor was moved or replaced."});
    std::fs::write(format!("{output}/stage-e-native-visual-probe.json"),serde_json::to_vec_pretty(&result)?)?;println!("{result}");
    if label_pixels==0||zero_edge!=0||result["exports"].as_array().unwrap().iter().any(|e|e["centerAlpha"]!=0||e["coloredPixels"].as_u64().unwrap_or(0)<1000) {return Err("native export pixel gates failed".into());}Ok(())
}
fn save_png(path:&str,w:u32,h:u32,mut bytes:Vec<u8>)->Result<(),image::ImageError>{
    // Opaque diagnostic composites make very-low-alpha pixels assessable even
    // in viewers that display transparent RGB without a checkerboard/backdrop.
    for (suffix,background) in [("dark",[22_u8,27,38]),("light",[238_u8,240,245])] {
        let mut composite=Vec::with_capacity(w as usize*h as usize*3);
        for p in bytes.chunks_exact(4){for (source,bg)in[p[2],p[1],p[0]].into_iter().zip(background){composite.push((source as u32+(bg as u32*(255-p[3] as u32)+127)/255).min(255) as u8);}}
        image::save_buffer(path.replace(".png",&format!("-{suffix}.png")),&composite,w,h,image::ColorType::Rgb8)?;
    }
    for p in bytes.chunks_exact_mut(4){p.swap(0,2);if p[3]>0{for i in 0..3{p[i]=((p[i] as u32*255+p[3] as u32/2)/p[3] as u32).min(255) as u8;}}}
    image::save_buffer(path,&bytes,w,h,image::ColorType::Rgba8)
}
fn percentile(samples:&[f64],q:f64)->f64 {if samples.is_empty(){return 0.;}let mut sorted=samples.to_vec();sorted.sort_by(f64::total_cmp);sorted[((sorted.len()-1) as f64*q).round() as usize]}
