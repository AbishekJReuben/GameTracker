/** Local-preview clock integrates every callback, independently of paint cadence. */
export class AppearancePreviewClock {
  phase:number;
  private painted:number;
  private hidden=false;
  constructor(private last:number,phase=0){this.phase=phase;this.painted=last-40;}
  step(now:number,speed:number,reduce:boolean,hidden:boolean){
    const dt=Math.max(0,Math.min(.1,(now-this.last)/1000));this.last=now;
    if(!hidden&&!this.hidden&&!reduce)this.phase+=dt*speed;this.hidden=hidden;
    const paint=!hidden&&now-this.painted>=40;if(paint)this.painted=now;
    return {phase:this.phase,paint};
  }
}
export function appearancePreviewPoint(point:{clientX:number;clientY:number},rect:{left:number;top:number;width:number;height:number}) {
  return {x:(point.clientX-rect.left)/Math.max(1,rect.width)*800,y:(point.clientY-rect.top)/Math.max(1,rect.height)*400};
}
/** Spots the preview lens visits, in the 800×400 preview space: it glides to
 * the next one every few seconds, like a viewer panning around the desktop. */
export const PREVIEW_LENS_TARGETS:readonly (readonly [number,number,number,number])[]=[[420,150,330,190],[60,92,300,190],[250,205,300,160]];
/** Mirrors the PC renderer's lens motion (glide 90 ms, glow decays over ~2 s). */
export class PreviewLens {
  rect:number[];energy=1;
  private index=0;private moved:number;private last:number;
  constructor(now:number){this.rect=[...PREVIEW_LENS_TARGETS[0]];this.moved=now;this.last=now;}
  step(now:number,reduce:boolean){
    const dt=Math.max(0,Math.min(.1,(now-this.last)/1000));this.last=now;
    if(reduce){this.rect=[...PREVIEW_LENS_TARGETS[this.index]];this.energy=0;this.moved=now;return this;}
    if(now-this.moved>3600){this.moved=now;this.index=(this.index+1)%PREVIEW_LENS_TARGETS.length;this.energy=1;}
    const goal=PREVIEW_LENS_TARGETS[this.index],k=1-Math.exp(-dt/.09);
    this.rect=this.rect.map((v,i)=>v+(goal[i]-v)*k);this.energy*=Math.exp(-dt/.8);return this;
  }
  level(resting:number){return resting+(1-resting)*this.energy;}
}
/** Same rule as the PC (`windows.rs label_rest`): the compact label sits on
 * the lens's top edge, tucks inside when there is no room above, stays on screen. */
export function labelRest(x:number,y:number,width:number,height:number,lens:readonly number[]|null,screenW:number,screenH:number,scale=1):{x:number;y:number} {
  if(!lens)return {x,y};
  const pad=8*scale,gap=10*scale,clamp=(v:number,lo:number,hi:number)=>Math.min(Math.max(v,lo),Math.max(lo,hi));
  const above=lens[1]-height-gap;
  return {x:clamp(lens[0]+lens[2]/2-width/2,pad,screenW-width-pad),y:clamp(above>=pad?above:lens[1]+gap,pad,screenH-height-pad)};
}
