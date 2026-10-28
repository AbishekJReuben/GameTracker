import { useEffect,useRef,useState } from 'react';
import type { DesktopAppearance } from '../remotePreferences';
import { readControllerName } from '../remotePreferences';
import { AppearancePreviewClock,PreviewLens,appearancePreviewPoint,labelRest } from '../appearancePreviewModel';
/** Local tuning preview only. The actual desktop uses the native GPU renderer. */
export function DesktopAppearancePreview({appearance}:{appearance:DesktopAppearance}) {
  const canvas=useRef<HTMLCanvasElement>(null),value=useRef(appearance),phase=useRef(0),pointer=useRef({x:530,y:220});
  const clicks=useRef<{x:number;y:number;at:number}[]>([]),[light,setLight]=useState(false);
  value.current=appearance;
  useEffect(()=>{
    const element=canvas.current,ctx=element?.getContext('2d');if(!element||!ctx)return;
    let frame=0;const clock=new AppearancePreviewClock(performance.now(),phase.current),lens=new PreviewLens(performance.now());
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    const draw=(now:number)=>{
      frame=requestAnimationFrame(draw);
      const a=value.current,reduce=a.motion==='reduce'||reduced.matches;
      const time=clock.step(now,a.aurora.speed,reduce,document.hidden);phase.current=time.phase;const view=lens.step(now,reduce);if(!time.paint)return;
      const w=800,h=400,t=phase.current,i=a.intensity;
      ctx.clearRect(0,0,w,h);ctx.fillStyle=light?'#edf0f4':'#111722';ctx.fillRect(0,0,w,h);
      ctx.fillStyle=light?'#28334b':'#e2e8f4';ctx.font='600 17px system-ui';ctx.fillText('Your desktop stays readable',36,104);
      ctx.fillStyle=light?'#626b7d':'#76849e';ctx.font='14px system-ui';ctx.fillText('Desktop decoration stays out of the remote video.',36,134);
      for(let row=0;row<5;row++){ctx.fillStyle=light?'#dce1e9':'#1b2534';ctx.fillRect(36,165+row*27,250-(row%3)*40,9);}
      ctx.save();ctx.beginPath();ctx.roundRect(0,0,w,h,a.border.cornerSoftness);ctx.clip();
      const color=(hex:string,alpha:number)=>`${hex}${Math.round(Math.max(0,Math.min(1,alpha))*255).toString(16).padStart(2,'0')}`;
      const gradient=ctx.createLinearGradient(0,0,w,h);gradient.addColorStop(0,color(a.palette.primary,a.border.opacity*i));gradient.addColorStop(.7,color(a.palette.secondary,a.border.opacity*i));gradient.addColorStop(1,color(a.palette.accent,a.border.opacity*i*.5));
      for(const [rotation,length] of [[0,w],[Math.PI/2,h],[Math.PI,w],[Math.PI*1.5,h]]){
        ctx.save();ctx.translate(rotation===Math.PI/2||rotation===Math.PI?w:0,rotation>=Math.PI?h:0);ctx.rotate(rotation);
        const reach=Math.max(a.border.fade,a.tint.reach),g=ctx.createLinearGradient(0,0,0,reach);
        g.addColorStop(0,color(a.palette.primary,(a.tint.strength+a.border.glow*.12)*i));g.addColorStop(.28,color(a.palette.primary,a.tint.strength*i*.4));g.addColorStop(1,color(a.palette.primary,0));ctx.fillStyle=g;ctx.fillRect(0,0,length,reach);
        ctx.strokeStyle=color(a.palette.primary,a.aurora.ribbons*i*.18);ctx.lineWidth=1+a.aurora.softness*3;ctx.shadowBlur=a.aurora.softness*10;ctx.shadowColor=a.palette.primary;
        for(let ribbon=0;ribbon<2;ribbon++){ctx.beginPath();for(let x=0;x<=length;x+=6){const y=6+ribbon*12+Math.sin(x*.011+t*.4+ribbon)*4+Math.sin(x*.023-t*.21)*2;x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}ctx.stroke();}ctx.restore();
      }
      ctx.strokeStyle=gradient;ctx.lineWidth=a.border.thickness;ctx.strokeRect(a.border.thickness/2,a.border.thickness/2,w-a.border.thickness,h-a.border.thickness);
      const p=pointer.current;
      if(a.halo.enabled){const g=ctx.createRadialGradient(p.x,p.y,a.halo.radius*.2,p.x,p.y,a.halo.radius*(1+a.halo.softness));g.addColorStop(0,color(a.palette.primary,a.halo.opacity*i*.08));g.addColorStop(.5,color(a.palette.primary,a.halo.opacity*i*.6));g.addColorStop(1,color(a.palette.primary,0));ctx.fillStyle=g;ctx.fillRect(p.x-a.halo.radius*2,p.y-a.halo.radius*2,a.halo.radius*4,a.halo.radius*4);}
      clicks.current=clicks.current.filter(c=>(now-c.at)/1000<a.ripples.duration).slice(-8);
      if(a.ripples.enabled&&!reduce)for(const c of clicks.current){const life=(now-c.at)/1000/a.ripples.duration;ctx.strokeStyle=color(a.palette.primary,a.ripples.strength*i*(1-life)**2);ctx.lineWidth=a.ripples.thickness;ctx.beginPath();ctx.arc(c.x,c.y,a.ripples.size*(.18+.82*(1-(1-life)**3)),0,Math.PI*2);ctx.stroke();}
      // Viewing-area lens: what the PC traces around a zoomed-in view.
      const showLens=a.lens.enabled&&a.lens.strength>0;
      if(showLens){
        const [lx,ly,lw,lh]=view.rect,level=view.level(a.lens.resting)*a.lens.strength*(.5+.5*i),radius=Math.min(a.border.cornerSoftness*.75,Math.min(lw,lh)*.12);
        ctx.strokeStyle=color(a.palette.secondary,.16*level*(.45+.55*view.energy));ctx.lineWidth=9;ctx.beginPath();ctx.roundRect(lx-5,ly-5,lw+10,lh+10,radius+5);ctx.stroke();
        ctx.save();ctx.shadowColor=a.palette.primary;ctx.shadowBlur=6+10*view.energy;ctx.strokeStyle=color(a.palette.primary,.85*level);ctx.lineWidth=Math.max(.75,a.border.thickness*.85);
        ctx.beginPath();ctx.roundRect(lx,ly,lw,lh,radius);ctx.stroke();ctx.restore();
      }
      ctx.restore();
      // Identity remains readable even when decorative intensity is zero.
      const text=`Controlled remotely by ${readControllerName()}`;ctx.font=`600 ${a.label.size}px system-ui`;
      const width=Math.min(w-40,ctx.measureText(text).width+28),height=a.label.size+20,home=a.label.placement==='topLeft'?20:a.label.placement==='topRight'?w-20-width:(w-width)/2;
      const {x,y}=labelRest(home,12,width,height,showLens?view.rect:null,w,h);
      ctx.fillStyle=`rgba(6,9,14,${a.label.backing})`;ctx.beginPath();ctx.roundRect(x,y,width,height,10);ctx.fill();ctx.fillStyle='#fff';ctx.fillText(text,x+14,y+14+a.label.size*.5,width-28);
    };
    frame=requestAnimationFrame(draw);return()=>cancelAnimationFrame(frame);
  },[light]);
  return <div className="space-y-2">
    <div className="flex items-center justify-between text-xs text-ink-dim"><span>Preview on this device</span><button type="button" className="underline" onClick={()=>setLight(!light)}>{light?'Dark background':'Light background'}</button></div>
    <canvas ref={canvas} width={800} height={400} className="w-full rounded-xl border border-line" aria-label="Local desktop appearance preview. Move or tap to preview cursor feedback."
      onPointerMove={e=>{pointer.current=appearancePreviewPoint(e,e.currentTarget.getBoundingClientRect());}}
      onPointerDown={e=>{pointer.current=appearancePreviewPoint(e,e.currentTarget.getBoundingClientRect());clicks.current=[...clicks.current.slice(-7),{...pointer.current,at:performance.now()}];}} />
    <p className="text-[11px] text-ink-faint">Move or tap the preview for cursor feedback. The live indicator appears on the PC while Control or PiP is visible; the viewing area shows while you are zoomed in.</p>
  </div>;
}
