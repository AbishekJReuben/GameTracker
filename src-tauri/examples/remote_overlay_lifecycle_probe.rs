//! Exercise the shipping presence/watchdog/manager boundary without starting the
//! app, its database, network, updater, or input injector. Never moves the cursor.
#[path="../src/remote/display.rs"] mod display;
#[path="../src/remote/appearance.rs"] mod appearance;
#[path="../src/remote/view.rs"] mod view;
#[path="../src/remote/view_session.rs"]mod view_session;
#[path="../src/remote/input_mapping.rs"]mod input_mapping;
#[cfg(test)]#[path="../src/remote/delivery.rs"]mod delivery;
#[path="../src/remote/presence.rs"] mod presence;
#[path="../src/remote/overlay/mod.rs"] mod overlay;
mod hostproc {
    pub static HOST:std::sync::atomic::AtomicBool=std::sync::atomic::AtomicBool::new(false);
    pub fn is_remote_host()->bool {HOST.load(std::sync::atomic::Ordering::SeqCst)}
}
mod capture {
    pub fn set_view_identity(_:Option<std::sync::Arc<super::view::CaptureIdentity>>){}
    pub static SELECTED:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
    pub fn selected_monitor()->usize {SELECTED.load(std::sync::atomic::Ordering::SeqCst)}
}
mod input{pub fn release_session(_: &str){}}
#[cfg(windows)]fn main() {
    if let Err(error)=run(){eprintln!("overlay lifecycle probe failed: {error}");std::process::exit(1);}
}
#[cfg(not(windows))]fn main(){eprintln!("Windows required");}
#[cfg(windows)]fn run()->Result<(),Box<dyn std::error::Error>> {
    use std::{sync::atomic::Ordering,time::{Duration,Instant}};
    struct Cleanup;impl Drop for Cleanup {fn drop(&mut self){overlay::shutdown();}}
    let _cleanup=Cleanup;
    fn wait_for(windows:usize)->bool {
        let deadline=Instant::now()+Duration::from_secs(3);
        while Instant::now()<deadline {if overlay::snapshot().windows==windows{return true;}std::thread::sleep(Duration::from_millis(10));}false
    }
    fn update(h:&presence::Handshake,sequence:u64,visible:bool,name:&str)->presence::PresenceUpdate {
        presence::PresenceUpdate{sequence,display_name:name.into(),control_visible:visible,pip_visible:false,immersive_visible:false,mode:h.view.mode,view_epoch:h.view.epoch,selected_display_id:h.view.selected_display_id.clone(),visible_display_ids:h.view.displays.iter().map(|d|d.id.clone()).collect(),appearance:serde_json::Value::Null}
    }
    let mut checks=Vec::new();
    let mut check=|name:&str,passed:bool| {checks.push(serde_json::json!({"name":name,"passed":passed}));};
    check("main process cannot start manager",!overlay::prepare()&&overlay::snapshot().render_thread_id==0);
    hostproc::HOST.store(true,Ordering::SeqCst);
    let caps=presence::CAPABILITIES.iter().map(|s|(*s).into()).collect::<Vec<_>>();
    let h=presence::authorize("probe-a","probe-device","Remote User",&caps,None).ok_or("authorization unavailable")?;
    check("renderer available in isolated remote-host role",h.overlay_available);
    check("authorization alone creates no window",overlay::snapshot().windows==0);
    check("unknown session cannot create presence",!presence::update("pending",update(&h,1,true,"Pending"))&&overlay::snapshot().windows==0);
    check("visible authorized control creates one window",presence::update("probe-a",update(&h,1,true,"Remote User"))&&wait_for(1));
    let owned=overlay::snapshot();
    let thread=unsafe{windows::Win32::System::Threading::GetCurrentThreadId()};
    let owner_matches=owned.handles.iter().all(|raw|unsafe{
        let mut pid=0;let owner=windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(windows::Win32::Foundation::HWND(*raw as *mut _),Some(&mut pid));
        pid==std::process::id()&&owner==owned.render_thread_id&&owner!=thread
    });
    check("real HWND belongs to dedicated render thread in same process",owner_matches&&!owned.handles.is_empty());
    check("duplicate authorization is idempotent",presence::authorize("probe-a","probe-device","Ignored duplicate",&caps,None).is_some()&&wait_for(1));
    check("name changes live without another window",presence::update("probe-a",update(&h,2,true,"அருள்"))&&wait_for(1));
    let aux=if display::snapshot().displays.len()>1 {
        let second=presence::authorize("probe-aux","probe-device","Remote User",&caps,Some(1)).ok_or("aux authorization unavailable")?;
        check("two viewed displays create two concurrent windows",presence::update("probe-aux",update(&second,1,true,"Remote User"))&&wait_for(2));
        let both=overlay::snapshot();
        check("every display HWND has the same isolated render owner",both.handles.len()==2&&both.handles.iter().all(|raw|unsafe{
            let mut pid=0;let owner=windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(windows::Win32::Foundation::HWND(*raw as *mut _),Some(&mut pid));owner==both.render_thread_id&&pid==std::process::id()
        }));Some(second)
    }else{None};
    // Supersede while the first Control is visible; its queued updates/cleanup
    // must not remove or repaint the successor's HWND.
    let successor=presence::authorize("probe-b","probe-device","Remote User",&caps,None).ok_or("replacement unavailable")?;
    check("retired peer cannot publish",!presence::update("probe-a",update(&h,3,true,"Old peer")));
    let active_count=if aux.is_some(){2}else{1};
    check("successor becomes visible",presence::update("probe-b",update(&successor,1,true,"Remote User"))&&wait_for(active_count));
    presence::end("probe-a",true);check("old cleanup cannot remove successor",wait_for(active_count));
    // Native watchdog, not JS, must fail closed on legacy selected-output changes.
    if display::snapshot().displays.len()>1 {
        capture::SELECTED.store(1,Ordering::SeqCst);
        check("legacy monitor mismatch hides only stale primary view",wait_for(1));
        capture::SELECTED.store(0,Ordering::SeqCst);
        check("valid authoritative output can resume",presence::update("probe-b",update(&successor,2,true,"Remote User"))&&wait_for(active_count));
    }
    if aux.is_some(){presence::end("probe-aux",true);check("auxiliary disconnect keeps primary display",wait_for(1));}
    check("client leaving Control destroys the HWND",presence::update("probe-b",update(&successor,3,false,"Remote User"))&&wait_for(0));
    std::thread::sleep(Duration::from_millis(350));let idle=overlay::snapshot();
    std::thread::sleep(Duration::from_millis(550));let after_idle=overlay::snapshot();
    check("absent presence performs no rendering or wakeups",idle.rendered_frames==after_idle.rendered_frames&&idle.wakeups==after_idle.wakeups);
    check("same authorization revives after hiding",presence::update("probe-b",update(&successor,4,true,"Remote User"))&&wait_for(1));
    std::thread::sleep(Duration::from_millis(presence::PRESENCE_TTL_MS+400));
    check("native watchdog removes stalled renderer presence",wait_for(0));
    check("expired visibility can resume without reauthorization",presence::update("probe-b",update(&successor,5,true,"Remote User"))&&wait_for(1));
    presence::end("probe-b",true);check("explicit disconnect destroys the HWND",wait_for(0));
    let static_view=presence::authorize("probe-static","static-device","Remote User",&caps,None).ok_or("static authorization unavailable")?;
    let mut static_update=update(&static_view,1,true,"Remote User");static_update.appearance=serde_json::json!({"aurora":{"speed":0},"halo":{"enabled":false},"ripples":{"duration":0.2},"label":{"announcementSeconds":1}});
    check("static compact scene starts",presence::update("probe-static",static_update)&&wait_for(1));std::thread::sleep(Duration::from_millis(2050));
    let d=&static_view.view.displays[0];overlay::reaction("probe-static",d.x+d.width as i32/2,d.y+d.height as i32/2);
    let deadline=Instant::now()+Duration::from_millis(180);while overlay::snapshot().painted_reactions==0&&Instant::now()<deadline {std::thread::sleep(Duration::from_millis(2));}
    check("short ripple actually reaches static native renderer",overlay::snapshot().painted_reactions>0);
    std::thread::sleep(Duration::from_millis(500));let cleared=overlay::snapshot();
    check("expired last ripple receives a clearing presentation",cleared.painted_reactions==0);
    std::thread::sleep(Duration::from_millis(350));check("static scene idles again after clearing",overlay::snapshot().rendered_frames==cleared.rendered_frames);
    let before_edit=overlay::snapshot().rendered_frames;
    let mut disable=update(&static_view,2,true,"Remote User");disable.appearance=serde_json::json!({"intensity":0,"aurora":{"speed":0},"halo":{"enabled":false},"ripples":{"enabled":false},"motion":"reduce"});
    check("live static compact edit is accepted",presence::update("probe-static",disable));
    std::thread::sleep(Duration::from_millis(1700));let after_edit=overlay::snapshot();
    check("static edit paints through coefficient convergence",after_edit.rendered_frames>before_edit+5);
    std::thread::sleep(Duration::from_millis(400));check("zero intensity reduced scene idles after final presentation",overlay::snapshot().rendered_frames==after_edit.rendered_frames);
    presence::end("probe-static",true);check("static probe session ends cleanly",wait_for(0));
    // An actual invalid swap-chain/window request must be hidden and publicly
    // reported per display, rather than leaving a stale green availability bit.
    let mut invalid=display::snapshot().displays[0].clone();invalid.id="invalid-probe-display".into();invalid.width=0;
    overlay::refresh(vec![overlay::OverlayDisplay{display:invalid.clone(),names:vec!["Remote User".into()],appearance:Default::default(),session_ids:vec!["probe-fault".into()],announcement_at:None,announcement_seconds:3.}]);
    let deadline=Instant::now()+Duration::from_millis(200);let mut failure=overlay::status();
    while !failure.degraded&&Instant::now()<deadline {std::thread::sleep(Duration::from_millis(2));failure=overlay::status();}
    check("real window failure is hidden and exposed per display",failure.degraded&&failure.failed_displays.contains_key("invalid-probe-display")&&failure.active_display_ids.is_empty()&&overlay::snapshot().windows==0);
    invalid.width=display::snapshot().displays[0].width;
    overlay::refresh(vec![overlay::OverlayDisplay{display:invalid,names:vec!["Remote User".into()],appearance:Default::default(),session_ids:vec!["probe-fault".into()],announcement_at:None,announcement_seconds:3.}]);
    let deadline=Instant::now()+Duration::from_millis(200);let mut recovered=overlay::status();
    while (recovered.degraded||recovered.active_display_ids.is_empty())&&Instant::now()<deadline {std::thread::sleep(Duration::from_millis(2));recovered=overlay::status();}
    check("same display recovers truthful availability in one scene update",recovered.available&&!recovered.degraded&&recovered.failed_displays.is_empty()&&recovered.message.is_none()&&recovered.active_display_ids==vec!["invalid-probe-display".to_string()]);
    overlay::refresh(Vec::new());
    overlay::shutdown();let stopped=overlay::snapshot();
    check("shutdown joins renderer and owns no HWND",stopped.stopped&&stopped.windows==0&&stopped.handles.is_empty());
    let result=serde_json::json!({"checks":checks,"active":owned,"idle":idle,"afterIdle":after_idle,"stopped":stopped,"windowFailureStatus":failure,"windowRecoveredStatus":recovered,"limits":"Isolated process imports shipping presence/manager/window modules. No live app restart, client frame-view exchange, mixed-DPI change, physical desktop observation, or real network reconnect is proved."});
    let output=std::env::args().nth(1).unwrap_or_else(||"docs/remote-implementation/evidence".into());
    let prefix=std::env::args().nth(2).unwrap_or_else(||"stage-d-overlay-lifecycle".into());
    if !prefix.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){return Err("invalid evidence prefix".into());}
    std::fs::create_dir_all(&output)?;std::fs::write(format!("{output}/{prefix}.json"),serde_json::to_vec_pretty(&result)?)?;
    println!("{result}");
    if result["checks"].as_array().unwrap().iter().any(|c|c["passed"]!=true) {return Err("one or more lifecycle gates failed".into());}Ok(())
}
