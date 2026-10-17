//! Bounded, authorized view transactions. Captured pixels, the displayed epoch
//! acknowledgment and native input mapping must agree before input resumes.
use std::{collections::HashMap,sync::{Arc,atomic::{AtomicBool,Ordering}}};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize,Serialize};
use super::{display::{self,DisplaySnapshot},view::{AppliedView,CaptureIdentity,ViewMode}};
pub const TRANSITION_MS:u64=10_000;
#[derive(Clone,Debug,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ViewRequest {pub request_id:String,pub mode:ViewMode,pub selected_display_id:String,pub max_width:u32}
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Status {pub requested:CaptureIdentity,pub applied:Option<CaptureIdentity>,pub pending:bool,pub error:Option<String>,pub layout:Option<DisplaySnapshot>}
struct Session {scope:String,epoch_enabled:bool,authorized:Arc<AtomicBool>,requested:Arc<CaptureIdentity>,applied:Option<Arc<CaptureIdentity>>,produced:Option<Arc<CaptureIdentity>>,started:Option<u64>,error:Option<String>,next_epoch:u64,recovery:u8}
#[derive(Default)]
pub struct Registry {sessions:HashMap<String,Session>,owners:HashMap<String,String>}
pub enum InputView {Legacy,Blocked,Ready(Arc<CaptureIdentity>)}
impl Registry {
    pub fn authorize(&mut self,sid:&str,scope:&str,view:AppliedView,enabled:bool,now:u64)->bool {
        if self.sessions.contains_key(sid){return true;}
        if let Some(old)=self.owners.get(scope).cloned(){self.end(&old);}
        if self.sessions.len()>=16{return false;}
        let mut view=view;view.epoch=1;
        self.sessions.insert(sid.into(),Session{scope:scope.into(),epoch_enabled:enabled,authorized:Arc::new(AtomicBool::new(true)),requested:Arc::new(CaptureIdentity{session_id:sid.into(),request_id:"initial".into(),view}),applied:None,produced:None,started:Some(now),error:None,next_epoch:2,recovery:0});
        self.owners.insert(scope.into(),sid.into());true
    }
    pub fn request(&mut self,sid:&str,request:ViewRequest,layout:&DisplaySnapshot,now:u64)->Result<Arc<CaptureIdentity>,String>{
        let s=self.sessions.get_mut(sid).ok_or("Retired view session")?;
        if !s.epoch_enabled{return Err("View epochs were not negotiated".into());}
        if request.request_id.is_empty()||request.request_id.len()>128||request.max_width<32||request.max_width>3840{return Err("Invalid view request".into());}
        let d=layout.by_id(&request.selected_display_id).ok_or("Display no longer connected")?;
        if s.scope!="primary"&&(request.mode!=ViewMode::Single||s.scope!=format!("aux:{}",d.id)){return Err("This view is fixed to one display".into());}
        let view=AppliedView::create(layout,request.mode,&d.id,s.next_epoch,request.max_width,4096,8_294_400).ok_or("No capture layout")?;
        s.next_epoch=s.next_epoch.saturating_add(1);
        let identity=Arc::new(CaptureIdentity{session_id:sid.into(),request_id:request.request_id,view});
        s.requested=identity.clone();s.produced=None;s.started=Some(now);s.error=None;s.recovery=0;Ok(identity)
    }
    pub fn produced(&mut self,identity:&CaptureIdentity)->bool{
        let Some(s)=self.sessions.get_mut(&identity.session_id)else{return false;};
        if !s.epoch_enabled||*s.requested.as_ref()!=*identity{return false;}
        s.produced=Some(s.requested.clone());true
    }
    pub fn acknowledge(&mut self,sid:&str,epoch:u64,revision:u64)->Option<AppliedView>{
        let s=self.sessions.get_mut(sid)?;
        let produced=s.produced.as_ref()?;
        if produced.view.epoch!=epoch||produced.view.layout_revision!=revision||*produced.as_ref()!=*s.requested.as_ref(){return None;}
        s.applied=Some(produced.clone());s.started=None;s.error=None;Some(produced.view.clone())
    }
    pub fn input(&self,sid:&str,epoch:Option<u64>,revision:u64)->InputView {
        let Some(s)=self.sessions.get(sid)else{return InputView::Blocked;};
        if !s.epoch_enabled{return InputView::Legacy;}
        match (&s.applied,&s.produced){
            (Some(a),Some(p))if s.started.is_none()&&a.view.layout_revision==revision&&Some(a.view.epoch)==epoch&&a==p=>InputView::Ready(a.clone()),
            _=>InputView::Blocked,
        }
    }
    pub fn status(&self,sid:&str)->Option<Status>{let s=self.sessions.get(sid)?;Some(Status{requested:s.requested.as_ref().clone(),applied:s.applied.as_deref().cloned(),pending:s.started.is_some(),error:s.error.clone(),layout:None})}
    pub fn cancel(&mut self,sid:&str,epoch:u64,layout:&DisplaySnapshot,now:u64)->bool{
        let Some(s)=self.sessions.get_mut(sid)else{return false;};if s.started.is_none()||s.requested.view.epoch!=epoch{return false;}
        let previous=s.applied.as_ref().filter(|a|a.view.layout_revision==layout.revision).unwrap_or(&s.requested);
        let mut view=if previous.view.layout_revision==layout.revision{previous.view.clone()}else{let Some(view)=AppliedView::create(layout,previous.view.mode,&previous.view.selected_display_id,s.next_epoch,previous.view.width,4096,8_294_400)else{return false;};view};
        view.epoch=s.next_epoch;s.next_epoch+=1;s.requested=Arc::new(CaptureIdentity{session_id:sid.into(),request_id:format!("rollback-{}",view.epoch),view});
        s.produced=None;s.started=Some(now);s.error=Some("View setup failed; restoring previous view".into());true
    }
    pub fn capture(&self,scope:&str)->Option<Arc<CaptureIdentity>>{let s=self.sessions.get(self.owners.get(scope)?)?;s.epoch_enabled.then(||s.requested.clone())}
    pub fn capture_failed(&mut self,identity:&CaptureIdentity,layout:&DisplaySnapshot,now:u64)->bool{
        let Some(s)=self.sessions.get_mut(&identity.session_id)else{return false;};if !s.epoch_enabled||s.requested.as_ref()!=identity||s.recovery>=2{return false;}
        let source=&identity.view;let(mode,width,message)=if s.recovery==0&&source.width>320{(source.mode,(source.width*3/4).max(320),"Capture setup failed; retrying at a uniformly reduced size")}
        else{(ViewMode::Single,source.width.max(1920),"All screens capture unavailable; restoring the selected display")};
        let Some(view)=AppliedView::create(layout,mode,&source.selected_display_id,s.next_epoch,width,4096,8_294_400)else{return false;};
        s.recovery+=1;s.next_epoch+=1;s.requested=Arc::new(CaptureIdentity{session_id:identity.session_id.clone(),request_id:format!("native-{}",view.epoch),view});s.produced=None;s.started=Some(now);s.error=Some(message.into());true
    }
    pub fn end(&mut self,sid:&str){if let Some(s)=self.sessions.remove(sid){s.authorized.store(false,Ordering::Release);if self.owners.get(&s.scope).map(String::as_str)==Some(sid){self.owners.remove(&s.scope);}}}
    /// A failed pending view rolls back to the last proven source. Mapping stays
    /// blocked until that old source has actually produced again.
    pub fn tick(&mut self,layout:&DisplaySnapshot,now:u64)->bool{
        let mut changed=false;
        for s in self.sessions.values_mut().filter(|s|s.epoch_enabled){
            let stale=s.requested.view.layout_revision!=layout.revision;
            let expired=s.started.is_some_and(|at|now.saturating_sub(at)>=TRANSITION_MS);
            if !stale&&!expired{continue;}
            if !stale {if let Some(old)=s.applied.clone().filter(|old|old.view.layout_revision==layout.revision){
                let mut view=old.view.clone();view.epoch=s.next_epoch;s.next_epoch+=1;
                s.requested=Arc::new(CaptureIdentity{session_id:old.session_id.clone(),request_id:format!("rollback-{}",view.epoch),view});
                s.produced=None;s.started=Some(now);s.error=Some("View change timed out; restoring previous view".into());changed=true;continue;
            }}
            let selected=layout.by_id(&s.requested.view.selected_display_id).or_else(||layout.displays.iter().find(|d|d.is_primary)).or(layout.displays.first());
            let Some(selected)=selected else {s.produced=None;continue;};
            if s.scope!="primary"&&s.scope!=format!("aux:{}",selected.id){s.produced=None;continue;}
            let mode=if stale{s.requested.view.mode}else{ViewMode::Single};
            let Some(view)=AppliedView::create(layout,mode,&selected.id,s.next_epoch,s.requested.view.width,4096,8_294_400)else{continue;};
            s.next_epoch+=1;s.requested=Arc::new(CaptureIdentity{session_id:s.requested.session_id.clone(),request_id:format!("native-{}",view.epoch),view});
            s.produced=None;s.started=Some(now);s.error=Some(if stale{"Display layout changed"}else{"Initial view timed out; retrying single display"}.into());changed=true;
        }changed
    }
}
static REGISTRY:Lazy<Mutex<Registry>>=Lazy::new(||Mutex::new(Registry::default()));
static AUTHORIZATION:Lazy<arc_swap::ArcSwap<HashMap<String,Arc<AtomicBool>>>>=Lazy::new(||arc_swap::ArcSwap::from_pointee(HashMap::new()));
fn refresh_authorization(r:&Registry){AUTHORIZATION.store(Arc::new(r.sessions.iter().map(|(sid,s)|(sid.clone(),s.authorized.clone())).collect()));}
/// Lock-free session admission survives view-registry contention. The queued
/// event retains an atomic revocation flag checked again on the injector thread.
pub fn authorization(sid:&str)->Option<Arc<AtomicBool>>{AUTHORIZATION.load().get(sid).cloned()}
fn refresh_capture(r:&Registry){
    #[cfg(windows)] {
        let next=r.capture("primary");
        super::capture::set_view_identity(next);
    }
}
pub fn authorize(sid:&str,scope:&str,view:AppliedView,enabled:bool){let mut r=REGISTRY.lock();let previous=r.owners.get(scope).cloned();r.authorize(sid,scope,view,enabled,super::presence::now_ms());refresh_authorization(&r);refresh_capture(&r);drop(r);if let Some(previous)=previous.filter(|old|old!=sid){super::input::release_session(&previous);}}
pub fn request(sid:&str,request:ViewRequest)->Result<CaptureIdentity,String>{let layout=display::snapshot();let mut r=REGISTRY.lock();let identity=r.request(sid,request,&layout,super::presence::now_ms())?;refresh_capture(&r);Ok(identity.as_ref().clone())}
pub fn status(sid:&str)->Option<Status>{let layout=display::snapshot();REGISTRY.lock().status(sid).map(|mut status|{status.layout=Some(layout);status})}
pub fn cancel(sid:&str,epoch:u64)->Option<Status>{let layout=display::snapshot();let mut r=REGISTRY.lock();if r.cancel(sid,epoch,&layout,super::presence::now_ms()){refresh_capture(&r);}r.status(sid)}
pub fn capture(scope:&str)->Option<Arc<CaptureIdentity>>{REGISTRY.lock().capture(scope)}
pub fn legacy_monitor(sid:&str,index:usize)->bool{
    let layout=display::snapshot();let mut r=REGISTRY.lock();
    let Some(s)=r.sessions.get(sid)else{return true;};if !s.epoch_enabled{return false;}
    let Some(d)=layout.displays.get(index)else{return true;};let max_width=s.requested.view.width;
    let request=ViewRequest{request_id:format!("monitor-{}",s.next_epoch),mode:ViewMode::Single,selected_display_id:d.id.clone(),max_width};
    let _=r.request(sid,request,&layout,super::presence::now_ms());refresh_capture(&r);true
}
pub fn retune(max_width:u32){
    let layout=display::snapshot();let mut r=REGISTRY.lock();let Some(sid)=r.owners.get("primary").cloned()else{return;};let Some(s)=r.sessions.get(&sid)else{return;};
    if !s.epoch_enabled{return;}let (width,height)=super::view::fit_size(s.requested.view.source,max_width,4096,8_294_400);
    if (s.requested.view.width,s.requested.view.height)==(width,height){refresh_capture(&r);return;}
    let request=ViewRequest{request_id:format!("quality-{}",s.next_epoch),mode:s.requested.view.mode,selected_display_id:s.requested.view.selected_display_id.clone(),max_width};
    let _=r.request(&sid,request,&layout,super::presence::now_ms());refresh_capture(&r);
}
pub fn presence_ready(sid:&str,epoch:u64)->bool{matches!(input(sid,Some(epoch)),InputView::Legacy|InputView::Ready(_))}
pub fn produced(identity:&CaptureIdentity)->bool{REGISTRY.lock().produced(identity)}
pub fn capture_failed(identity:&CaptureIdentity){let layout=display::snapshot();let mut r=REGISTRY.lock();if r.capture_failed(identity,&layout,super::presence::now_ms()){refresh_capture(&r);}}
pub fn acknowledge(sid:&str,epoch:u64)->bool{
    let view=REGISTRY.lock().acknowledge(sid,epoch,display::revision());
    view.is_some_and(|v|super::presence::apply_view(sid,v))
}
pub fn input(sid:&str,epoch:Option<u64>)->InputView{REGISTRY.try_lock().map_or(InputView::Blocked,|r|r.input(sid,epoch,display::revision()))}
pub fn end(sid:&str){let mut r=REGISTRY.lock();r.end(sid);refresh_authorization(&r);refresh_capture(&r);}
pub fn tick(){let layout=display::snapshot();let mut r=REGISTRY.lock();if r.tick(&layout,super::presence::now_ms()){refresh_capture(&r);}}

#[cfg(test)]mod tests{
    use super::*;
    fn layout(revision:u64)->DisplaySnapshot{let displays=vec![(-1920,"l"),(0,"r")].into_iter().enumerate().map(|(index,(x,id))|display::DisplayInfo{id:id.into(),index,name:id.into(),x,y:0,width:1920,height:1080,rotation:0,is_primary:x==0,selected:false,layout_revision:revision}).collect::<Vec<_>>();DisplaySnapshot{revision,bounds:display::union(&displays),displays}}
    fn request(id:&str,mode:ViewMode,selected:&str)->ViewRequest{ViewRequest{request_id:id.into(),mode,selected_display_id:selected.into(),max_width:1920}}
    fn registry()->(Registry,DisplaySnapshot){let l=layout(1);let mut r=Registry::default();r.authorize("a","primary",AppliedView::create(&l,ViewMode::Single,"l",0,1920,4096,8_294_400).unwrap(),true,0);(r,l)}
    #[test]fn same_size_changes_require_exact_producing_epoch_and_ack(){let(mut r,l)=registry();let initial=r.capture("primary").unwrap();assert!(matches!(r.input("a",Some(1),1),InputView::Blocked));r.produced(&initial);r.acknowledge("a",1,1).unwrap();let next=r.request("a",request("b",ViewMode::Single,"r"),&l,10).unwrap();assert_eq!(next.view.width,initial.view.width);assert!(matches!(r.input("a",Some(1),1),InputView::Blocked));assert!(!r.produced(&initial));assert!(r.acknowledge("a",next.view.epoch,1).is_none());r.produced(&next);r.acknowledge("a",next.view.epoch,1).unwrap();assert!(matches!(r.input("a",Some(1),1),InputView::Blocked));assert!(matches!(r.input("a",Some(next.view.epoch),1),InputView::Ready(_)));}
    #[test]fn supersession_topology_and_timeout_never_relabel_old_pixels(){let(mut r,l)=registry();let a=r.capture("primary").unwrap();r.produced(&a);r.acknowledge("a",1,1);let b=r.request("a",request("b",ViewMode::All,"r"),&l,1).unwrap();let c=r.request("a",request("c",ViewMode::Single,"r"),&l,2).unwrap();assert!(!r.produced(&b));r.tick(&l,TRANSITION_MS+3);let restored=r.capture("primary").unwrap();assert_eq!(restored.view.source,a.view.source);assert!(restored.view.epoch>c.view.epoch);assert!(!r.produced(&c));assert!(!r.produced(&a));r.produced(&restored);assert!(matches!(r.input("a",Some(1),1),InputView::Blocked));assert!(r.acknowledge("a",restored.view.epoch,1).is_some());assert!(matches!(r.input("a",Some(restored.view.epoch),1),InputView::Ready(_)));r.tick(&layout(2),20_000);assert!(r.capture("primary").unwrap().view.epoch>restored.view.epoch);assert!(matches!(r.input("a",Some(restored.view.epoch),2),InputView::Blocked));r.authorize("new","primary",a.view.clone(),true,20_001);assert!(!r.produced(&a));assert!(r.status("a").is_none());}
    #[test]fn displayed_new_view_with_lost_ack_requires_new_rollback_epoch_and_fresh_ack(){let(mut r,l)=registry();let old=r.capture("primary").unwrap();r.produced(&old);r.acknowledge("a",1,1);let next=r.request("a",request("visible-but-ack-lost",ViewMode::Single,"r"),&l,10).unwrap();r.produced(&next);r.tick(&l,TRANSITION_MS+11);let rollback=r.capture("primary").unwrap();assert!(rollback.view.epoch>next.view.epoch);assert!(!r.produced(&old));assert!(r.status("a").unwrap().pending);assert!(matches!(r.input("a",Some(old.view.epoch),1),InputView::Blocked));assert!(matches!(r.input("a",Some(next.view.epoch),1),InputView::Blocked));assert!(r.acknowledge("a",next.view.epoch,1).is_none());assert!(r.acknowledge("a",old.view.epoch,1).is_none());r.produced(&rollback);assert!(r.acknowledge("a",old.view.epoch,1).is_none());assert!(r.acknowledge("a",rollback.view.epoch,1).is_some());assert!(matches!(r.input("a",Some(rollback.view.epoch),1),InputView::Ready(_)));}
    #[test]fn failed_combined_setup_retries_uniform_size_then_truthful_single_with_new_epochs(){let(mut r,l)=registry();let all=r.request("a",request("all",ViewMode::All,"r"),&l,1).unwrap();assert!(r.capture_failed(&all,&l,2));let smaller=r.capture("primary").unwrap();assert_eq!(smaller.view.source,all.view.source);assert!(smaller.view.width<all.view.width);assert!(smaller.view.epoch>all.view.epoch);assert!(!r.produced(&all));assert!(r.capture_failed(&smaller,&l,3));let single=r.capture("primary").unwrap();assert_eq!(single.view.mode,ViewMode::Single);assert_eq!(single.view.displays.len(),1);assert!(single.view.epoch>smaller.view.epoch);assert!(!r.capture_failed(&single,&l,4));assert!(r.acknowledge("a",single.view.epoch,1).is_none());r.produced(&single);assert!(r.acknowledge("a",single.view.epoch,1).is_some());}
    #[test]fn queued_authorization_is_revoked_without_waiting_for_view_registry(){let(mut r,l)=registry();let old=r.sessions["a"].authorized.clone();r.authorize("new","primary",AppliedView::create(&l,ViewMode::Single,"r",0,1920,4096,8_294_400).unwrap(),true,5);assert!(!old.load(Ordering::Acquire));assert!(r.sessions["new"].authorized.load(Ordering::Acquire));r.end("new");assert!(r.sessions.is_empty());}
    #[test]fn all_gap_membership_and_fixed_aux_scope_are_explicit(){let(mut r,l)=registry();let a=r.request("a",request("all",ViewMode::All,"r"),&l,1).unwrap();assert_eq!(a.view.source.x,-1920);assert_eq!(a.view.displays.len(),2);r.authorize("aux","aux:l",a.view.clone(),true,2);assert!(r.request("aux",request("all",ViewMode::All,"l"),&l,3).is_err());assert!(r.request("aux",request("r",ViewMode::Single,"r"),&l,3).is_err());assert!(r.request("aux",request("l",ViewMode::Single,"l"),&l,3).is_ok());}
}
