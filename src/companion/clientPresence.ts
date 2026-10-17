import { REMOTE_PREF_EVENT, readAppearance, readControllerName } from './remotePreferences';
import { parseHandshake, parseOverlayStatus, supportsRemote, type ClientViewReport, type RemoteHandshake, type RemotePresenceUpdate, type RemoteOverlayStatus } from '@/lib/remoteProtocol';
/** Visibility policy comes from CloudConn's existing debounced powerIdle state.
 * This adapter does not create a second background/PiP grace interpretation. */
export class ClientPresence {
  private handshake:RemoteHandshake|null=null;
  private view:ClientViewReport|null=null;
  private sequence=0;
  private timer:number|null=null;
  private updateTimer:number|null=null;
  private scope={sink:false,idle:false,pip:false,immersive:false};
  private closed=false;
  overlayStatus:RemoteOverlayStatus|null=null;
  constructor(private send:(message:Record<string,unknown>)=>boolean, private onHandshake?:(h:RemoteHandshake|null)=>void) {
    window.addEventListener(REMOTE_PREF_EVENT,this.onPreference);
  }
  private onPreference=()=>{
    // Coalesce text entry and all appearance sliders; a drag cannot flood SCTP.
    if(this.updateTimer!==null)return;
    this.updateTimer=window.setTimeout(()=>{this.updateTimer=null;this.publish();},80);
  };
  accept(raw:unknown) {
    const h=parseHandshake(raw);
    const changed=h?.sessionId!==this.handshake?.sessionId;
    this.handshake=h&&!changed&&this.handshake&&this.handshake.view.epoch>h.view.epoch?{...h,view:this.handshake.view,layout:this.handshake.layout}:h;
    if(changed)this.overlayStatus=h?{available:h.overlayAvailable,degraded:false,activeDisplayIds:[],failedDisplays:{},message:null}:null;
    if(changed){this.sequence=0;this.view=h?{mode:h.view.mode,epoch:h.view.epoch,selectedDisplayId:h.view.selectedDisplayId,visibleDisplayIds:h.view.displays.map(d=>d.id)}:null;}
    this.onHandshake?.(h);
    if(this.timer!==null){window.clearInterval(this.timer);this.timer=null;}
    if(supportsRemote(h,'view-state-v1')){this.publish();this.timer=window.setInterval(()=>this.publish(),1000);}
  }
  reset(){this.accept(null);}
  get negotiated(){return this.handshake;}
  applyView(view:import('@/lib/displayLayout').AppliedCaptureView,layout:import('@/lib/displayLayout').DisplaySnapshot|null){
    if(!this.handshake)return;this.handshake={...this.handshake,view,layout:layout?.revision===view.layoutRevision?layout:this.handshake.layout};
    this.view={mode:view.mode,epoch:view.epoch,selectedDisplayId:view.selectedDisplayId,visibleDisplayIds:view.displays.map(d=>d.id)};this.publish();
  }
  setOverlayStatus(raw:unknown){const status=parseOverlayStatus(raw);if(status&&this.handshake)this.overlayStatus=status;}
  setScope(scope:Partial<typeof this.scope>){this.scope={...this.scope,...scope};this.publish();}
  setView(view:ClientViewReport){if(this.view&&JSON.stringify(this.view)===JSON.stringify(view))return;this.view=view;this.publish();}
  publish(){
    if(this.closed || !supportsRemote(this.handshake,'view-state-v1') || !this.view)return;
    const {sink,idle,pip,immersive}=this.scope;
    const visible=sink&&!idle;
    const update:RemotePresenceUpdate={sequence:++this.sequence,displayName:readControllerName(),controlVisible:visible&&!pip&&!immersive,pipVisible:visible&&pip,immersiveVisible:visible&&immersive,...this.view,viewEpoch:this.view.epoch,appearance:readAppearance().value};
    if(!visible)update.visibleDisplayIds=[];
    else if(pip)update.visibleDisplayIds=[this.view.selectedDisplayId];
    this.send({type:'presence',update});
  }
  close(){
    if(this.closed)return;
    this.setScope({sink:false});this.closed=true;
    if(this.timer!==null)window.clearInterval(this.timer);
    if(this.updateTimer!==null)window.clearTimeout(this.updateTimer);
    this.timer=null;this.updateTimer=null;window.removeEventListener(REMOTE_PREF_EVENT,this.onPreference);
  }
}
