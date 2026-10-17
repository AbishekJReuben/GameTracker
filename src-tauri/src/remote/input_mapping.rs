//! Exact physical mapping independent of the OS injector, so exhaustive pixel,
//! seam, gap and negative-origin tests do not touch the workstation pointer.
use super::{display::PhysicalRect,view::AppliedView};
/// SendInput divides the unsigned 16-bit space into physical pixel bins. Use a
/// bin's center, rather than 65535/(extent-1), which misses negative-edge pixels.
pub fn absolute_bin(pixel:i32,origin:i32,extent:u32)->i32{
    let extent=extent.max(1) as i64;let offset=(pixel as i64-origin as i64).clamp(0,extent-1);
    (((offset*2+1)*65536)/(extent*2)).clamp(0,65535) as i32
}
pub fn point(view:&AppliedView,x:f32,y:f32)->Option<(i32,i32)>{
    let point=view.source.point(x,y)?;
    view.displays.iter().any(|d|d.rect().contains(point.0,point.1)).then_some(point)
}
pub fn contains(view:&AppliedView,x:i32,y:i32)->bool{view.displays.iter().any(|d|d.rect().contains(x,y))}
pub fn rect_point(rect:PhysicalRect,x:f32,y:f32)->Option<(i32,i32)>{rect.point(x,y)}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn every_pixel_in_negative_origins_odd_sizes_and_seams_lands_in_its_bin(){
        for(origin,extent)in[(-3840,7680),(-3840,3840),(-123,4219),(0,2160),(73,1),(0,65536)]{
            for pixel in origin..origin+extent{let n=absolute_bin(pixel,origin,extent as u32);let landed=origin+((n as i64*extent as i64)/65536) as i32;assert_eq!(landed,pixel,"origin={origin} extent={extent} n={n}");}
        }
    }
    #[test]fn nonfinite_outside_and_gap_anchors_are_rejected(){
        use super::super::{display::{DisplayInfo,DisplaySnapshot,union},view::ViewMode};
        let displays=vec![DisplayInfo{id:"left".into(),index:0,name:"l".into(),x:-1920,y:0,width:1920,height:1080,rotation:0,is_primary:false,selected:false,layout_revision:1},DisplayInfo{id:"right".into(),index:1,name:"r".into(),x:0,y:300,width:1920,height:1080,rotation:0,is_primary:true,selected:false,layout_revision:1}];
        let layout=DisplaySnapshot{revision:1,bounds:union(&displays),displays};let view=AppliedView::create(&layout,ViewMode::All,"right",1,1920,4096,8_294_400).unwrap();
        assert!(point(&view,0.75,0.).is_none());assert_eq!(point(&view,0.,0.),Some((-1920,0)));assert_eq!(point(&view,1.,1.),Some((1919,1379)));assert!(point(&view,f32::NAN,0.).is_none());assert!(point(&view,1.001,0.5).is_none());
    }
}
