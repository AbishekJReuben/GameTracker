import {parseHandshake,REMOTE_CAPABILITIES} from './remoteProtocol';
import type {AppliedCaptureView} from './displayLayout';
export interface CaptureIdentity {sessionId:string;requestId:string;view:AppliedCaptureView}
export interface ViewRequest {requestId:string;mode:'single'|'all';selectedDisplayId:string;maxWidth:number}
export interface ViewStatus {requested:CaptureIdentity;applied:CaptureIdentity|null;pending:boolean;error:string|null;layout?:import('./displayLayout').DisplaySnapshot|null}
/** Validate the complete immutable source geometry at every trust boundary. */
export function parseCaptureIdentity(raw:unknown):CaptureIdentity|null{
  if(!raw||typeof raw!=='object')return null;const identity=raw as CaptureIdentity;
  if(typeof identity.requestId!=='string'||!identity.requestId||identity.requestId.length>128||!identity.view||identity.view.epoch<1)return null;
  const h=parseHandshake({version:1,capabilities:REMOTE_CAPABILITIES,sessionId:identity.sessionId,layout:{revision:identity.view.layoutRevision,bounds:identity.view.source,displays:identity.view.displays},view:identity.view,overlayAvailable:false});
  return h?{sessionId:h.sessionId,requestId:identity.requestId,view:h.view}:null;
}
export function identityKey(identity:CaptureIdentity):string{return `${identity.sessionId}:${identity.view.epoch}`;}
export function identityFingerprint(identity:CaptureIdentity):string{
  const v=identity.view;return JSON.stringify([identity.sessionId,identity.requestId,v.epoch,v.layoutRevision,v.mode,v.selectedDisplayId,v.source.x,v.source.y,v.source.width,v.source.height,v.width,v.height,v.displays.map(d=>[d.id,d.index,d.name,d.x,d.y,d.width,d.height,d.rotation,d.isPrimary,d.selected,d.layoutRevision])]);
}
export function sameCapture(a:CaptureIdentity|null|undefined,b:CaptureIdentity|null|undefined):boolean{return !!a&&!!b&&identityFingerprint(a)===identityFingerprint(b);}
/** Rust GE packets put the producing source's identity immediately around its
 * encoded image. No external callback can relabel a queued old encoder result. */
export function parseCapturePacket(bytes:ArrayBuffer):{identity:CaptureIdentity|null;payload:ArrayBuffer}|null{
  const data=new Uint8Array(bytes);if(data[0]!==0x47||data[1]!==0x45)return {identity:null,payload:bytes};
  if(data.length<7)return null;const size=new DataView(bytes).getUint32(2,true);if(size===0||size>32_768||size+6>=data.length)return null;
  try{const identity=parseCaptureIdentity(JSON.parse(new TextDecoder().decode(data.subarray(6,6+size))));return identity?{identity,payload:bytes.slice(6+size)}:null;}catch{return null;}
}
/** Client transactions are committed by a specific rendered sink, not a config,
 * button event, feed acceptance, frame size or the old element's buffered frame. */
export class DisplayedView {
  private session='';private pending:CaptureIdentity|null=null;private applied:CaptureIdentity|null=null;
  private known=new Map<number,string>();private requestCounter=0;private requested=false;
  private unconfirmed:CaptureIdentity|null=null;
  private wanted:string|null=null;
  constructor(private notify:(state:{applied:CaptureIdentity|null;pending:CaptureIdentity|null;changing:boolean;error?:string})=>void,private ack:(identity:CaptureIdentity)=>void){}
  reset(session=''){this.session=session;this.pending=null;this.applied=null;this.unconfirmed=null;this.wanted=null;this.known.clear();this.requested=false;this.publish();}
  get current(){return this.applied;}get staging(){return this.pending;}get changing(){return this.requested||!!this.pending||!!this.unconfirmed;}
  request(){this.requested=true;const id=`view-${++this.requestCounter}`;this.wanted=id;this.publish();return id;}
  failRequest(id:string,error:string){if(this.wanted!==id)return false;this.wanted=null;this.requested=false;if(this.pending?.requestId===id)this.pending=null;this.publish(error);return true;}
  observe(raw:unknown):CaptureIdentity|null{
    const next=parseCaptureIdentity(raw);if(!next||next.sessionId!==this.session)return null;
    if(this.wanted&&next.requestId!==this.wanted&&!sameCapture(this.applied,next)){
      if(/^(?:native|quality|rollback|monitor)-\d+$/.test(next.requestId)){this.wanted=null;this.requested=false;}else return null;
    }
    const fingerprint=identityFingerprint(next),existing=this.known.get(next.view.epoch);
    if(existing&&existing!==fingerprint)return null;
    const highest=Math.max(this.pending?.view.epoch??0,this.applied?.view.epoch??0);
    if(next.view.epoch<highest)return null;
    this.known.set(next.view.epoch,fingerprint);while(this.known.size>4)this.known.delete(this.known.keys().next().value!);
    if(sameCapture(this.applied,next))return next;
    this.pending=next;this.requested=true;this.publish();return next;
  }
  /** Caller must own this exact decoded/rendered sink generation. */
  presented(identity:CaptureIdentity,sendAck=true):boolean{
    if(!sameCapture(this.pending,identity)){return sameCapture(this.applied,identity)&&!this.pending;}
    this.applied=identity;this.pending=null;this.requested=!!this.wanted&&this.wanted!==identity.requestId;this.unconfirmed=identity;this.publish();if(sendAck)this.ack(identity);return true;
  }
  confirm(identity:CaptureIdentity):boolean{if(!sameCapture(this.applied,identity))return false;this.unconfirmed=null;if(this.wanted===identity.requestId){this.wanted=null;this.requested=false;}this.publish();return true;}
  fail(message:string){this.pending=null;this.requested=false;this.publish(message);}
  private publish(error?:string){this.notify({applied:this.applied,pending:this.pending,changing:this.changing,error});}
}
