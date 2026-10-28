//! Authorized, host-process-owned view presence. Missing reports mean absent.
//! Expiry uses a native watchdog, independent of host WebView timer health.
use std::{collections::{HashMap,HashSet,VecDeque},sync::Once,time::{Duration,Instant}};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize,Serialize};
use serde_json::Value;
use super::{appearance::{Appearance,display_name},display::{self,DisplaySnapshot,PhysicalRect},view::{AppliedView,ViewMode}};
pub const CAPABILITIES:&[&str]=&["display-geometry-v1","all-screens-v1","view-state-v1","controller-name-v1","desktop-appearance-v1","view-epoch-input-v1","viewport-v1"];
pub const PRESENCE_TTL_MS:u64=6500;
const HISTORY_MS:u64=60_000;
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Handshake {
    pub version:u32,pub capabilities:Vec<String>,pub session_id:String,pub layout:DisplaySnapshot,pub view:AppliedView,pub overlay_available:bool,
}
#[derive(Clone,Debug,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct PresenceUpdate {
    pub sequence:u64,pub display_name:String,
    #[serde(default)] pub control_visible:bool,#[serde(default)] pub pip_visible:bool,#[serde(default)] pub immersive_visible:bool,
    pub mode:ViewMode,pub view_epoch:u64,pub selected_display_id:String,
    #[serde(default)] pub visible_display_ids:Vec<String>,#[serde(default)] pub appearance:Value,
    /// viewport-v1: what the viewer actually sees, in physical desktop pixels.
    #[serde(default)] pub view_rect:Option<PhysicalRect>,
}
#[derive(Clone,Debug)]
pub struct Entry {
    pub session_id:String,pub device_id:String,pub scope:String,pub name:String,pub view:AppliedView,
    pub selected_display_id:String,
    pub expired:bool,
    pub visible_ids:Vec<String>,pub control:bool,pub pip:bool,pub immersive:bool,pub appearance:Appearance,
    pub view_rect:Option<PhysicalRect>,
    pub last_valid_ms:u64,pub sequence:u64,pub announcement_at:Option<u64>,pub announcement_seconds:f32,
}
impl Entry {
    pub fn input_active(&self)->bool{self.control||self.pip||self.immersive}
    pub fn visible(&self)->bool {self.input_active()&&!self.visible_ids.is_empty()}
}
/// Intersection, or None when it is empty or degenerate.
fn clip(r:PhysicalRect,bounds:PhysicalRect)->Option<PhysicalRect> {
    let (l,t)=(r.x.max(bounds.x) as i64,r.y.max(bounds.y) as i64);
    let right=(r.x as i64+r.width as i64).min(bounds.x as i64+bounds.width as i64);
    let bottom=(r.y as i64+r.height as i64).min(bounds.y as i64+bounds.height as i64);
    (right-l>=8&&bottom-t>=8).then(||PhysicalRect{x:l as i32,y:t as i32,width:(right-l) as u32,height:(bottom-t) as u32})
}
/// A lens is drawn on a display only while it marks out a real part of it.
/// Near fit (≈ zoom 1.05×) it would just retrace the screen-edge border.
pub(crate) const LENS_MAX_COVERAGE:f64=0.88;
fn lens_on(display:PhysicalRect,view:PhysicalRect)->bool {
    clip(view,display).is_some_and(|c|(c.width as f64*c.height as f64)<LENS_MAX_COVERAGE*display.width as f64*display.height as f64)
}
fn became_inactive(was_active:bool,entry:&Entry)->bool{was_active&&!entry.input_active()}
#[derive(Default)]
pub struct Registry {
    entries:HashMap<String,Entry>,owners:HashMap<(String,String),String>,retired:HashSet<String>,retired_order:VecDeque<String>,history:HashMap<(String,String),(u64,u64,f32)>,
}
impl Registry {
    pub fn authorize(&mut self,sid:&str,device:&str,scope:&str,name:&str,view:AppliedView,now:u64)->bool {
        if sid.is_empty()||sid.len()>128||device.len()>256||scope.len()>256||self.retired.contains(sid) {return false;}
        if let Some(entry)=self.entries.get(sid) {return entry.device_id==device&&entry.scope==scope;}
        let key=(device.to_owned(),scope.to_owned());
        if let Some(old)=self.owners.get(&key).cloned() {self.end(&old,false);}
        if self.entries.len()>=16 {return false;}
        self.owners.insert(key,sid.to_owned());
        let selected_display_id=view.selected_display_id.clone();
        self.entries.insert(sid.to_owned(),Entry {session_id:sid.into(),device_id:device.into(),scope:scope.into(),name:display_name(name),view,selected_display_id,expired:false,visible_ids:Vec::new(),control:false,pip:false,immersive:false,appearance:Appearance::default(),view_rect:None,last_valid_ms:now,sequence:0,announcement_at:None,announcement_seconds:3.});true
    }
    pub fn update(&mut self,sid:&str,update:PresenceUpdate,now:u64)->bool {
        let Some(entry)=self.entries.get_mut(sid) else{return false;};
        if update.sequence<=entry.sequence||update.view_epoch!=entry.view.epoch||update.mode!=entry.view.mode {return false;}
        if !entry.view.displays.iter().any(|d|d.id==update.selected_display_id) {return false;}
        entry.sequence=update.sequence;entry.name=display_name(&update.display_name);entry.last_valid_ms=now;entry.expired=false;
        entry.control=update.control_visible;entry.pip=update.pip_visible;entry.immersive=update.immersive_visible;
        entry.selected_display_id=update.selected_display_id;
        let mut seen=HashSet::new();
        entry.visible_ids=update.visible_display_ids.into_iter().take(16).filter(|id|entry.view.displays.iter().any(|d|d.id==*id)&&seen.insert(id.clone())&&(!entry.pip||*id==entry.selected_display_id)).collect();
        if !(entry.control||entry.pip||entry.immersive) {entry.visible_ids.clear();}
        entry.appearance=Appearance::validate(&update.appearance);
        entry.view_rect=if entry.control {update.view_rect.and_then(|r|clip(r,entry.view.source))} else {None};
        if entry.visible() {
            let key=(entry.device_id.clone(),entry.scope.clone());
            let history=self.history.entry(key).or_insert((now,now,entry.appearance.number("label.announcementSeconds")));
            if now.saturating_sub(history.1)>HISTORY_MS {*history=(now,now,entry.appearance.number("label.announcementSeconds"));}
            history.1=now;entry.announcement_at=Some(history.0);entry.announcement_seconds=history.2;
        }
        true
    }
    pub fn end(&mut self,sid:&str,explicit:bool) {
        if let Some(entry)=self.entries.remove(sid) {
            let key=(entry.device_id,entry.scope);
            if self.owners.get(&key).map(String::as_str)==Some(sid) {self.owners.remove(&key);}
            if explicit {self.history.remove(&key);}
        }
        if self.retired.insert(sid.to_owned()) {self.retired_order.push_back(sid.to_owned());}
        while self.retired_order.len()>128 {if let Some(old)=self.retired_order.pop_front(){self.retired.remove(&old);}}
    }
    pub fn expire(&mut self,now:u64)->Vec<String> {
        // Expiry removes visual presence, not a still-live peer's authorization.
        // Hidden browser timers can be suspended for minutes; a fresh report on
        // return must revive the same authorized session without a reconnect.
        let mut retired_input=Vec::new();
        for entry in self.entries.values_mut().filter(|e|!e.expired&&now.saturating_sub(e.last_valid_ms)>PRESENCE_TTL_MS) {
            entry.visible_ids.clear();entry.control=false;entry.pip=false;entry.immersive=false;entry.view_rect=None;
            entry.expired=true;retired_input.push(entry.session_id.clone());
        }
        self.history.retain(|_,v|now.saturating_sub(v.1)<=HISTORY_MS);
        retired_input
    }
    pub fn visible_entries(&self)->Vec<Entry> {self.entries.values().filter(|e|e.visible()).cloned().collect()}
    pub fn view(&self,sid:&str)->Option<&AppliedView> {self.entries.get(sid).map(|e|&e.view)}
    pub fn apply_view(&mut self,sid:&str,view:AppliedView)->bool {
        let Some(entry)=self.entries.get_mut(sid) else{return false;};
        entry.selected_display_id=view.selected_display_id.clone();entry.view=view;entry.visible_ids.clear();entry.view_rect=None;true
    }
}
static REGISTRY:Lazy<Mutex<Registry>>=Lazy::new(||Mutex::new(Registry::default()));
static ORIGIN:Lazy<Instant>=Lazy::new(Instant::now);
static WATCH:Once=Once::new();
pub fn now_ms()->u64 {ORIGIN.elapsed().as_millis() as u64}
fn current_view(view:&AppliedView,scope:&str,layout:&DisplaySnapshot,selected_capture:usize)->bool {
    if view.layout_revision!=layout.revision || view.displays.iter().any(|d|layout.by_id(&d.id).is_none()) {return false;}
    scope!="primary" || view.mode!=ViewMode::Single || layout.displays.get(selected_capture).map(|d|d.id.as_str())==Some(view.selected_display_id.as_str())
}
pub fn visible_entries()->Vec<Entry> {
    let layout=display::snapshot();let selected=super::capture::selected_monitor();
    REGISTRY.lock().visible_entries().into_iter().filter(|e|current_view(&e.view,&e.scope,&layout,selected)&&super::view_session::presence_ready(&e.session_id,e.view.epoch)).collect()
}
pub fn authorize(sid:&str,device:&str,name:&str,capabilities:&[String],fixed_monitor:Option<usize>)->Option<Handshake> {
    if !capabilities.iter().any(|c|c=="view-state-v1") {return None;}
    let layout=display::snapshot();
    let index=fixed_monitor.unwrap_or_else(super::capture::selected_monitor);
    let selected=layout.displays.get(index).or(layout.displays.first())?;
    let view=AppliedView::create(&layout,ViewMode::Single,&selected.id,0,1920,4096,8_294_400)?;
    let scope=fixed_monitor.map(|_|format!("aux:{}",selected.id)).unwrap_or_else(||"primary".into());
    if !REGISTRY.lock().authorize(sid,device,&scope,name,view.clone(),now_ms()) {return None;}
    let epochs=CAPABILITIES.contains(&"view-epoch-input-v1")&&capabilities.iter().any(|c|c=="view-epoch-input-v1");
    super::view_session::authorize(sid,&scope,view.clone(),epochs);
    WATCH.call_once(|| {let _=std::thread::Builder::new().name("remote-presence-expiry".into()).spawn(||loop {
        std::thread::sleep(Duration::from_millis(250));super::view_session::tick();let expired=REGISTRY.lock().expire(now_ms());for sid in expired{super::input::release_session(&sid);}refresh_overlay();
    });});
    let overlay_available=super::overlay::prepare();
    Some(Handshake {version:1,capabilities:CAPABILITIES.iter().filter(|c|capabilities.iter().any(|x|x.as_str()==**c)).map(|c|(*c).into()).collect(),session_id:sid.into(),layout,view,overlay_available})
}
pub fn update(sid:&str,update:PresenceUpdate)->bool {
    let layout=display::snapshot();let selected=super::capture::selected_monitor();let mut registry=REGISTRY.lock();
    if let Some(entry)=registry.entries.get_mut(sid) {
        if !current_view(&entry.view,&entry.scope,&layout,selected) {
            entry.visible_ids.clear();entry.control=false;entry.pip=false;entry.immersive=false;return false;
        }
    }
    let was_active=registry.entries.get(sid).is_some_and(Entry::input_active);
    let accepted=registry.update(sid,update,now_ms());let hidden=registry.entries.get(sid).is_some_and(|entry|became_inactive(was_active,entry));drop(registry);
    if accepted&&hidden{super::input::release_session(sid);}
    if accepted {refresh_overlay();}accepted
}
pub fn end(sid:&str,explicit:bool) {REGISTRY.lock().end(sid,explicit);super::view_session::end(sid);super::input::release_session(sid);refresh_overlay();}
pub fn applied_view(sid:&str)->Option<AppliedView> {REGISTRY.lock().view(sid).cloned()}
pub fn apply_view(sid:&str,view:AppliedView)->bool {let applied=REGISTRY.lock().apply_view(sid,view);refresh_overlay();applied}
fn refresh_overlay() {
    // This is the only session-to-renderer boundary. Stale applied views have
    // already failed closed; the renderer never infers visibility from auth.
    let mut scene:HashMap<String,super::overlay::OverlayDisplay>=HashMap::new();
    let mut entries=visible_entries();entries.sort_by(|a,b|a.session_id.cmp(&b.session_id));
    for entry in entries {
        for id in &entry.visible_ids {
            let Some(display)=entry.view.displays.iter().find(|d|d.id==*id) else {continue;};
            let item=scene.entry(id.clone()).or_insert_with(||super::overlay::OverlayDisplay {display:display.clone(),names:Vec::new(),appearance:entry.appearance.clone(),session_ids:Vec::new(),announcement_at:entry.announcement_at.and_then(|ms|ORIGIN.checked_add(Duration::from_millis(ms))),announcement_seconds:entry.announcement_seconds,lenses:Vec::new()});
            if !item.names.contains(&entry.name) {item.names.push(entry.name.clone());}
            item.session_ids.push(entry.session_id.clone());
            if let Some(rect)=entry.view_rect.filter(|r|entry.appearance.enabled("lens.enabled")&&entry.appearance.number("lens.strength")>0.005&&lens_on(display.rect(),*r)) {
                item.lenses.push(super::overlay::LensTarget{session_id:entry.session_id.clone(),name:entry.name.clone(),rect});
            }
        }
    }
    let mut scene:Vec<_>=scene.into_values().collect();scene.sort_by(|a,b|a.display.id.cmp(&b.display.id));
    super::overlay::refresh(scene);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn view()->AppliedView {AppliedView {epoch:1,layout_revision:1,mode:ViewMode::Single,selected_display_id:"p".into(),source:display::PhysicalRect{x:0,y:0,width:1920,height:1080},width:1920,height:1080,displays:vec![display::DisplayInfo{id:"p".into(),index:0,name:"p".into(),x:0,y:0,width:1920,height:1080,rotation:0,is_primary:true,selected:true,layout_revision:1}]}}
    fn update(sequence:u64,visible:bool)->PresenceUpdate {PresenceUpdate {sequence,display_name:"Remote User".into(),control_visible:visible,pip_visible:false,immersive_visible:false,mode:ViewMode::Single,view_epoch:1,selected_display_id:"p".into(),visible_display_ids:vec!["p".into(),"not-captured".into()],appearance:Value::Null,view_rect:None}}
    #[test]fn view_rect_is_clipped_to_the_capture_and_dropped_outside_control(){
        let mut r=Registry::default();r.authorize("a","phone","primary","name",view(),0);
        let mut u=update(1,true);u.view_rect=Some(display::PhysicalRect{x:1500,y:-40,width:900,height:400});assert!(r.update("a",u,1));
        assert_eq!(r.entries["a"].view_rect,Some(display::PhysicalRect{x:1500,y:0,width:420,height:360}));
        let mut outside=update(2,true);outside.view_rect=Some(display::PhysicalRect{x:5000,y:0,width:100,height:100});r.update("a",outside,2);assert_eq!(r.entries["a"].view_rect,None);
        let mut pip=update(3,false);pip.pip_visible=true;pip.view_rect=Some(display::PhysicalRect{x:0,y:0,width:100,height:100});r.update("a",pip,3);assert_eq!(r.entries["a"].view_rect,None);
    }
    #[test]fn lens_only_marks_a_real_part_of_a_display(){
        let d=display::PhysicalRect{x:0,y:0,width:1920,height:1080};
        assert!(!lens_on(d,d),"fit view retraces the border");
        assert!(!lens_on(d,display::PhysicalRect{x:40,y:20,width:1840,height:1040}),"near-fit stays hidden");
        assert!(lens_on(d,display::PhysicalRect{x:400,y:200,width:960,height:540}));
        assert!(lens_on(d,display::PhysicalRect{x:1500,y:0,width:1000,height:1080}),"all-screens view straddling a seam");
        assert!(!lens_on(d,display::PhysicalRect{x:1920,y:0,width:500,height:500}),"neighbour display only");
    }
    #[test]fn active_gap_viewport_hides_decoration_without_releasing_a_drag(){
        let mut r=Registry::default();r.authorize("a","phone","primary","name",view(),0);r.update("a",update(1,true),1);
        let was=r.entries["a"].input_active();let mut gap=update(2,true);gap.visible_display_ids.clear();assert!(r.update("a",gap,2));
        assert!(r.visible_entries().is_empty());assert!(!became_inactive(was,&r.entries["a"]),"no display intersection does not release held input");
        assert!(r.update("a",update(3,false),3));assert!(became_inactive(was,&r.entries["a"]),"actual screen inactivity does release owned input");
    }
    #[test] fn no_pending_presence_and_native_expiry_removes_stalled_pages() {
        let mut r=Registry::default();assert!(!r.update("unknown",update(1,true),0));assert!(r.visible_entries().is_empty());
        assert!(r.authorize("a","phone","primary","name",view(),0));assert!(r.visible_entries().is_empty());
        assert!(r.update("a",update(1,true),1));assert_eq!(r.visible_entries()[0].visible_ids,vec!["p"]);
        r.expire(PRESENCE_TTL_MS+2);assert!(r.visible_entries().is_empty());
        assert!(r.update("a",update(2,true),7000));assert_eq!(r.visible_entries().len(),1);
    }
    #[test] fn duplicates_retired_sessions_and_reconnect_history_are_isolated() {
        let mut r=Registry::default();r.authorize("a","phone","primary","a",view(),0);r.update("a",update(1,true),1);
        assert!(r.authorize("a","phone","primary","a",view(),2));assert_eq!(r.visible_entries().len(),1);
        r.authorize("b","phone","primary","b",view(),100);r.update("b",update(1,true),101);
        assert_eq!(r.visible_entries()[0].announcement_at,Some(1));
        r.end("a",true);assert!(!r.update("a",update(10,true),102));assert_eq!(r.visible_entries().len(),1);
        assert!(!r.update("b",update(1,false),103));assert!(r.visible_entries()[0].visible());
        r.update("b",update(2,false),104);assert!(r.visible_entries().is_empty());
        r.update("b",update(3,true),105);assert_eq!(r.visible_entries()[0].announcement_at,Some(1));
    }
    #[test] fn legacy_monitor_switch_and_topology_changes_fail_closed_until_applied() {
        let v=view();let mut layout=DisplaySnapshot{revision:1,bounds:v.source,displays:v.displays.clone()};
        let mut other=layout.displays[0].clone();other.id="other".into();other.index=1;other.x=1920;layout.displays.push(other);
        assert!(current_view(&v,"primary",&layout,0));
        assert!(!current_view(&v,"primary",&layout,1));
        assert!(current_view(&v,"aux:p",&layout,1));
        layout.revision=2;assert!(!current_view(&v,"primary",&layout,0));assert!(!current_view(&v,"aux:p",&layout,0));
    }
    #[test]fn announcement_duration_is_frozen_in_device_history_across_settings_and_peers(){
        let mut r=Registry::default();r.authorize("a","d","primary","n",view(),0);r.update("a",update(1,true),1);
        let mut longer=update(2,true);longer.appearance=serde_json::json!({"label":{"announcementSeconds":8}});r.update("a",longer.clone(),4000);assert_eq!(r.visible_entries()[0].announcement_seconds,3.);
        r.authorize("b","d","primary","n",view(),4100);r.update("b",longer.clone(),4101);assert_eq!(r.visible_entries()[0].announcement_seconds,3.);assert_eq!(r.visible_entries()[0].announcement_at,Some(1));
        r.end("b",true);r.authorize("c","d","primary","n",view(),5000);r.update("c",longer,5001);assert_eq!(r.visible_entries()[0].announcement_seconds,8.);
    }
}
