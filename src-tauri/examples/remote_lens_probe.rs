//! Viewing-area lens: renders the real overlay shader + label offscreen and
//! composites it over a backdrop. No app, database, network or live overlay.
//! `cargo run --example remote_lens_probe -- <out dir> [backdrop.png] [--video]`
#[path="../src/remote/display.rs"]mod display;
#[path="../src/remote/appearance.rs"]mod appearance;
#[path="../src/remote/overlay/mod.rs"]mod overlay;
#[path="../src/remote/dxdupe.rs"]mod dxdupe;
#[path="../src/remote/gpusched.rs"]mod gpusched;
mod hostproc {pub fn is_remote_host()->bool{false}}
#[cfg(windows)]fn main(){if let Err(e)=run(){eprintln!("lens probe failed: {e}");std::process::exit(1);}}
#[cfg(not(windows))]fn main(){eprintln!("Windows required");}
#[cfg(windows)]fn run()->Result<(),Box<dyn std::error::Error>> {
    use std::time::{Duration,Instant};
    use overlay::{windows::{RenderDevice,OverlayWindow},aurora::{Aurora,Parameters},effects::{Lens,Notice}};
    let args:Vec<String>=std::env::args().skip(1).collect();
    let output=args.first().cloned().unwrap_or_else(||"docs/remote-implementation/evidence".into());std::fs::create_dir_all(&output)?;
    let backdrop=args.iter().skip(1).find(|a|a.ends_with(".png")).map(|p|image::open(p).map(|i|i.resize_exact(1920,1080,image::imageops::FilterType::Triangle).to_rgb8())).transpose()?;
    let device=RenderDevice::new()?;let aurora=Aurora::new(&device)?;let start=Instant::now();
    let rect=display::PhysicalRect{x:0,y:0,width:1920,height:1080};let mut window=OverlayWindow::new(&device,rect)?;
    let compact=Notice::new(Some(start-Duration::from_secs(30)),start,3.).sample(start,3.,false);
    let mut render=|a:&appearance::Appearance,lenses:&[Lens],ride:Option<([f32;4],f32)>,phase:f32,file:&str|->Result<(f32,usize),Box<dyn std::error::Error>> {
        let mut p=Parameters::new(rect,a,1.,phase,1.,false,None,[0.,0.],&[],start);p.set_lenses(lenses,a,1.);window.set_label_anchor(ride);
        let began=Instant::now();window.draw_animated_unpresented(&aurora,&p,"Abi",compact,a)?;let (w,h,bytes)=window.export_pixels()?;
        let ms=began.elapsed().as_secs_f32()*1000.;let painted=bytes.chunks_exact(4).filter(|p|p[3]>0).count();
        if !file.is_empty() {composite(&format!("{output}/{file}"),w,h,&bytes,backdrop.as_ref())?;}Ok((ms,painted))
    };
    let still=|r:[f32;4],energy:f32|{let mut l=Lens::new("a",r,true);l.energy=energy;l};
    let zoomed=[620.,300.,760.,428.];let mut report=Vec::new();
    for preset in ["Subtle","Balanced","Expressive"] {
        let a=appearance::Appearance::preset(preset);
        for (state,energy) in [("resting",0.),("moving",1.)] {
            let file=format!("lens-{preset}-{state}.png");let (ms,painted)=render(&a,&[still(zoomed,energy)],Some((zoomed,1.)),2.,&file)?;
            report.push(serde_json::json!({"file":file,"renderMs":ms,"paintedPixels":painted}));
        }
    }
    let a=appearance::Appearance::default();
    let top=[400.,20.,1000.,560.];render(&a,&[still(top,0.)],Some((top,1.)),2.,"lens-label-tucked.png")?;
    render(&a,&[still([140.,180.,700.,394.],0.),still([1080.,520.,640.,360.],0.3)],None,2.,"lens-two-viewers.png")?;
    let (_,none)=render(&a,&[],None,2.,"")?;let (_,one)=render(&a,&[still(zoomed,0.)],Some((zoomed,1.)),2.,"")?;
    report.push(serde_json::json!({"paintedWithoutLens":none,"paintedWithLens":one}));
    if args.iter().any(|a|a=="--video") {
        use std::{io::Write,process::{Command,Stdio}};
        let mut encoder=Command::new("ffmpeg").args(["-y","-loglevel","error","-f","rawvideo","-pixel_format","rgb24","-video_size","1920x1080","-framerate","60","-i","pipe:0","-an","-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p"])
            .arg(format!("{output}/lens-glide.mp4")).stdin(Stdio::piped()).spawn()?;
        let mut input=encoder.stdin.take().ok_or("encoder stdin unavailable")?;
        // A phone session: zoom in, pan right in 66 ms reports, rest, pinch out.
        let mut lenses:Vec<Lens>=Vec::new();let mut ride=(zoomed,0_f32);let dt=1./60.;
        for frame in 0..420 {
            let t=frame as f32*dt;
            let target=if t<0.4 {None} else if t<2.0 {Some(zoomed)} else if t<3.4 {let k=((t-2.0)/1.4).min(1.);let k=(k*15.).floor()/15.;Some([620.+k*520.,300.-k*160.,760.,428.])} else if t<6.0 {Some([1140.,140.,760.,428.])} else {None};
            overlay::effects::sync_lenses(&mut lenses,&target.map(|r|vec![("a".to_string(),r)]).unwrap_or_default(),false);
            for l in &mut lenses {l.step(dt,false);}lenses.retain(|l|!l.gone());
            let lone=lenses.len()==1&&!lenses[0].leaving;if lone {ride.0=lenses[0].current;}ride.1+=((if lone{1.}else{0.})-ride.1)*(1.-(-dt/0.22_f32).exp());
            let mut p=Parameters::new(rect,&a,1.,t*a.number("aurora.speed"),1.,false,None,[0.,0.],&[],start);p.set_lenses(&lenses,&a,1.);window.set_label_anchor(Some(ride).filter(|r|r.1>0.002));
            window.draw_animated_unpresented(&aurora,&p,"Abi",compact,&a)?;let (_,_,bytes)=window.export_pixels()?;
            input.write_all(&blend(&bytes,backdrop.as_ref(),[22,27,38]))?;
        }
        drop(input);encoder.wait()?;
    }
    std::fs::write(format!("{output}/lens-probe.json"),serde_json::to_vec_pretty(&report)?)?;
    println!("{}",serde_json::to_string_pretty(&report)?);Ok(())
}
#[cfg(windows)]fn blend(bgra:&[u8],backdrop:Option<&image::RgbImage>,fallback:[u8;3])->Vec<u8> {
    let mut out=Vec::with_capacity(bgra.len()/4*3);
    for (i,p) in bgra.chunks_exact(4).enumerate() {
        let bg=backdrop.map(|b|b.as_raw()[i*3..i*3+3].try_into().unwrap()).unwrap_or(fallback);
        for (source,bg) in [p[2],p[1],p[0]].into_iter().zip(bg) {out.push((source as u32+(bg as u32*(255-p[3] as u32)+127)/255).min(255) as u8);}
    }out
}
#[cfg(windows)]fn composite(path:&str,w:u32,h:u32,bgra:&[u8],backdrop:Option<&image::RgbImage>)->Result<(),image::ImageError> {
    image::save_buffer(path,&blend(bgra,backdrop,[22,27,38]),w,h,image::ColorType::Rgb8)
}
