import {videoContentRect,type VideoViewport} from '@/lib/displayLayout';

/** A single bounded still picture covers a changing sink. It never proves the
 * new view: only that sink's own painted/rVFC identity may finish the handoff. */
export class TransitionPicture{
  private active=false;private serial=0;private finishing=false;
  constructor(private target:()=>HTMLCanvasElement|null){}
  get visible(){return this.active;}
  get busy(){return this.active||this.finishing;}
  retain(source:CanvasImageSource,width:number,height:number,viewport:VideoViewport):boolean{
    if(this.active)return true;const canvas=this.target();if(!canvas||width<1||height<1||viewport.width<1||viewport.height<1)return false;
    const scale=Math.min(window.devicePixelRatio||1,2,Math.sqrt(4_194_304/(viewport.width*viewport.height)));
    try{
      canvas.width=Math.max(1,Math.floor(viewport.width*scale));canvas.height=Math.max(1,Math.floor(viewport.height*scale));
      const context=canvas.getContext('2d',{alpha:false});if(!context)return false;
      const rect=videoContentRect(width,height,viewport);context.setTransform(scale,0,0,scale,0,0);context.fillStyle='#000';context.fillRect(0,0,viewport.width,viewport.height);context.drawImage(source,rect.x,rect.y,rect.width,rect.height);
      this.active=true;this.finishing=false;++this.serial;canvas.hidden=false;return true;
    }catch{return false;}
  }
  finish(current:()=>boolean,visible:()=>void){
    if(this.finishing)return;this.finishing=true;const serial=++this.serial;
    // The real new frame is already displayable beneath the retained picture.
    // Remove the cover and wait for a complete browser paint before committing.
    const canvas=this.target();if(canvas)canvas.hidden=true;this.active=false;
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(serial!==this.serial)return;this.finishing=false;if(current())visible();
    }));
  }
  dispose(){++this.serial;this.active=false;this.finishing=false;const canvas=this.target();if(canvas){canvas.hidden=true;canvas.width=1;canvas.height=1;}}
}
