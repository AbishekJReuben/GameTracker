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
