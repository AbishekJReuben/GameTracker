import {identityFingerprint,parseCaptureIdentity,sameCapture,type CaptureIdentity} from './captureView';
type Send=(message:Record<string,unknown>)=>boolean;
type Factory=(configuration:RTCConfiguration)=>RTCPeerConnection;
const create:Factory=configuration=>new RTCPeerConnection(configuration);
export async function videoBinding(identity:CaptureIdentity,peerId:string,streamId:string,trackId:string,sdp:string):Promise<string>{
  const input=new TextEncoder().encode(JSON.stringify([identityFingerprint(identity),peerId,streamId,trackId,sdp]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',input)),b=>b.toString(16).padStart(2,'0')).join('');
}
/** One video m-line, one immutable MSID/track and no control/audio on this peer. */
export function validEpochSdp(sdp:string,streamId:string,trackId:string,offer:boolean):boolean{
  if(sdp.length>128_000||sdp.split(/\r?\n/).filter(l=>l.startsWith('m=video ')).length!==1||/^m=(?:audio|application) /m.test(sdp))return false;
  const msids=new Set(Array.from(sdp.matchAll(/^a=msid:([^\r\n]+)$/gm),m=>m[1].trim()));
  return offer?msids.size===1&&msids.has(`${streamId} ${trackId}`):msids.size===0;
}
interface OwnedPeer {pc:RTCPeerConnection;id:string;identity:CaptureIdentity;stream:MediaStream;sender?:RTCRtpSender;receiver?:RTCRtpReceiver;timer:ReturnType<typeof setTimeout>|null;sent:boolean;ice:RTCIceCandidateInit[];remoteIce:RTCIceCandidateInit[];sink?:HTMLVideoElement;frameCallback?:number;disposed:boolean;visibleConfirmed?:boolean;commitConfirmed?:boolean;displayAnnounced?:boolean}
function releaseSink(peer:OwnedPeer){if(peer.sink){if(peer.frameCallback!==undefined)peer.sink.cancelVideoFrameCallback?.(peer.frameCallback);peer.sink.pause();peer.sink.srcObject=null;peer.sink=undefined;}}
function retire(peer:OwnedPeer|null){if(!peer||peer.disposed)return;peer.disposed=true;if(peer.timer)clearTimeout(peer.timer);releaseSink(peer);peer.receiver?.track.stop();peer.pc.onicecandidate=null;peer.pc.ontrack=null;peer.pc.onconnectionstatechange=null;peer.pc.close();}
/** Each awaited continuation checks exact peer ownership. At most active +
 * pending video peers coexist; the base authorized audio/control peer is external. */
export class EpochVideoHost {
  private active:OwnedPeer|null=null;private pending:OwnedPeer|null=null;private closed=false;private serial=0;
  private directOwnsVideo=false;
  constructor(private sessionId:string,private send:Send,private configuration:()=>RTCConfiguration,private alive:()=>boolean,private acknowledge:(identity:CaptureIdentity)=>Promise<boolean>,private changed:(sender:RTCRtpSender,pc:RTCPeerConnection,identity:CaptureIdentity)=>void,private failed:(identity:CaptureIdentity,message:string,track:MediaStreamTrack)=>void,private factory:Factory=create){}
  private owns(peer:OwnedPeer){return !this.closed&&this.alive()&&!peer.disposed&&(this.pending===peer||this.active===peer);}
  get peer(){return this.active?.pc??null;}get sender(){return this.active?.sender??null;}get count(){return Number(!!this.active)+Number(!!this.pending);}
  async stage(identity:CaptureIdentity,track:MediaStreamTrack):Promise<void>{
    if(this.closed||!this.alive()||this.directOwnsVideo||identity.sessionId!==this.sessionId||sameCapture(this.pending?.identity,identity)||(sameCapture(this.active?.identity,identity)&&this.active?.stream.getVideoTracks()[0]===track))return;
    retire(this.pending);this.pending=null;
    let pc:RTCPeerConnection;try{pc=this.factory({...this.configuration(),bundlePolicy:'max-bundle',iceCandidatePoolSize:0});}catch(error){this.failed(identity,String(error),track);return;}const stream=new MediaStream([track]);
    const peer:OwnedPeer={pc,id:`${this.sessionId}-video-${++this.serial}`,identity,stream,timer:null,sent:false,ice:[],remoteIce:[],disposed:false};this.pending=peer;
    peer.sender=pc.addTrack(track,stream);
    pc.onicecandidate=e=>{if(!this.owns(peer)||!e.candidate)return;const candidate=e.candidate.toJSON();if(peer.sent)this.send({event:'epoch-video-ice',sessionId:this.sessionId,peerId:peer.id,candidate});else if(peer.ice.length<64)peer.ice.push(candidate);};
    pc.onconnectionstatechange=()=>{if(this.pending===peer&&this.owns(peer)&&['failed','closed'].includes(pc.connectionState))this.fail(peer,'RTC video connection failed');};
    peer.timer=setTimeout(()=>{if(this.pending===peer&&this.owns(peer))this.fail(peer,'RTC view setup timed out');},9000);
    try{
      const offer=await pc.createOffer();if(!this.owns(peer)||this.pending!==peer)return;
      await pc.setLocalDescription(offer);if(!this.owns(peer)||this.pending!==peer)return;
      const sdp=pc.localDescription?.sdp??'';if(!validEpochSdp(sdp,stream.id,track.id,true))throw new Error('RTC video offer did not contain the sole bound track');
      const binding=await videoBinding(identity,peer.id,stream.id,track.id,sdp);if(!this.owns(peer)||this.pending!==peer)return;
      if(!this.send({event:'epoch-video-offer',identity,peerId:peer.id,streamId:stream.id,trackId:track.id,sdp,binding}))throw new Error('Authorized channel unavailable');
      peer.sent=true;for(const candidate of peer.ice)this.send({event:'epoch-video-ice',sessionId:this.sessionId,peerId:peer.id,candidate});peer.ice=[];
    }catch(error){if(this.pending===peer&&this.owns(peer))this.fail(peer,String(error));}
  }
  async handle(message:Record<string,unknown>):Promise<boolean>{
    if(!String(message.type).startsWith('epoch-video-'))return false;
    const peer=this.pending?.id===message.peerId?this.pending:this.active?.id===message.peerId?this.active:null;
    if(!peer||message.sessionId!==this.sessionId||!this.owns(peer))return true;
    try{
      if(message.type==='epoch-video-answer'){
        const sdp=String(message.sdp??'');if(!validEpochSdp(sdp,'','',false))throw new Error('Invalid video-only answer');
        const binding=await videoBinding(peer.identity,peer.id,peer.stream.id,peer.stream.getVideoTracks()[0].id,sdp);
        if(!this.owns(peer)||this.pending!==peer)return true;if(binding!==message.binding)throw new Error('Video answer identity mismatch');
        await peer.pc.setRemoteDescription({type:'answer',sdp});if(!this.owns(peer))return true;
        for(const candidate of peer.remoteIce){await peer.pc.addIceCandidate(candidate);if(!this.owns(peer))return true;}peer.remoteIce=[];
      }else if(message.type==='epoch-video-ice'){
        if(!message.candidate||typeof message.candidate!=='object')return true;const candidate=message.candidate as RTCIceCandidateInit;
        if(peer.pc.remoteDescription){await peer.pc.addIceCandidate(candidate);if(!this.owns(peer))return true;}else if(peer.remoteIce.length<64)peer.remoteIce.push(candidate);
      }else if(message.type==='epoch-video-frame'&&message.epoch===peer.identity.view.epoch&&this.active===peer){this.sendCommit(peer);
      }else if(message.type==='epoch-video-commit-ok'&&this.active===peer&&message.epoch===peer.identity.view.epoch){peer.commitConfirmed=true;if(peer.timer)clearTimeout(peer.timer);peer.timer=null;
      }else if(message.type==='epoch-video-frame'&&message.epoch===peer.identity.view.epoch&&this.pending===peer){
        const accepted=await this.acknowledge(peer.identity);if(!accepted||!this.owns(peer)||this.pending!==peer)return true;
        if(peer.timer)clearTimeout(peer.timer);peer.timer=null;retire(this.active);this.active=peer;this.pending=null;
        this.changed(peer.sender!,peer.pc,peer.identity);this.sendCommit(peer);this.retryCommit(peer,0);
      }
    }catch(error){if(this.pending===peer&&this.owns(peer))this.fail(peer,String(error));}return true;
  }
  private sendCommit(peer:OwnedPeer){if(this.owns(peer))this.send({event:'epoch-video-committed',sessionId:this.sessionId,peerId:peer.id,epoch:peer.identity.view.epoch});}
  private retryCommit(peer:OwnedPeer,attempt:number){if(attempt>=16||peer.commitConfirmed||!this.owns(peer)||this.active!==peer)return;peer.timer=setTimeout(()=>{peer.timer=null;this.sendCommit(peer);this.retryCommit(peer,attempt+1);},400);}
  private fail(peer:OwnedPeer,message:string){if(this.pending!==peer)return;this.pending=null;retire(peer);this.failed(peer.identity,message,peer.stream.getVideoTracks()[0]);}
  cancelPending(){retire(this.pending);this.pending=null;}
  directCommit(identity:CaptureIdentity){this.directOwnsVideo=true;this.cancelPending();if(this.active&&!sameCapture(this.active.identity,identity)){retire(this.active);this.active=null;}}
  /** Explicit fallback re-enables RTC; a late capture callback cannot do so. */
  resumeRtc(){const wasDirect=this.directOwnsVideo;this.directOwnsVideo=false;return wasDirect;}
  close(){this.closed=true;retire(this.pending);retire(this.active);this.pending=null;this.active=null;}
}
export interface EpochStream {identity:CaptureIdentity;stream:MediaStream;peerId:string}
export interface EpochSurfaceStage extends EpochStream{element:HTMLVideoElement}
export class EpochVideoClient {
  private active:OwnedPeer|null=null;private pending:OwnedPeer|null=null;private closed=false;
  constructor(private sessionId:string,private send:Send,private configuration:()=>RTCConfiguration,private alive:()=>boolean,private stageView:(identity:CaptureIdentity)=>boolean,private display:(stream:EpochStream)=>void,private rendered:(identity:CaptureIdentity)=>boolean,private failed:(identity:CaptureIdentity,message:string,presented?:boolean)=>void,private factory:Factory=create,private element:()=>HTMLVideoElement=()=>document.createElement('video')){}
  private owns(peer:OwnedPeer){return !this.closed&&this.alive()&&!peer.disposed&&(this.pending===peer||this.active===peer);}
  get peer(){return (this.pending?.visibleConfirmed?this.pending:this.active)?.pc??null;}get receiver(){return (this.pending?.visibleConfirmed?this.pending:this.active)?.receiver??null;}get count(){return Number(!!this.active)+Number(!!this.pending);}
  get stagingIdentity(){return this.pending?.identity??null;}
  /** XR/PiP own their render loop while window rVFC can be suspended. They may
   * upload this exact new sink, then use presented() after their real draw. */
  get surfaceStage():EpochSurfaceStage|null{const peer=this.pending;if(!peer||!this.owns(peer)||!peer.receiver||!peer.sink||peer.sink.srcObject!==peer.stream)return null;return {identity:peer.identity,peerId:peer.id,stream:peer.stream,element:peer.sink};}
  private announce(peer:OwnedPeer){if(peer.displayAnnounced||!this.owns(peer)||this.pending!==peer)return;peer.displayAnnounced=true;this.display({identity:peer.identity,stream:peer.stream,peerId:peer.id});}
  async handle(message:Record<string,unknown>):Promise<boolean>{
    if(!String(message.event).startsWith('epoch-video-'))return false;
    if(message.event==='epoch-video-offer'){
      const identity=parseCaptureIdentity(message.identity);if(!identity||identity.sessionId!==this.sessionId||!this.alive()||this.closed)return true;
      const id=String(message.peerId??''),streamId=String(message.streamId??''),trackId=String(message.trackId??''),sdp=String(message.sdp??'');
      if(!id||id.length>256||!streamId||streamId.length>256||!trackId||trackId.length>256||!validEpochSdp(sdp,streamId,trackId,true))return true;
      if(this.active?.id===id||this.pending?.id===id)return true;
      if(!this.stageView(identity))return true;
      // A visible, unconfirmed pending peer is the last valid picture if its
      // acknowledgment was lost. Keep it as the local active peer while a new
      // rollback peer is prepared, maintaining the active + pending bound.
      if(this.pending?.visibleConfirmed){retire(this.active);this.active=this.pending;releaseSink(this.active);}else retire(this.pending);this.pending=null;
      let pc:RTCPeerConnection;try{pc=this.factory({...this.configuration(),bundlePolicy:'max-bundle',iceCandidatePoolSize:0});}catch(error){this.failed(identity,String(error));return true;}
      const peer:OwnedPeer={pc,id,identity,stream:new MediaStream(),timer:null,sent:false,ice:[],remoteIce:[],disposed:false};this.pending=peer;
      const sink=this.element();sink.muted=true;sink.autoplay=true;sink.playsInline=true;peer.sink=sink;
      pc.onicecandidate=e=>{if(!this.owns(peer)||!e.candidate)return;const candidate=e.candidate.toJSON();if(peer.sent)this.send({type:'epoch-video-ice',sessionId:this.sessionId,peerId:id,candidate});else if(peer.ice.length<64)peer.ice.push(candidate);};
      pc.ontrack=e=>{
        if(!this.owns(peer)||this.pending!==peer||e.track.kind!=='video'||e.track.id!==trackId||e.streams.length!==1||e.streams[0].id!==streamId||peer.receiver)return;
        peer.stream=e.streams[0];peer.receiver=e.receiver;sink.srcObject=peer.stream;
        // A distinct sink for this exact track establishes that a new view is
        // displayable. The visible sink must then confirm its own rendered frame.
        if(!sink.requestVideoFrameCallback){this.fail(peer,'This browser cannot associate a rendered RTC frame with its view');return;}
        peer.frameCallback=sink.requestVideoFrameCallback(()=>{if(this.owns(peer)&&this.pending===peer&&sink.srcObject===peer.stream&&e.track.readyState==='live')this.announce(peer);});
        void sink.play().catch(()=>{});
      };
      peer.timer=setTimeout(()=>{if(this.pending===peer&&this.owns(peer)){if(peer.visibleConfirmed){peer.timer=null;this.failed(peer.identity,'Waiting for host view confirmation',true);}else this.fail(peer,'RTC displayed-frame acknowledgment timed out');}},9500);
      try{
        const binding=await videoBinding(identity,id,streamId,trackId,sdp);if(!this.owns(peer)||this.pending!==peer)return true;if(binding!==message.binding)throw new Error('Video offer identity mismatch');
        await pc.setRemoteDescription({type:'offer',sdp});if(!this.owns(peer)||this.pending!==peer)return true;
        for(const candidate of peer.remoteIce){await pc.addIceCandidate(candidate);if(!this.owns(peer)||this.pending!==peer)return true;}peer.remoteIce=[];
        const answer=await pc.createAnswer();if(!this.owns(peer)||this.pending!==peer)return true;
        await pc.setLocalDescription(answer);if(!this.owns(peer)||this.pending!==peer)return true;
        const local=pc.localDescription?.sdp??'';const answerBinding=await videoBinding(identity,id,streamId,trackId,local);if(!this.owns(peer)||this.pending!==peer)return true;
        this.send({type:'epoch-video-answer',sessionId:this.sessionId,peerId:id,sdp:local,binding:answerBinding});peer.sent=true;
        for(const candidate of peer.ice)this.send({type:'epoch-video-ice',sessionId:this.sessionId,peerId:id,candidate});peer.ice=[];
      }catch(error){if(this.owns(peer)&&this.pending===peer)this.fail(peer,String(error));}return true;
    }
    const peer=this.pending?.id===message.peerId?this.pending:this.active?.id===message.peerId?this.active:null;
    if(!peer||message.sessionId!==this.sessionId||!this.owns(peer))return true;
    if(message.event==='epoch-video-ice'&&message.candidate&&typeof message.candidate==='object'){
      try{if(peer.pc.remoteDescription){await peer.pc.addIceCandidate(message.candidate as RTCIceCandidateInit);if(!this.owns(peer))return true;}else if(peer.remoteIce.length<64)peer.remoteIce.push(message.candidate as RTCIceCandidateInit);}catch{if(this.pending===peer)this.fail(peer,'RTC video ICE failed');}
    }else if(message.event==='epoch-video-committed'&&message.epoch===peer.identity.view.epoch){
      this.confirm(peer);
    }return true;
  }
  /** Called only by the newly keyed visible element's rVFC, checking its exact
   * source/track. Old buffered video cannot acknowledge a different epoch. */
  presented(peerId:string,element:HTMLVideoElement):boolean{
    const peer=this.pending?.id===peerId?this.pending:this.active?.id===peerId?this.active:null;
    if(!peer||!this.owns(peer)||element.srcObject!==peer.stream||element.readyState<2||!peer.stream.getVideoTracks().some(t=>t.readyState==='live'))return false;
    this.announce(peer);
    if(!this.rendered(peer.identity))return false;
    peer.visibleConfirmed=true;
    return this.send({type:'epoch-video-frame',sessionId:this.sessionId,peerId:peer.id,epoch:peer.identity.view.epoch});
  }
  private confirm(peer:OwnedPeer){if(!peer.visibleConfirmed)return;if(peer.timer)clearTimeout(peer.timer);peer.timer=null;releaseSink(peer);if(this.active!==peer)retire(this.active);this.active=peer;if(this.pending===peer)this.pending=null;this.send({type:'epoch-video-commit-ok',sessionId:this.sessionId,peerId:peer.id,epoch:peer.identity.view.epoch});}
  reconcileApplied(identity:CaptureIdentity){const peer=this.pending&&sameCapture(this.pending.identity,identity)?this.pending:this.active&&sameCapture(this.active.identity,identity)?this.active:null;if(peer&&this.owns(peer)&&peer.visibleConfirmed)this.confirm(peer);}
  private fail(peer:OwnedPeer,message:string){if(this.pending!==peer)return;this.pending=null;retire(peer);this.failed(peer.identity,message);}
  cancelPending(){retire(this.pending);this.pending=null;}
  directCommit(identity:CaptureIdentity){this.cancelPending();if(this.active&&!sameCapture(this.active.identity,identity)){retire(this.active);this.active=null;}}
  close(){this.closed=true;retire(this.pending);retire(this.active);this.pending=null;this.active=null;}
}
