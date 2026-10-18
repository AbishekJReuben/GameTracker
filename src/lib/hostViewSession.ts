import {api} from './api';
import {parseCaptureIdentity,sameCapture,type CaptureIdentity,type ViewRequest,type ViewStatus} from './captureView';
/** Native owns authorization/geometry/input. This coordinator serializes guest
 * requests and transports only the identity attached to an actual source frame. */
export class HostViewSession{
  private closed=false;private serial=0;private requestSerial=0;private expectedRequest:string|null=null;
  private latest:CaptureIdentity|null=null;private accepted:CaptureIdentity|null=null;private known=new Map<number,CaptureIdentity>();
  private chain:Promise<unknown>=Promise.resolve();private timer:ReturnType<typeof setInterval>|null=null;private polling=false;
  constructor(readonly sessionId:string,private enabled:()=>boolean,private alive:()=>boolean,private send:(message:Record<string,unknown>)=>boolean,private captureChanged:(identity:CaptureIdentity)=>void,private committed:(identity:CaptureIdentity,mode:'direct'|'rtc')=>void){}
  private live(){return !this.closed&&this.alive()&&this.enabled();}
  get identity(){return this.latest;}get applied(){return this.accepted;}
  observe(raw:unknown):CaptureIdentity|null{
    const identity=parseCaptureIdentity(raw);if(!this.live()||!identity||identity.sessionId!==this.sessionId)return null;
    if(this.expectedRequest&&identity.requestId!==this.expectedRequest&&!/^(?:native|quality|rollback|monitor)-\d+$/.test(identity.requestId))return null;
    if(this.latest&&identity.view.epoch<this.latest.view.epoch)return null;
    const prior=this.known.get(identity.view.epoch);if(prior&&!sameCapture(prior,identity))return null;
    this.known.set(identity.view.epoch,identity);while(this.known.size>4)this.known.delete(this.known.keys().next().value!);
    if(!sameCapture(this.latest,identity)){++this.serial;this.latest=identity;this.captureChanged(identity);this.send({event:'view-capture',identity});}
    return identity;
  }
  async acknowledge(identity:CaptureIdentity,mode:'direct'|'rtc'='direct'):Promise<boolean>{
    if(!this.live()||!sameCapture(this.latest,identity))return false;
    const accepted=await api.remoteViewAcknowledge(this.sessionId,identity.view.epoch).catch(()=>false);
    if(!this.live()||!sameCapture(this.latest,identity)||!accepted)return false;
    ++this.serial;this.accepted=identity;this.expectedRequest=null;this.committed(identity,mode);this.send({event:'view-applied',identity});return true;
  }
  async handle(message:Record<string,unknown>):Promise<boolean>{
    if(message.type==='view-request'){
      if(!this.live())return true;const request=message.request as ViewRequest;
      if(!request||typeof request.requestId!=='string'||request.requestId.length>128)return true;
      const serial=++this.requestSerial;++this.serial;this.expectedRequest=request.requestId;
      this.chain=this.chain.catch(()=>{}).then(async()=>{
        if(!this.live()||serial!==this.requestSerial)return;
        try{const identity=await api.remoteViewRequest(this.sessionId,request);if(!this.live()||serial!==this.requestSerial)return;this.send({event:'view-requested',identity});}
        catch(error){if(this.live()&&serial===this.requestSerial){this.expectedRequest=null;this.send({event:'view-error',sessionId:this.sessionId,requestId:request.requestId,message:String(error)});}}
      });await this.chain;return true;
    }
    if(message.type==='view-frame'){
      if(!this.live()||message.sessionId!==this.sessionId||typeof message.epoch!=='number')return true;
      const identity=this.known.get(message.epoch);if(identity)await this.acknowledge(identity);return true;
    }
    return false;
  }
  async fail(identity:CaptureIdentity,message:string){
    if(!this.live()||!sameCapture(this.latest,identity))return;
    const serial=this.serial;const status=await api.remoteViewCancel(this.sessionId,identity.view.epoch).catch(()=>null);
    if(this.live()&&serial===this.serial&&sameCapture(this.latest,identity)&&status){this.sendStatus(status);this.send({event:'view-error',sessionId:this.sessionId,identity,message});}
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>void this.poll(),500);}
  private async poll(){
    if(!this.live()||this.polling)return;this.polling=true;const serial=this.serial;
    try{const status=await api.remoteViewStatus(this.sessionId);if(this.live()&&serial===this.serial&&status)this.sendStatus(status);}catch{}finally{this.polling=false;}
  }
  private sendStatus(status:ViewStatus){this.send({event:'view-state',sessionId:this.sessionId,status});}
  close(){this.closed=true;++this.serial;if(this.timer)clearInterval(this.timer);this.timer=null;this.known.clear();}
}
