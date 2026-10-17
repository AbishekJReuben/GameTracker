/** Session-scoped adapter. Authorization is established by rtcHost's existing
 * grant flow; learning an auth message never creates native presence. */
import { api } from './api';
import { negotiatedCapabilities, type RemoteHandshake, type RemotePresenceUpdate, type RemoteOverlayStatus } from './remoteProtocol';
import { normalizeControllerName } from '../companion/remotePreferences';
export class HostPresenceSession {
  private peer: { deviceId:string; displayName:string; capabilities:string[] } | null=null;
  private handshake:RemoteHandshake|null=null;
  private ended=false;
  constructor(private sessionId:string,private fixedMonitor?:number,private reportStatus?:(status:RemoteOverlayStatus)=>void) {}
  learnAuth(msg:Record<string,unknown>) {
    if(this.handshake || this.ended) return;
    this.peer={deviceId:typeof msg.deviceId==='string'?msg.deviceId.slice(0,256):'',displayName:normalizeControllerName(msg.displayName),capabilities:negotiatedCapabilities(msg.capabilities)};
  }
  async authorize():Promise<void> {
    if(!this.peer || this.ended || this.handshake || !this.peer.capabilities.includes('view-state-v1'))return;
    const h=await api.remotePresenceAuthorize(this.sessionId,this.peer.deviceId,this.peer.displayName,this.peer.capabilities,this.fixedMonitor).catch(()=>null);
    if(this.ended){if(h)void api.remotePresenceEnd(this.sessionId,false).catch(()=>{});return;}
    this.handshake=h;
  }
  authFields():Record<string,unknown> {return this.handshake?{remote:this.handshake}:{};}
  inputSessionId():string|undefined {return !this.ended&&this.handshake?this.sessionId:undefined;}
  get negotiated(){return this.ended?null:this.handshake;}
  handle(msg:Record<string,unknown>):boolean {
    if(msg.type!=='presence')return false;
    if(!this.ended && this.handshake) void api.remotePresenceUpdate(this.sessionId,msg.update as RemotePresenceUpdate).then(reply=>{
      if(!this.ended&&reply?.overlay)this.reportStatus?.(reply.overlay);
    }).catch(()=>{});
    return true;
  }
  end(explicit=false) {
    if(this.ended)return;
    this.ended=true;
    void api.remotePresenceEnd(this.sessionId,explicit).catch(()=>{});
  }
}
