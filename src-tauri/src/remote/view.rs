//! Serializable capture-layout identity. Applying a new view is owned by the
//! capture pipeline; UI requests alone never advance this state.
use serde::{Deserialize,Serialize};
use super::display::{DisplayInfo,DisplaySnapshot,PhysicalRect};
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum ViewMode { Single, All }
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct AppliedView {
    pub epoch:u64,pub layout_revision:u64,pub mode:ViewMode,pub selected_display_id:String,
    pub source:PhysicalRect,pub width:u32,pub height:u32,pub displays:Vec<DisplayInfo>,
}
/// Identity belongs to the producing source, never the requested UI state.
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct CaptureIdentity { pub session_id:String,pub request_id:String,pub view:AppliedView }
impl CaptureIdentity {
    pub fn packet(&self,payload:Vec<u8>)->Vec<u8> {
        let header=serde_json::to_vec(self).unwrap_or_default();
        let mut result=Vec::with_capacity(6+header.len()+payload.len());
        result.extend_from_slice(b"GE");result.extend_from_slice(&(header.len() as u32).to_le_bytes());
        result.extend_from_slice(&header);result.extend_from_slice(&payload);result
    }
}
pub fn fit_size(source:PhysicalRect,max_width:u32,max_height:u32,max_pixels:u64)->(u32,u32) {
    if source.width==0 || source.height==0 {return (32,32);}
    let scale=1.0f64.min(max_width.max(32) as f64/source.width as f64).min(max_height.max(32) as f64/source.height as f64).min((max_pixels.max(1024) as f64/(source.width as f64*source.height as f64)).sqrt());
    (((source.width as f64*scale/2.).floor() as u32*2).max(32),((source.height as f64*scale/2.).floor() as u32*2).max(32))
}
impl AppliedView {
    pub fn create(snapshot:&DisplaySnapshot,mode:ViewMode,selected:&str,epoch:u64,max_width:u32,max_height:u32,max_pixels:u64)->Option<Self> {
        let d=snapshot.by_id(selected).or_else(||snapshot.displays.iter().find(|d|d.is_primary)).or(snapshot.displays.first())?;
        let displays=if mode==ViewMode::All {snapshot.displays.clone()} else {vec![d.clone()]};
        let source=super::display::union(&displays);
        let (width,height)=fit_size(source,max_width,max_height,max_pixels);
        Some(Self {epoch,layout_revision:snapshot.revision,mode,selected_display_id:d.id.clone(),source,width,height,displays})
    }
}
