import {DisplayedView,parseCaptureIdentity,sameCapture,type CaptureIdentity,type ViewStatus} from '@/lib/captureView';
import {EpochVideoClient,type EpochStream} from '@/lib/epochVideo';
import {parseHandshake,supportsRemote,type RemoteHandshake} from '@/lib/remoteProtocol';
import type {DisplaySnapshot} from '@/lib/displayLayout';
export class ClientViewSession{
  private handshake:RemoteHandshake|null=null;private video:EpochVideoClient|null=null;
  private stream:EpochStream|null=null;private closed=false;private layout:DisplaySnapshot|null=null;
  private directPending:CaptureIdentity|null=null;private ackTimer:ReturnType<typeof setInterval>|null=null;
  private directActive=false;
  private lastError='';
  private failureEpoch:number|null=null;
  private failureHasFrame=false;
  private view=new DisplayedView(state=>this.event({event:'remote-view',...state}),identity=>{this.directPending=identity;this.ackDirect();});
  constructor(private send:(message:Record<string,unknown>)=>boolean,private event:(message:{event:string;[k:string]:unknown})=>void,private configuration:()=>RTCConfiguration,private alive:()=>boolean,private display:(stream:EpochStream)=>void,private confirmed:(identity:CaptureIdentity,layout:DisplaySnapshot|null)=>void,private failed:(message:string)=>void){}
  accept(handshake:RemoteHandshake|null){
    if(handshake?.sessionId===this.handshake?.sessionId)return;this.video?.close();this.video=null;this.stream=null;this.directPending=null;this.directActive=false;this.lastError='';this.failureEpoch=null;this.failureHasFrame=false;if(this.ackTimer)clearInterval(this.ackTimer);this.ackTimer=null;this.handshake=handshake;this.layout=handshake?.layout??null;this.view.reset(handshake?.sessionId??'');
    if(!supportsRemote(handshake,'view-epoch-input-v1'))return;
    const sid=handshake!.sessionId;
    this.video=new EpochVideoClient(sid,this.send,this.configuration,()=>!this.closed&&this.alive()&&this.handshake?.sessionId===sid,
      identity=>!!this.view.observe(identity),
      stream=>{if(!this.accepts(stream.identity))return;this.stream=stream;this.display(stream);},
      identity=>{this.directPending=null;this.directActive=false;const accepted=this.view.presented(identity,false);if(accepted)this.markPresented(identity);return accepted;},
      (identity,message,presented)=>{if(this.accepts(identity))this.reportFailure(message,identity,false,presented);});
    this.ackTimer=setInterval(()=>this.ackDirect(),400);
  }
  get enabled(){return supportsRemote(this.handshake,'view-epoch-input-v1');}get current(){return this.view.current;}get changing(){return this.enabled&&this.view.changing;}get rtc(){return this.stream;}get peer(){return this.video?.peer??null;}get receiver(){return this.video?.receiver??null;}
  get surfaceStage(){return this.video?.surfaceStage??null;}
  request(mode:'single'|'all',selectedDisplayId:string,maxWidth:number):boolean{
    if(!this.enabled||!this.alive())return false;const requestId=this.view.request(),sent=this.send({type:'view-request',request:{requestId,mode,selectedDisplayId,maxWidth}});if(!sent)this.view.failRequest(requestId,'Control channel unavailable');return sent;
  }
  observe(raw:unknown):CaptureIdentity|null{
    if(!this.enabled)return null;const identity=this.view.observe(raw);if(identity&&this.video?.stagingIdentity&&this.video.stagingIdentity.view.epoch<identity.view.epoch)this.video.cancelPending();return identity;
  }
  accepts(identity:CaptureIdentity){return sameCapture(this.view.staging,identity)||(!this.view.staging&&sameCapture(this.view.current,identity));}
  directPresented(identity:CaptureIdentity):boolean{
    if(!this.accepts(identity)||!this.view.presented(identity))return false;
    this.markPresented(identity);
    if(!this.directActive){this.directActive=true;this.directPending=identity;this.ackDirect();}
    this.video?.directCommit(identity);if(this.stream&&!sameCapture(this.stream.identity,identity))this.stream=null;return true;
  }
  rtcPresented(peerId:string,element:HTMLVideoElement){return this.video?.presented(peerId,element)??false;}
  useRtc(){this.directActive=false;this.directPending=null;}
  handle(message:Record<string,unknown>):boolean{
    if(!this.enabled)return false;
    if(String(message.event).startsWith('epoch-video-')){
      // Offers can cross DIRECT's displayed-frame acknowledgment on separate
      // channels. Re-ack the already proven source so older hosts retire the
      // redundant RTC timer too. Explicit fallback calls useRtc() first.
      const identity=message.event==='epoch-video-offer'?parseCaptureIdentity(message.identity):null;
      if(this.directActive&&identity&&sameCapture(this.view.current,identity)){
        if(this.accepts(identity)){this.directPending=identity;this.ackDirect();}return true;
      }
      void this.video?.handle(message);return true;
    }
    if(message.event==='view-capture'||message.event==='view-requested'){this.observe(message.identity);return true;}
    if(message.event==='view-applied'){
      const identity=parseCaptureIdentity(message.identity);if(identity)this.confirm(identity);return true;
    }
    if(message.event==='view-state'&&message.sessionId===this.handshake?.sessionId){
      const status=message.status as ViewStatus;const requested=parseCaptureIdentity(status?.requested),applied=parseCaptureIdentity(status?.applied);
      const accepted=requested?this.observe(requested):null;
      if(status?.layout&&accepted){const parsed=parseHandshake({...this.handshake,layout:status.layout,view:accepted.view});if(parsed&&parsed.layout.revision>=(this.layout?.revision??0))this.layout=parsed.layout;}
      if(status?.pending&&requested&&sameCapture(this.directPending,requested))this.ackDirect();
      if(accepted&&status.error&&this.view.changing){const key=`${accepted.view.epoch}:${status.error}`;if(key!==this.lastError){this.lastError=key;this.reportFailure(String(status.error),accepted);}}
      if(applied&&!status.pending&&sameCapture(requested,applied))this.confirm(applied);return true;
    }
    if(message.event==='view-error'&&message.sessionId===this.handshake?.sessionId){
      const identity=parseCaptureIdentity(message.identity);
      if(message.identity&&(!identity||!this.accepts(identity)))return true;
      const error=String(message.message??'View change failed'),rejected=typeof message.requestId==='string';
      if(rejected&&!this.view.failRequest(message.requestId as string,error))return true;
      this.reportFailure(error,identity??undefined,rejected);return true;
    }
    return false;
  }
  private ackDirect(){const identity=this.directPending;if(!identity||this.closed||!this.alive()||!this.accepts(identity))return;this.send({type:'view-frame',sessionId:identity.sessionId,epoch:identity.view.epoch});}
  private reportFailure(message:string,identity?:CaptureIdentity,rejected=false,presented=false){
    this.failureEpoch=(identity?.view.epoch??this.view.staging?.view.epoch??this.view.current?.view.epoch??0)+(rejected?1:0);
    this.failureHasFrame=presented||(!rejected&&!!identity&&sameCapture(this.view.current,identity)&&this.view.changing);this.failed(message);
  }
  private markPresented(identity:CaptureIdentity){if(this.failureEpoch!==null&&identity.view.epoch>=this.failureEpoch)this.failureHasFrame=true;this.recovered(identity);}
  private recovered(identity:CaptureIdentity){if(this.failureEpoch!==null&&this.failureHasFrame&&identity.view.epoch>=this.failureEpoch&&!this.view.changing){this.failureEpoch=null;this.lastError='';this.event({event:'remote-view-recovered',identity});}}
  private confirm(identity:CaptureIdentity){if(!this.view.confirm(identity))return;if(sameCapture(this.directPending,identity))this.directPending=null;this.video?.reconcileApplied(identity);
    this.recovered(identity);
    this.confirmed(identity,this.layout);}
  close(){this.closed=true;if(this.ackTimer)clearInterval(this.ackTimer);this.ackTimer=null;this.directPending=null;this.video?.close();this.video=null;this.stream=null;this.view.reset();}
}
