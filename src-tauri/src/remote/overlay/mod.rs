//! Desktop-only native decoration. Only the separate remote-host process may
//! start the manager; its worker exclusively owns COM, HWND and GPU resources.
use super::{appearance::Appearance,display::DisplayInfo};
use std::time::Instant;
#[derive(Clone,Debug,serde::Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct OverlayStatus {pub available:bool,pub degraded:bool,pub active_display_ids:Vec<String>,pub failed_displays:std::collections::HashMap<String,String>,pub message:Option<String>}
#[derive(serde::Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct PresenceReply {pub accepted:bool,pub overlay:OverlayStatus}
pub(crate) mod effects;
#[derive(Clone,Debug,PartialEq)]
pub(crate) struct OverlayDisplay {
    pub display:DisplayInfo,pub names:Vec<String>,pub appearance:Appearance,
    pub session_ids:Vec<String>,pub announcement_at:Option<Instant>,pub announcement_seconds:f32,
}
#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
mod manager;
#[cfg(windows)]
pub(crate) mod aurora;

pub(crate) fn prepare()->bool {
    if !crate::hostproc::is_remote_host() {return false;}
    #[cfg(windows)] {manager::prepare()}
    #[cfg(not(windows))] {false}
}
pub(crate) fn refresh(scene:Vec<OverlayDisplay>) {
    if !crate::hostproc::is_remote_host() {return;}
    #[cfg(windows)] manager::refresh(scene);
    #[cfg(not(windows))] let _=scene;
}
pub(crate) fn shutdown() {
    #[cfg(windows)] manager::shutdown();
}
pub(crate) fn reaction(session_id:&str,x:i32,y:i32) {
    if !crate::hostproc::is_remote_host(){return;}
    #[cfg(windows)] manager::reaction(session_id,x,y);
    #[cfg(not(windows))] let _=(session_id,x,y);
}
pub(crate) fn status()->OverlayStatus {
    #[cfg(windows)] {let s=manager::snapshot();OverlayStatus{available:s.available,degraded:s.error.is_some()||!s.failed_displays.is_empty(),active_display_ids:s.active_display_ids,failed_displays:s.failed_displays,message:s.error}}
    #[cfg(not(windows))] {OverlayStatus{available:false,degraded:false,active_display_ids:Vec::new(),failed_displays:Default::default(),message:Some("Desktop decoration requires a supported Windows host".into())}}
}
#[cfg(windows)]
pub(crate) fn snapshot()->manager::Statistics {manager::snapshot()}
