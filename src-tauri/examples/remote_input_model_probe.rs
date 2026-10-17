//! Pure shipping input/view model tests. Never creates Enigo or injects input.
#[path="../src/remote/display.rs"]pub(crate) mod display;
#[path="../src/remote/view.rs"]pub(crate) mod view;
#[path="../src/remote/view_session.rs"]pub(crate) mod view_session;
#[path="../src/remote/input_mapping.rs"]pub(crate) mod input_mapping;
#[path="../src/remote/input.rs"]pub(crate) mod input;
pub(crate) mod capture{
    pub fn selected_monitor()->usize{0}pub fn set_selected_monitor(_:usize){}
    pub fn monitor_bounds(_:usize)->Option<(i32,i32,u32,u32)>{None}
    pub fn set_view_identity(_:Option<std::sync::Arc<super::view::CaptureIdentity>>){}
}
pub(crate) mod presence{pub fn now_ms()->u64{0}pub fn apply_view(_: &str,_:super::view::AppliedView)->bool{true}}
pub(crate) mod overlay{pub fn reaction(_: &str,_:i32,_:i32){}}
pub(crate) mod gamepad{#[derive(serde::Deserialize)]pub struct GamepadState{}pub fn apply(_:GamepadState){}pub fn stop(){}}
mod remote{pub(crate)use super::{capture,gamepad,overlay};}
fn main(){println!("Run with cargo test --bin remote-input-model-probe; no OS input is injected.");}
