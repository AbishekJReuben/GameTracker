import {sameCapture,type CaptureIdentity} from './captureView';
type GeneratorTrack=MediaStreamTrack&{writable:WritableStream<VideoFrame>};
interface Feed{identity:CaptureIdentity|null;canvas:HTMLCanvasElement;context:CanvasRenderingContext2D;track:MediaStreamTrack|null;writer:WritableStreamDefaultWriter<VideoFrame>|null;pendingWrites:number;nextTs:number;disposed:boolean}
function close(feed:Feed|null){if(!feed||feed.disposed)return;feed.disposed=true;void feed.writer?.close().catch(()=>{});feed.track?.stop();feed.canvas.width=1;feed.canvas.height=1;}
/** Separate canvases/tracks prevent a new layout from entering the old epoch's
 * still-visible RTC track. Latest-wins decode has a generation check after every
 * asynchronous bitmap creation. Only active + pending feeds are retained. */
export class CaptureVideoFeed{
  private legacy:Feed;private active:Feed|null=null;private pending:Feed|null=null;private desired:CaptureIdentity|null=null;
  private closed=false;private revision=0;private decoding=false;private newest:{bytes:ArrayBuffer;identity:CaptureIdentity|null}|null=null;
  constructor(private fps:()=>number,private alive:()=>boolean,private direct:(canvas:HTMLCanvasElement,identity:CaptureIdentity|null)=>boolean,private ready:(identity:CaptureIdentity,track:MediaStreamTrack)=>void){this.legacy=this.make(null);this.ensureTrack(this.legacy);}
  get track(){return this.legacy.track!;}get count(){return Number(!!this.active)+Number(!!this.pending);}
  private make(identity:CaptureIdentity|null):Feed{const canvas=document.createElement('canvas');canvas.width=identity?.view.width??1280;canvas.height=identity?.view.height??720;const context=canvas.getContext('2d',{alpha:false,desynchronized:true});if(!context)throw new Error('Capture canvas unavailable');return {identity,canvas,context,track:null,writer:null,pendingWrites:0,nextTs:0,disposed:false};}
  private ensureTrack(feed:Feed){
    if(feed.track)return;const Constructor=(window as unknown as {MediaStreamTrackGenerator?:new(init:{kind:'video'})=>GeneratorTrack}).MediaStreamTrackGenerator;
    if(Constructor){try{const track=new Constructor({kind:'video'});feed.track=track;feed.writer=track.writable.getWriter();}catch{}}
    if(!feed.track)feed.track=feed.canvas.captureStream?.().getVideoTracks()[0]??null;
    if(!feed.track)throw new Error('Capture video track unavailable');
    if(feed.identity)this.ready(feed.identity,feed.track);
  }
  select(identity:CaptureIdentity|null){if(sameCapture(this.desired,identity)||(!this.desired&&!identity))return;this.desired=identity;++this.revision;this.newest=null;}
  private feed(identity:CaptureIdentity|null):Feed{
    if(!identity)return this.legacy;if(sameCapture(this.pending?.identity,identity))return this.pending!;if(sameCapture(this.active?.identity,identity))return this.active!;
    close(this.pending);return this.pending=this.make(identity);
  }
  paint(bytes:ArrayBuffer,identity:CaptureIdentity|null){
    this.select(identity);if(this.closed||!this.alive())return;
    if(this.decoding){this.newest={bytes,identity};return;}void this.decode(bytes,identity);
  }
  private async decode(bytes:ArrayBuffer,identity:CaptureIdentity|null){
    this.decoding=true;const revision=this.revision;const feed=this.feed(identity);const bitmaps:ImageBitmap[]=[];
    const current=()=>!this.closed&&this.alive()&&!feed.disposed&&revision===this.revision&&(!identity||sameCapture(this.desired,identity));
    try{
      const data=new Uint8Array(bytes);const strips=data.length>=8&&data[0]===71&&data[1]===83;
      let width=0,height=0;const positions:number[]=[];const jobs:Promise<ImageBitmap>[]=[];
      if(strips){const view=new DataView(bytes);width=view.getUint16(3,true);height=view.getUint16(5,true);const count=data[7];if(count===0||count>64)throw new Error('Invalid JPEG strips');let offset=8;
        for(let i=0;i<count;i++){if(offset+8>data.length)throw new Error('Truncated JPEG strips');const y=view.getUint16(offset,true),length=view.getUint32(offset+4,true);offset+=8;if(!length||offset+length>data.length)throw new Error('Invalid JPEG strip size');positions.push(y);jobs.push(createImageBitmap(new Blob([data.slice(offset,offset+length)],{type:'image/jpeg'}),{colorSpaceConversion:'none'}));offset+=length;}
      }else{positions.push(0);jobs.push(createImageBitmap(new Blob([bytes],{type:'image/jpeg'}),{colorSpaceConversion:'none'}));}
      // allSettled also closes successful bitmaps if one strip rejects.
      const results=await Promise.allSettled(jobs);for(const result of results)if(result.status==='fulfilled')bitmaps.push(result.value);
      if(!current()||bitmaps.length!==jobs.length)return;
      if(!strips){width=bitmaps[0].width;height=bitmaps[0].height;}
      if(identity&&(width!==identity.view.width||height!==identity.view.height))return;
      if(feed.canvas.width!==width||feed.canvas.height!==height){feed.canvas.width=width;feed.canvas.height=height;}
      bitmaps.forEach((bitmap,i)=>feed.context.drawImage(bitmap,0,positions[i]));
      if(!current())return;
      if(this.direct(feed.canvas,identity))return;
      // Track creation follows the first valid paint, including captureStream's
      // implicit first image. No default black canvas can prove a view.
      this.ensureTrack(feed);this.push(feed);
    }catch{/* a later complete frame retries */}finally{
      for(const bitmap of bitmaps)bitmap.close();this.decoding=false;const next=this.newest;this.newest=null;if(next&&!this.closed)void this.decode(next.bytes,next.identity);
    }
  }
  private push(feed:Feed){if(!feed.writer||feed.pendingWrites>2)return;const duration=Math.round(1_000_000/Math.max(1,this.fps())),now=Math.round(performance.now()*1000);if(!feed.nextTs||feed.nextTs<now-duration*4)feed.nextTs=now;
    const frame=new VideoFrame(feed.canvas,{timestamp:feed.nextTs,duration});feed.nextTs+=duration;feed.pendingWrites++;void feed.writer.write(frame).catch(()=>{}).finally(()=>{feed.pendingWrites--;frame.close();});
  }
  commit(identity:CaptureIdentity){if(!sameCapture(this.pending?.identity,identity))return;close(this.active);this.active=this.pending;this.pending=null;}
  /** A failed peer owns exactly this pending track. Never discard a replacement
   * track (including a newer rebuild of the same immutable view). */
  reject(identity:CaptureIdentity,track:MediaStreamTrack):boolean{
    if(!sameCapture(this.pending?.identity,identity)||this.pending?.track!==track)return false;
    close(this.pending);this.pending=null;++this.revision;this.newest=null;return true;
  }
  rebuild(identity:CaptureIdentity){if(this.pending)return false;++this.revision;this.pending=this.make(identity);this.desired=identity;return true;}
  setContentHint(hint:string){for(const feed of [this.legacy,this.active,this.pending])if(feed?.track)try{feed.track.contentHint=hint;}catch{}}
  close(){this.closed=true;++this.revision;this.newest=null;close(this.legacy);close(this.active);close(this.pending);this.active=null;this.pending=null;}
}
