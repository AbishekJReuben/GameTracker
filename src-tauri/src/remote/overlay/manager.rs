//! A single-slot latest-wins mailbox bounds work from presence updates. There is
//! no renderer timer or GPU work while no authorized display is visible.
use std::{collections::{HashMap,VecDeque},sync::{Arc,OnceLock},thread::JoinHandle,time::{Duration,Instant}};
use parking_lot::{Condvar,Mutex};
use serde::Serialize;
use super::{OverlayDisplay,windows::{OverlayWindow,RenderDevice,pump_messages},aurora::{Aurora,Parameters},effects::{Notice,NoticeState,Reaction,MotionPolicy,retain_reactions}};
#[cfg(test)]use super::super::display::DisplayInfo;

#[derive(Clone,Debug,Default,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Statistics {
    pub available:bool,pub stopped:bool,pub windows:usize,pub handles:Vec<usize>,
    pub render_thread_id:u32,pub process_id:u32,pub rendered_frames:u64,pub scene_updates:u64,
    pub wakeups:u64,pub error:Option<String>,
    pub failed_displays:HashMap<String,String>,pub last_render_ms:f32,pub quality_fps:u32,
    pub active_display_ids:Vec<String>,
    pub painted_reactions:usize,
}
#[derive(Default)]
struct Mailbox {pending:Option<Vec<OverlayDisplay>>,last:Vec<OverlayDisplay>,reactions:VecDeque<Reaction>,stop:bool,ready:Option<bool>}
#[derive(Default)]
struct Shared {mailbox:Mutex<Mailbox>,changed:Condvar,stats:Mutex<Statistics>}
struct Manager {shared:Arc<Shared>,thread:Mutex<Option<JoinHandle<()>>>}
static MANAGER:OnceLock<Option<Manager>>=OnceLock::new();

impl Manager {
    fn start()->Option<Self> {
        let shared=Arc::new(Shared::default());let worker=shared.clone();
        let thread=std::thread::Builder::new().name("remote-desktop-overlay".into()).spawn(move||{
            // An unwind destroys every owned window/resource on this same thread.
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||run(&worker)));
            if result.is_err() {worker.stats.lock().error=Some("Overlay renderer stopped unexpectedly".into());}
            let mut mailbox=worker.mailbox.lock();mailbox.ready=Some(false);worker.changed.notify_all();
            let mut stats=worker.stats.lock();stats.available=false;stats.stopped=true;stats.windows=0;stats.handles.clear();stats.active_display_ids.clear();
        }).ok()?;
        Some(Self {shared,thread:Mutex::new(Some(thread))})
    }
    fn ready(&self)->bool {
        let deadline=Instant::now()+Duration::from_secs(3);let mut state=self.shared.mailbox.lock();
        while state.ready.is_none() {
            if self.shared.changed.wait_until(&mut state,deadline).timed_out() {return false;}
        }
        state.ready==Some(true)
    }
    fn refresh(&self,scene:Vec<OverlayDisplay>) {
        let mut state=self.shared.mailbox.lock();
        if state.stop||state.last==scene {return;}
        state.last=scene.clone();state.pending=Some(scene);self.shared.changed.notify_one();
    }
    fn stop(&self) {
        {let mut state=self.shared.mailbox.lock();state.stop=true;self.shared.changed.notify_all();}
        if let Some(thread)=self.thread.lock().take() {let _=thread.join();}
    }
}
pub(super) fn prepare()->bool {MANAGER.get_or_init(Manager::start).as_ref().map(Manager::ready).unwrap_or(false)}
pub(super) fn refresh(scene:Vec<OverlayDisplay>) {if let Some(Some(manager))=MANAGER.get(){manager.refresh(scene);}}
pub(super) fn shutdown() {if let Some(Some(manager))=MANAGER.get(){manager.stop();}}
pub(super) fn snapshot()->Statistics {MANAGER.get().and_then(Option::as_ref).map(|m|m.shared.stats.lock().clone()).unwrap_or_default()}
pub(super) fn reaction(session_id:&str,x:i32,y:i32) {
    let Some(Some(manager))=MANAGER.get() else{return;};let _=enqueue_reaction(&manager.shared,session_id,x,y);
}
fn enqueue_reaction(shared:&Shared,session_id:&str,x:i32,y:i32)->bool {
    // Optional decoration can drop on contention; the injector must never wait
    // for a scene update, OS rendering, or the GPU to accept a click reaction.
    let Some(mut state)=shared.mailbox.try_lock() else{return false;};
    if state.stop||!state.last.iter().any(|d|d.session_ids.iter().any(|s|s==session_id)&&d.display.rect().contains(x,y)){return false;}
    if state.reactions.len()>=32 {state.reactions.pop_front();}
    state.reactions.push_back(Reaction{session_id:session_id.into(),x,y,at:Instant::now()});shared.changed.notify_one();true
}

struct ManagedWindow {window:OverlayWindow,scene:OverlayDisplay,notice:Notice,departing:bool,parameters:Option<Parameters>,dirty:bool,last_cursor:Option<(i32,i32)>,still_phase:f32,shown:bool,last_notice:NoticeState,motion:MotionPolicy,last_reactions:usize}
fn run(shared:&Shared) {
    let renderer=match RenderDevice::new() {Ok(r)=>r,Err(error)=>{
        shared.stats.lock().error=Some(format!("Desktop overlay unavailable: {error}"));
        let mut state=shared.mailbox.lock();state.ready=Some(false);shared.changed.notify_all();return;
    }};
    let aurora=match Aurora::new(&renderer) {Ok(a)=>a,Err(error)=>{shared.stats.lock().error=Some(format!("Desktop shader unavailable: {error}"));return;}};
    {let mut stats=shared.stats.lock();stats.available=true;stats.quality_fps=30;stats.process_id=std::process::id();stats.render_thread_id=unsafe{windows::Win32::System::Threading::GetCurrentThreadId()};}
    {let mut state=shared.mailbox.lock();state.ready=Some(true);shared.changed.notify_all();}
    let mut windows:HashMap<String,ManagedWindow>=HashMap::new();
    let mut reactions=Vec::new();let mut phase=0_f64;let mut last_frame=Instant::now();let mut previous_cursor=None;
    let mut system_reduce=false;let mut comfort_check=Instant::now()-Duration::from_secs(2);let mut frame_budget_ms=0_f32;let mut fps=30_u32;
    loop {
        let (scene,clicks)={
            let mut state=shared.mailbox.lock();
            while state.pending.is_none()&&state.reactions.is_empty()&&!state.stop {
                if windows.is_empty() {shared.changed.wait(&mut state);}
                else {shared.changed.wait_for(&mut state,Duration::from_millis((1000/fps) as u64));break;}
            }
            if state.stop {break;}
            (state.pending.take(),state.reactions.drain(..).collect::<Vec<_>>())
        };
        let now=Instant::now();let dt=now.saturating_duration_since(last_frame).as_secs_f32().clamp(0.,0.1);last_frame=now;
        let render_start=Instant::now();shared.stats.lock().wakeups+=1;pump_messages();
        if comfort_check.elapsed()>Duration::from_secs(1) {system_reduce=system_reduced_motion();comfort_check=now;}
        if let Some(scene)=scene {
            shared.stats.lock().scene_updates+=1;
            {let mut stats=shared.stats.lock();stats.failed_displays.retain(|id,_|scene.iter().any(|s|s.display.id==*id));if stats.failed_displays.is_empty(){stats.error=None;}}
            for (id,old) in windows.iter_mut().filter(|(id,_)|!scene.iter().any(|s|s.display.id==**id)) {
                let _=id;old.departing=true;old.notice.leave(now,old.scene.appearance.number("label.announcementSeconds"),system_reduce||old.scene.appearance.text("motion")=="reduce");
            }
            for display in scene.into_iter().take(16) {
                let id=display.display.id.clone();
                if windows.get(&id).is_some_and(|old|old.scene.display.rect()!=display.display.rect()) {windows.remove(&id);}
                if let Some(old)=windows.get_mut(&id) {
                    old.dirty|=old.scene!=display;old.scene=display;old.departing=false;old.notice.resume();
                }else {
                    match OverlayWindow::new(&renderer,display.display.rect()) {
                        Ok(window)=>{shared.stats.lock().failed_displays.remove(&id);windows.insert(id,ManagedWindow{window,notice:Notice::new(display.announcement_at,now,display.announcement_seconds),scene:display,departing:false,parameters:None,dirty:true,last_cursor:None,still_phase:phase as f32,shown:false,last_notice:NoticeState::Hidden,motion:MotionPolicy::default(),last_reactions:0});},
                        Err(error)=>{let message=format!("Overlay window unavailable: {error}");let mut stats=shared.stats.lock();stats.error=Some(message.clone());stats.failed_displays.insert(id,message);},
                    }
                }
            }
            // Window failures are recoverable per output. Clear the summary in
            // this same update once the final failed output was recreated; a
            // second unrelated preference edit must not be needed for recovery.
            let mut stats=shared.stats.lock();if stats.failed_displays.is_empty(){stats.error=None;}
        }
        reactions.extend(clicks);
        let owners:Vec<_>=windows.values().filter(|w|!w.departing).flat_map(|w|w.scene.session_ids.clone()).collect();
        retain_reactions(&mut reactions,&owners,now,2.);
        let cursor=cursor_position();let velocity=match (previous_cursor,cursor) { (Some((x,y)),Some((nx,ny))) if dt>0.=>[(nx-x) as f32/dt,(ny-y) as f32/dt],_=>[0.,0.]};previous_cursor=cursor;
        let speed=windows.iter().min_by_key(|(id,_)|*id).map(|(_,w)|w.scene.appearance.number("aurora.speed")).unwrap_or(0.);
        if !system_reduce&&windows.values().any(|w|w.scene.appearance.text("motion")!="reduce"){phase+=dt as f64*speed as f64;}
        let mut remove=Vec::new();
        for (id,active) in &mut windows {
            let a=&active.scene.appearance;let reduce=system_reduce||a.text("motion")=="reduce";
            if active.motion.update(reduce) {active.dirty=true;if reduce{reactions.retain(|r|!active.scene.session_ids.contains(&r.session_id));}}
            let notice=active.notice.sample(now,a.number("label.announcementSeconds"),reduce);
            if notice.state==NoticeState::Hidden {remove.push(id.clone());continue;}
            let local_cursor=cursor.filter(|(x,y)|active.scene.display.rect().contains(*x,*y));
            let visible_reactions:Vec<_>=reactions.iter().filter(|r|active.scene.session_ids.contains(&r.session_id)&&active.scene.display.rect().contains(r.x,r.y)&&now.saturating_duration_since(r.at).as_secs_f32()<a.number("ripples.duration")).cloned().collect();
            let reaction_count=if reduce||!a.enabled("ripples.enabled"){0}else{visible_reactions.len()};
            let transitions=!matches!(notice.state,NoticeState::Compact|NoticeState::Announcement);
            let moving=!reduce&&a.number("intensity")>0.&&a.number("aurora.speed")>0.;
            let pointer_changed=active.last_cursor!=local_cursor&&a.enabled("halo.enabled")&&a.number("intensity")>0.;
            if active.dirty||moving||transitions||notice.state!=active.last_notice||pointer_changed||reaction_count!=active.last_reactions||reaction_count>0 {
                if !reduce {active.still_phase=phase as f32;}
                let target=Parameters::new(active.scene.display.rect(),a,active.window.dpi_scale(),active.still_phase,notice.opacity,reduce,local_cursor,velocity,&visible_reactions,now);
                let settled=if let Some(p)=active.parameters.as_mut(){p.approach(target,dt)}else{active.parameters=Some(target);true};
                let mut presented=false;
                match active.window.draw_animated(&aurora,active.parameters.as_ref().unwrap(),&active.scene.names.join(", "),notice,a).and_then(|presented|{if presented&&!active.shown{active.window.show()?;}Ok(presented)}) {
                    Ok(true)=>{presented=true;active.shown=true;active.last_cursor=local_cursor;active.last_notice=notice.state;active.last_reactions=active.parameters.as_ref().unwrap().reaction_count();shared.stats.lock().rendered_frames+=1;},
                    Ok(false)=>{},
                    Err(error)=>{active.window.hide();remove.push(id.clone());let message=format!("Desktop decoration stopped: {error}");let mut stats=shared.stats.lock();stats.failed_displays.insert(id.clone(),message.clone());stats.error=Some(message);},
                }
                active.dirty=!settled||!presented;
            }
        }
        for id in remove {windows.remove(&id);}
        let elapsed=render_start.elapsed().as_secs_f32()*1000.;frame_budget_ms=frame_budget_ms*0.9+elapsed*0.1;
        // Decoration sheds cadence first. The capture/encode and pointer threads
        // never wait for this worker, including a slow DWM/driver.
        if frame_budget_ms>8. {fps=15;}else if frame_budget_ms<3. {fps=30;}
        let mut stats=shared.stats.lock();stats.last_render_ms=elapsed;stats.quality_fps=fps;stats.windows=windows.len();stats.handles=windows.values().map(|w|w.window.hwnd().0 as usize).collect();stats.active_display_ids=windows.iter().filter(|(_,w)|w.shown&&!w.departing).map(|(id,_)|id.clone()).collect();stats.painted_reactions=windows.values().map(|w|w.last_reactions).sum();
    }
    // Drop the HWNDs before the renderer/COM apartment, all on their owner thread.
    windows.clear();pump_messages();drop(aurora);drop(renderer);
}
fn system_reduced_motion()->bool {unsafe{
    use windows::Win32::{Foundation::BOOL,UI::WindowsAndMessaging::*};
    let mut enabled=BOOL(1);SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,Some((&mut enabled as *mut BOOL).cast()),SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).is_ok()&&!enabled.as_bool()
}}
fn cursor_position()->Option<(i32,i32)> {unsafe{
    use windows::Win32::UI::WindowsAndMessaging::*;
    let mut info=CURSORINFO{cbSize:std::mem::size_of::<CURSORINFO>() as u32,..Default::default()};
    if GetCursorInfo(&mut info).is_ok()&&info.flags==CURSOR_SHOWING {Some((info.ptScreenPos.x,info.ptScreenPos.y))}else{None}
}}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn mailbox_is_bounded_latest_wins_and_duplicate_scenes_do_not_wake() {
        let shared=Arc::new(Shared::default());let manager=Manager{shared:shared.clone(),thread:Mutex::new(None)};
        manager.refresh(Vec::new());assert!(shared.mailbox.lock().pending.is_none());
        let mut display=DisplayInfo{id:"d".into(),index:0,name:"d".into(),x:0,y:0,width:1920,height:1080,rotation:0,is_primary:true,selected:true,layout_revision:1};
        for i in 0..1000 {display.x=i;manager.refresh(vec![OverlayDisplay{display:display.clone(),names:vec!["Remote User".into()],appearance:Default::default(),session_ids:vec!["s".into()],announcement_at:Some(Instant::now()),announcement_seconds:3.}]);}
        assert_eq!(shared.mailbox.lock().pending.as_ref().unwrap().len(),1);assert_eq!(shared.mailbox.lock().pending.as_ref().unwrap()[0].display.x,999);
        manager.stop();manager.refresh(Vec::new());assert_eq!(shared.mailbox.lock().pending.as_ref().unwrap().len(),1);
    }
    #[test]fn contended_optional_reactions_return_without_waiting_for_input_thread(){
        let shared=Shared::default();let held=shared.mailbox.lock();let start=Instant::now();
        assert!(!enqueue_reaction(&shared,"s",10,10));assert!(start.elapsed()<Duration::from_millis(20));
        assert!(held.reactions.is_empty());
    }
}
