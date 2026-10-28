#![cfg(windows)]
use windows::{core::{s,Result},Win32::{Foundation::RECT,Graphics::{Direct3D::{Fxc::*,ID3DBlob,D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST},Direct3D11::*}}};
use super::{super::appearance::Appearance,effects::{Lens,Reaction,MAX_LENSES,MAX_RIPPLES},windows::RenderDevice};
use std::time::Instant;
#[repr(C)]#[derive(Clone,Copy,Default)]
pub struct Parameters {
    screen:[f32;4],flow:[f32;4],border:[f32;4],aura:[f32;4],primary:[f32;4],secondary:[f32;4],accent:[f32;4],
    cursor:[f32;4],halo:[f32;4],ripple_style:[f32;4],effect:[f32;4],ripples:[[f32;4];MAX_RIPPLES],
    lens_look:[f32;4],lens_rect:[[f32;4];MAX_LENSES],lens_state:[[f32;4];MAX_LENSES],
}
impl Parameters {
    pub fn lens_count(&self)->usize {self.lens_state.iter().filter(|s|s[3]>0.&&s[0]>0.).count()}
    /// Lens geometry is already smoothed by `Lens::step`; this only packs it.
    pub fn set_lenses(&mut self,lenses:&[Lens],a:&Appearance,dpi:f32) {
        self.lens_look=[(a.number("border.thickness")*0.85).max(0.75)*dpi,a.number("border.cornerSoftness")*0.75*dpi,a.number("lens.strength")*(0.5+0.5*a.number("intensity")),36.*dpi];
        let resting=a.number("lens.resting");self.lens_rect=Default::default();self.lens_state=Default::default();
        for (i,l) in lenses.iter().take(MAX_LENSES).enumerate() {self.lens_rect[i]=l.current;self.lens_state[i]=[l.level(resting),l.energy,0.,1.];}
    }
    pub fn reaction_count(&self)->usize {if self.ripple_style[1]<=0.||self.flow[1]<=0.{0}else{self.ripples.iter().filter(|r|r[3]>0.).count()}}
    pub fn new(rect:super::super::display::PhysicalRect,a:&Appearance,dpi:f32,phase:f32,opacity:f32,reduce:bool,cursor:Option<(i32,i32)>,velocity:[f32;2],reactions:&[Reaction],now:Instant)->Self {
        let color=|key|{let [r,g,b]=a.color(key);[r,g,b,0.]};
        let mut p=Self{screen:[rect.width as f32,rect.height as f32,rect.x as f32,rect.y as f32],flow:[phase,a.number("intensity"),a.number("border.fade")*dpi,a.number("border.cornerSoftness")*dpi],
            border:[a.number("border.thickness")*dpi,a.number("border.opacity"),a.number("border.glow"),a.number("aurora.ribbons")],
            aura:[a.number("aurora.softness"),if reduce{0.}else{a.number("aurora.reaction")},a.number("tint.strength"),a.number("tint.reach")*dpi],
            primary:color("palette.primary"),secondary:color("palette.secondary"),accent:color("palette.accent"),
            cursor:cursor.map(|(x,y)|[(x-rect.x) as f32,(y-rect.y) as f32,velocity[0],velocity[1]]).unwrap_or([-10000.,-10000.,0.,0.]),
            halo:[a.number("halo.radius")*dpi,if a.enabled("halo.enabled"){a.number("halo.opacity")}else{0.},a.number("halo.softness"),if reduce{0.}else{a.number("halo.response")}],
            ripple_style:[a.number("ripples.size")*dpi,if a.enabled("ripples.enabled")&&!reduce{a.number("ripples.strength")}else{0.},a.number("ripples.thickness")*dpi,a.number("ripples.duration")],
            effect:[opacity,if reduce{1.}else{0.},if cursor.is_some(){1.}else{0.},0.],..Default::default()};
        for (i,r) in reactions.iter().rev().take(MAX_RIPPLES).enumerate(){p.ripples[i]=[(r.x-rect.x) as f32,(r.y-rect.y) as f32,now.saturating_duration_since(r.at).as_secs_f32(),1.];}p
    }
    /// Returns true only when every smoothed appearance coefficient has reached
    /// its exact target. Static/reduced scenes must render until then as well.
    pub fn approach(&mut self,next:Self,dt:f32)->bool {
        let k=1.-(-dt.max(0.)/0.15).exp();let mut settled=true;
        let mut blend=|old:&mut[f32;4],target:[f32;4]|{for i in 0..4{old[i]+=(target[i]-old[i])*k;if (old[i]-target[i]).abs()<0.0001{old[i]=target[i];}else{settled=false;}}};
        self.screen=next.screen;self.flow[0]=next.flow[0];let mut next_flow=next.flow;next_flow[0]=self.flow[0];blend(&mut self.flow,next_flow);
        blend(&mut self.border,next.border);blend(&mut self.aura,next.aura);blend(&mut self.primary,next.primary);blend(&mut self.secondary,next.secondary);blend(&mut self.accent,next.accent);blend(&mut self.halo,next.halo);blend(&mut self.ripple_style,next.ripple_style);
        self.cursor=next.cursor;self.effect=next.effect;self.ripples=next.ripples;
        self.lens_look=next.lens_look;self.lens_rect=next.lens_rect;self.lens_state=next.lens_state;
        settled
    }
}
#[cfg(test)]mod tests {
    use super::*;
    #[test]fn lenses_pack_in_shader_order_and_scale_with_resting_level(){
        // HLSL packs every float4 into one 16-byte register; any padding would
        // silently shift the lens arrays.
        assert_eq!(std::mem::size_of::<Parameters>(),(11+MAX_RIPPLES+1+2*MAX_LENSES)*16);
        let rect=super::super::super::display::PhysicalRect{x:0,y:0,width:1920,height:1080};let a=Appearance::default();
        let mut p=Parameters::new(rect,&a,1.,0.,1.,false,None,[0.,0.],&[],Instant::now());assert_eq!(p.lens_count(),0);
        let mut still=Lens::new("s",[100.,100.,800.,450.],true);still.retarget([100.,100.,800.,450.],true);
        p.set_lenses(&[still],&a,1.);assert_eq!(p.lens_count(),1);assert_eq!(p.lens_rect[0],[100.,100.,800.,450.]);assert_eq!(p.lens_state[0][0],a.number("lens.resting"));
        let off=Appearance::validate(&{let mut v=serde_json::to_value(&a).unwrap();v["lens"]["strength"]=0.into();v});p.set_lenses(&[],&off,1.);assert_eq!(p.lens_count(),0);assert_eq!(p.lens_look[2],0.);
    }
    #[test]fn compact_static_and_reduced_edits_converge_exactly_including_disabled_layers(){
        let rect=super::super::super::display::PhysicalRect{x:0,y:0,width:1920,height:1080};let now=Instant::now();let initial=Appearance::default();
        let mut target=serde_json::to_value(&initial).unwrap();target["intensity"]=0.into();target["halo"]["enabled"]=false.into();target["ripples"]["enabled"]=false.into();target["border"]["thickness"]=6.into();target["aurora"]["speed"]=0.into();target["motion"]="reduce".into();let target=Appearance::validate(&target);
        let mut p=Parameters::new(rect,&initial,1.,0.,1.,false,None,[0.,0.],&[],now);let goal=Parameters::new(rect,&target,1.,0.,1.,true,None,[0.,0.],&[],now);
        assert!(!p.approach(goal,1./30.));let mut done=false;for _ in 0..100{done=p.approach(goal,1./30.);if done{break;}}
        assert!(done);assert_eq!(p.flow[1],0.);assert_eq!(p.halo[1],0.);assert_eq!(p.ripple_style[1],0.);assert_eq!(p.border[0],6.);
        // A system-policy transition is an invalidation even without movement
        // or a preference edit; the final painted ripple must be cleared.
        let mut policy=super::super::effects::MotionPolicy::default();assert!(policy.update(true));
        let click=Reaction{session_id:"s".into(),x:800,y:600,at:now};let mut rendered=Parameters::new(rect,&initial,1.,0.,1.,false,None,[0.,0.],&[click],now);
        let reduced=Parameters::new(rect,&initial,1.,0.,1.,true,None,[0.,0.],&[],now);let _=rendered.approach(reduced,1./30.);assert!(rendered.ripples.iter().all(|r|r[3]==0.));
    }
}
pub struct Aurora {context:ID3D11DeviceContext,vs:ID3D11VertexShader,ps:ID3D11PixelShader,buffer:ID3D11Buffer,raster:ID3D11RasterizerState}
impl Aurora {
    pub fn new(renderer:&RenderDevice)->Result<Self> {unsafe{
        let code=include_str!("aurora.hlsl");
        let compile=|entry,target|->Result<ID3DBlob>{let mut blob=None;let mut error=None;
            D3DCompile(code.as_ptr().cast(),code.len(),None,None,None,entry,target,D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&mut blob,Some(&mut error)).map_err(|e|{
                if let Some(error)=error {let bytes=std::slice::from_raw_parts(error.GetBufferPointer().cast::<u8>(),error.GetBufferSize());eprintln!("[overlay] shader: {}",String::from_utf8_lossy(bytes));}e
            })?;blob.ok_or_else(windows::core::Error::from_win32)};
        let vs_code=compile(s!("vs"),s!("vs_4_0"))?;let ps_code=compile(s!("ps"),s!("ps_4_0"))?;
        let mut vs=None;let mut ps=None;let mut buffer=None;let mut raster=None;
        renderer.device.CreateVertexShader(std::slice::from_raw_parts(vs_code.GetBufferPointer().cast(),vs_code.GetBufferSize()),None::<&ID3D11ClassLinkage>,Some(&mut vs))?;
        renderer.device.CreatePixelShader(std::slice::from_raw_parts(ps_code.GetBufferPointer().cast(),ps_code.GetBufferSize()),None::<&ID3D11ClassLinkage>,Some(&mut ps))?;
        renderer.device.CreateBuffer(&D3D11_BUFFER_DESC{ByteWidth:std::mem::size_of::<Parameters>() as u32,Usage:D3D11_USAGE_DEFAULT,BindFlags:D3D11_BIND_CONSTANT_BUFFER.0 as u32,..Default::default()},None,Some(&mut buffer))?;
        renderer.device.CreateRasterizerState(&D3D11_RASTERIZER_DESC{FillMode:D3D11_FILL_SOLID,CullMode:D3D11_CULL_NONE,ScissorEnable:true.into(),DepthClipEnable:true.into(),..Default::default()},Some(&mut raster))?;
        Ok(Self{context:renderer.context.clone(),vs:vs.unwrap(),ps:ps.unwrap(),buffer:buffer.unwrap(),raster:raster.unwrap()})
    }}
    pub fn draw(&self,target:&ID3D11RenderTargetView,p:&Parameters) {unsafe{
        self.context.ClearRenderTargetView(target,&[0.,0.,0.,0.]);
        self.context.UpdateSubresource(&self.buffer,0,None,p as *const _ as *const _,0,0);
        self.context.OMSetRenderTargets(Some(&[Some(target.clone())]),None::<&ID3D11DepthStencilView>);
        self.context.OMSetBlendState(None::<&ID3D11BlendState>,None,u32::MAX);
        self.context.RSSetState(&self.raster);self.context.RSSetViewports(Some(&[D3D11_VIEWPORT{Width:p.screen[0],Height:p.screen[1],MaxDepth:1.,..Default::default()}]));
        self.context.IASetInputLayout(None::<&ID3D11InputLayout>);self.context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        self.context.VSSetShader(&self.vs,None);self.context.PSSetShader(&self.ps,None);self.context.PSSetConstantBuffers(0,Some(&[Some(self.buffer.clone())]));
        let w=p.screen[0] as i32;let h=p.screen[1] as i32;let edge=p.flow[2].max(p.aura[3]).ceil() as i32+2;
        let mut regions=vec![RECT{left:0,top:0,right:w,bottom:edge.min(h)},RECT{left:0,top:(h-edge).max(0),right:w,bottom:h},RECT{left:0,top:0,right:edge.min(w),bottom:h},RECT{left:(w-edge).max(0),top:0,right:w,bottom:h}];
        let mut add=|x:f32,y:f32,r:f32|{let rect=RECT{left:(x-r).floor().max(0.) as i32,top:(y-r).floor().max(0.) as i32,right:(x+r).ceil().min(w as f32) as i32,bottom:(y+r).ceil().min(h as f32) as i32};if rect.right>rect.left&&rect.bottom>rect.top {regions.push(rect);}};
        if p.effect[2]>0.&&p.halo[1]>0.{add(p.cursor[0],p.cursor[1],p.halo[0]*2.5);}
        if p.ripple_style[1]>0.{for r in p.ripples.iter().filter(|r|r[3]>0.) {add(r[0],r[1],p.ripple_style[0]+p.ripple_style[2]*3.);}}
        // A lens only touches thin bands along its own edges; the area inside
        // and outside stays a plain clear, like the middle of the screen.
        for (r,_) in p.lens_rect.iter().zip(&p.lens_state).filter(|(_,s)|s[3]>0.&&s[0]>0.) {
            let reach=p.lens_look[3]+p.lens_look[0]*2.;let [x,y,lw,lh]=*r;
            for (l,t,rr,b) in [(x-reach,y-reach,x+lw+reach,y+reach),(x-reach,y+lh-reach,x+lw+reach,y+lh+reach),(x-reach,y-reach,x+reach,y+lh+reach),(x+lw-reach,y-reach,x+lw+reach,y+lh+reach)] {
                let rect=RECT{left:l.floor().max(0.) as i32,top:t.floor().max(0.) as i32,right:rr.ceil().min(w as f32) as i32,bottom:b.ceil().min(h as f32) as i32};
                if rect.right>rect.left&&rect.bottom>rect.top {regions.push(rect);}
            }
        }
        for rect in regions {self.context.RSSetScissorRects(Some(&[rect]));self.context.Draw(3,0);}
        self.context.OMSetRenderTargets(None,None::<&ID3D11DepthStencilView>);
    }}
}
