//! Interruptible native notice/ripple state. Transport-peer lifetime is not the
//! announcement clock: presence supplies the device/scope history timestamp.
use std::time::{Duration,Instant};
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum NoticeState {Hidden,Arriving,Announcement,Settling,Compact,Leaving}
#[derive(Clone,Copy,Debug)]
pub struct NoticeFrame {pub state:NoticeState,pub opacity:f32,pub expansion:f32}
pub struct Notice {arrival:Instant,dwell:f32,departure:Option<(Instant,NoticeFrame)>}
fn ease(t:f32)->f32 {let x=t.clamp(0.,1.);1.-(1.-x).powi(3)}
impl Notice {
    pub fn new(arrival:Option<Instant>,now:Instant,dwell:f32)->Self {Self {arrival:arrival.unwrap_or(now-Duration::from_secs(30)),dwell:dwell.clamp(0.5,8.),departure:None}}
    pub fn resume(&mut self) {self.departure=None;}
    pub fn leave(&mut self,now:Instant,dwell:f32,reduce:bool) {if self.departure.is_none(){let frame=self.sample(now,dwell,reduce);self.departure=Some((now,frame));}}
    pub fn sample(&self,now:Instant,_live_dwell:f32,reduce:bool)->NoticeFrame {
        if let Some((at,from))=self.departure {
            let t=now.saturating_duration_since(at).as_secs_f32()/if reduce{0.1}else{0.2};
            return NoticeFrame{state:if t>=1.{NoticeState::Hidden}else{NoticeState::Leaving},opacity:from.opacity*(1.-ease(t)),expansion:from.expansion};
        }
        let age=now.saturating_duration_since(self.arrival).as_secs_f32();
        // Freeze this arrival's timeline. Live duration edits apply to a future
        // announcement; neither a compact nor settling notice can expand again.
        let dwell=self.dwell;let arrive=0.45;let settle=0.4;
        if age<arrive {NoticeFrame{state:NoticeState::Arriving,opacity:ease(age/if reduce{0.12}else{arrive}),expansion:if reduce{0.}else{1.}}}
        else if age<arrive+dwell {NoticeFrame{state:NoticeState::Announcement,opacity:1.,expansion:if reduce{0.}else{1.}}}
        else if age<arrive+dwell+settle {NoticeFrame{state:NoticeState::Settling,opacity:1.,expansion:if reduce{0.}else{1.-ease((age-arrive-dwell)/settle)}}}
        else {NoticeFrame{state:NoticeState::Compact,opacity:1.,expansion:0.}}
    }
}
pub const MAX_RIPPLES:usize=8;
#[derive(Default)]pub struct MotionPolicy {reduced:bool}
impl MotionPolicy {pub fn update(&mut self,reduced:bool)->bool {let changed=self.reduced!=reduced;self.reduced=reduced;changed}}
#[derive(Clone,Debug)]
pub struct Reaction {pub session_id:String,pub x:i32,pub y:i32,pub at:Instant}
pub fn retain_reactions(reactions:&mut Vec<Reaction>,owners:&[String],now:Instant,duration:f32) {
    reactions.retain(|r|owners.contains(&r.session_id)&&now.saturating_duration_since(r.at).as_secs_f32()<duration);
    if reactions.len()>MAX_RIPPLES {reactions.drain(..reactions.len()-MAX_RIPPLES);}
}
pub const MAX_LENSES:usize=4;
/// One viewer's zoomed-in area on this display, smoothed on the render thread.
/// The phone reports ~15 Hz while a gesture runs; the lens glides between
/// reports, glows while the view moves and settles to its resting level.
#[derive(Clone,Debug)]
pub struct Lens {pub session_id:String,pub target:[f32;4],pub current:[f32;4],pub opacity:f32,pub energy:f32,pub leaving:bool}
impl Lens {
    pub fn new(session_id:&str,target:[f32;4],reduce:bool)->Self {
        // Arrives a touch wider and settles in, like a camera finding focus.
        let [x,y,w,h]=target;let grow=0.035;
        let wide=[x-w*grow,y-h*grow,w*(1.+2.*grow),h*(1.+2.*grow)];
        Self{session_id:session_id.into(),target,current:if reduce{target}else{wide},opacity:if reduce{1.}else{0.},energy:if reduce{0.}else{1.},leaving:false}
    }
    pub fn retarget(&mut self,target:[f32;4],reduce:bool) {
        let moved=self.target.iter().zip(target).any(|(a,b)|(a-b).abs()>0.5);
        self.target=target;self.leaving=false;
        if moved&&!reduce {self.energy=1.;}
    }
    /// Advances one frame. Returns false once everything sits exactly on its
    /// target, so a still lens costs no frames at all.
    pub fn step(&mut self,dt:f32,reduce:bool)->bool {
        let goal=if self.leaving{0.}else{1.};
        if reduce {self.current=self.target;self.energy=0.;self.opacity=goal;return false;}
        let glide=1.-(-dt.max(0.)/0.09).exp();let fade=1.-(-dt.max(0.)/0.16).exp();let mut moving=false;
        for i in 0..4 {self.current[i]+=(self.target[i]-self.current[i])*glide;if (self.current[i]-self.target[i]).abs()<0.25{self.current[i]=self.target[i];}else{moving=true;}}
        self.opacity+=(goal-self.opacity)*fade;if (self.opacity-goal).abs()<0.002{self.opacity=goal;}else{moving=true;}
        self.energy*=(-dt.max(0.)/0.8).exp();if self.energy<0.003{self.energy=0.;}else{moving=true;}
        moving
    }
    pub fn gone(&self)->bool {self.leaving&&self.opacity<=0.}
    /// Overall strength: the resting level while still, full while moving.
    pub fn level(&self,resting:f32)->f32 {self.opacity*(resting+(1.-resting)*self.energy)}
}
/// Matches render-thread lenses to the scene's targets (session id, local
/// rect). Lenses whose viewer zoomed out or left fade out where they were.
pub fn sync_lenses(lenses:&mut Vec<Lens>,targets:&[(String,[f32;4])],reduce:bool) {
    for lens in lenses.iter_mut() {if !targets.iter().any(|(sid,_)|*sid==lens.session_id){lens.leaving=true;}}
    for (sid,rect) in targets.iter().take(MAX_LENSES) {
        if let Some(l)=lenses.iter_mut().find(|l|l.session_id==*sid) {l.retarget(*rect,reduce);}
        else if lenses.len()<MAX_LENSES {lenses.push(Lens::new(sid,*rect,reduce));}
    }
}
#[cfg(test)]mod tests {
    use super::*;
    #[test]fn lens_glides_glows_then_rests_and_stops_costing_frames(){
        let mut l=Lens::new("s",[100.,100.,400.,300.],false);assert_eq!(l.opacity,0.);assert!(l.current[2]>400.);
        for _ in 0..30 {l.step(1./30.,false);}assert!((l.opacity-1.).abs()<0.01);assert!(l.energy<1.&&l.energy>0.);
        let before=l.level(0.5);l.retarget([300.,100.,400.,300.],false);assert_eq!(l.energy,1.);assert!(l.level(0.5)>before,"moving glows");
        let mut frames=0;while l.step(1./30.,false){frames+=1;assert!(frames<400);}
        assert_eq!(l.current,l.target);assert_eq!(l.energy,0.);assert_eq!(l.level(0.5),0.5);assert!(!l.step(1./30.,false),"settled lens is idle");
    }
    #[test]fn lens_reduced_motion_snaps_and_departures_fade_in_place(){
        let mut lenses=Vec::new();sync_lenses(&mut lenses,&[("a".into(),[10.,10.,100.,100.])],true);
        assert_eq!(lenses[0].current,[10.,10.,100.,100.]);assert_eq!(lenses[0].opacity,1.);assert_eq!(lenses[0].energy,0.);
        lenses[0].retarget([50.,10.,100.,100.],true);assert_eq!(lenses[0].energy,0.,"no glow under reduced motion");assert!(!lenses[0].step(0.03,true));assert_eq!(lenses[0].current[0],50.);
        let mut fading=vec![Lens::new("b",[0.,0.,50.,50.],false)];for _ in 0..30 {fading[0].step(1./30.,false);}
        sync_lenses(&mut fading,&[],false);assert!(fading[0].leaving);let at=fading[0].current;
        while fading[0].step(1./30.,false)&&!fading[0].gone(){}assert!(fading[0].gone());assert_eq!(fading[0].current,at);
        let many:Vec<_>=(0..9).map(|i|(format!("s{i}"),[0.,0.,10.,10.])).collect();let mut capped=Vec::new();sync_lenses(&mut capped,&many,false);assert_eq!(capped.len(),MAX_LENSES);
    }
    #[test]fn notice_runs_exact_states_and_interrupts_without_jump(){
        let start=Instant::now();let mut n=Notice::new(Some(start),start,3.);
        for (ms,state) in [(0,NoticeState::Arriving),(450,NoticeState::Announcement),(3440,NoticeState::Announcement),(3500,NoticeState::Settling),(3900,NoticeState::Compact)] {assert_eq!(n.sample(start+Duration::from_millis(ms),3.,false).state,state);}
        let now=start+Duration::from_millis(100);let before=n.sample(now,3.,false);n.leave(now,3.,false);let after=n.sample(now,3.,false);assert_eq!(after.state,NoticeState::Leaving);assert_eq!(before.opacity,after.opacity);assert_eq!(n.sample(now+Duration::from_millis(200),3.,false).state,NoticeState::Hidden);
    }
    #[test]fn reconnect_and_name_settings_do_not_replay_history_and_reduce_is_static(){
        let start=Instant::now();let now=start+Duration::from_secs(20);let mut n=Notice::new(Some(start),now,3.);assert_eq!(n.sample(now,3.,false).state,NoticeState::Compact);n.leave(now,3.,false);n.resume();assert_eq!(n.sample(now,3.,false).state,NoticeState::Compact);
        assert_eq!(Notice::new(Some(start),start,3.).sample(start+Duration::from_millis(150),3.,true).expansion,0.);
    }
    #[test]fn live_duration_changes_never_expand_a_settling_or_compact_notice(){
        let start=Instant::now();let n=Notice::new(Some(start),start,3.);
        let settling=start+Duration::from_millis(3600);let before=n.sample(settling,3.,false);let after=n.sample(settling,8.,false);assert_eq!(after.state,NoticeState::Settling);assert_eq!(after.expansion,before.expansion);
        let compact=start+Duration::from_secs(4);assert_eq!(n.sample(compact,8.,false).state,NoticeState::Compact);assert_eq!(n.sample(compact,8.,false).expansion,0.);
        assert_eq!(Notice::new(Some(start),start,8.).sample(compact,8.,false).state,NoticeState::Announcement);
    }
    #[test]fn reactions_are_bounded_expire_and_remove_ended_owners(){
        let now=Instant::now();let mut r:Vec<_>=(0..40).map(|i|Reaction{session_id:if i==39{"old"}else{"s"}.into(),x:i,y:0,at:now}).collect();retain_reactions(&mut r,&["s".into()],now,0.6);assert_eq!(r.len(),MAX_RIPPLES);assert_eq!(r.last().unwrap().x,38);retain_reactions(&mut r,&["s".into()],now+Duration::from_secs(1),0.6);assert!(r.is_empty());
    }
    #[test]fn stationary_compact_scene_is_invalidated_when_system_motion_changes(){
        let mut policy=MotionPolicy::default();assert!(!policy.update(false));assert!(policy.update(true));assert!(!policy.update(true));assert!(policy.update(false));
    }
}
