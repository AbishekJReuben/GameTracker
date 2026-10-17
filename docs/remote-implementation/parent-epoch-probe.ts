import {EpochVideoHost,EpochVideoClient} from '../../src/lib/epochVideo';
import {DisplayedView,sameCapture,type CaptureIdentity} from '../../src/lib/captureView';

const button=document.querySelector<HTMLButtonElement>('#run')!;
const status=document.querySelector<HTMLElement>('#status')!;
const result=document.querySelector<HTMLElement>('#result')!;
const screen=document.querySelector<HTMLElement>('#screen')!;
const sourceBox=document.querySelector<HTMLElement>('#sources')!;
const sid='parent-synthetic-epoch-probe';
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,label:string,ms=13000){const started=performance.now();while(!check()){if(performance.now()-started>ms)throw new Error(`${label} timed out`);await sleep(30);}}
function identity(epoch:number,id='left'):CaptureIdentity{
  const d={id,index:id==='left'?0:1,name:id,x:id==='left'?-1920:0,y:0,width:1920,height:1080,rotation:0 as const,isPrimary:id==='right',selected:true,layoutRevision:1};
  return {sessionId:sid,requestId:`fixture-${epoch}`,view:{mode:'single',selectedDisplayId:id,epoch,layoutRevision:1,source:{x:d.x,y:0,width:1920,height:1080},width:320,height:180,displays:[d]}};
}
button.onclick=async()=>{
  button.disabled=true;screen.replaceChildren();sourceBox.replaceChildren();result.textContent='';
  const started=performance.now(),log:Record<string,unknown>[]=[];const failures:string[]=[];
  let host:EpochVideoHost,client:EpochVideoClient,visible:HTMLVideoElement|null=null;
  let latest=identity(1),active:CaptureIdentity|null=null,alive=true,dropCommits=0,dropOffers=false;
  let maxHostPeers=0,maxClientPeers=0,closedPcs=0;const peers:RTCPeerConnection[]=[];
  const sources:{canvas:HTMLCanvasElement;stream:MediaStream;timer:number}[]=[];
  const displayed=new DisplayedView(()=>{},()=>{});displayed.reset(sid);
  const sample=document.createElement('canvas');sample.width=sample.height=1;const ctx=sample.getContext('2d')!;
  const colors=new Map<string,[number,number,number]>();const presentations:{epoch:number;color:number[];peerId:string}[]=[];const presentedOnce=new Set<string>();
  const factory=(configuration:RTCConfiguration)=>{const pc=new RTCPeerConnection(configuration);peers.push(pc);return pc;};
  const count=()=>{maxHostPeers=Math.max(maxHostPeers,host?.count??0);maxClientPeers=Math.max(maxClientPeers,client?.count??0);if((host?.count??0)>2||(client?.count??0)>2)throw new Error('Exceeded active + pending peer bound');};
  const source=(label:string,color:[number,number,number])=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;sourceBox.append(canvas);const context=canvas.getContext('2d')!;let frame=0;
    const paint=()=>{context.fillStyle=`rgb(${color.join(',')})`;context.fillRect(0,0,320,180);context.fillStyle='#fff';context.font='16px system-ui';context.fillText(`${label}: ${++frame}`,8,25);};paint();
    const stream=canvas.captureStream(0);const track=stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const timer=window.setInterval(()=>{paint();track.requestFrame();},65);sources.push({canvas,stream,timer});colors.set(track.id,color);return track;
  };
  const sendHost=(message:Record<string,unknown>)=>{
    if(message.event==='epoch-video-offer'&&dropOffers){log.push({drop:'offer',peerId:message.peerId});return false;}
    if(message.event==='epoch-video-committed'&&dropCommits>0){--dropCommits;log.push({drop:'commit',peerId:message.peerId});return false;}
    queueMicrotask(()=>{if(alive)void client.handle(message).catch(error=>failures.push(String(error)));});return true;
  };
  const sendClient=(message:Record<string,unknown>)=>{queueMicrotask(()=>{if(alive)void host.handle(message).catch(error=>failures.push(String(error)));});return true;};
  host=new EpochVideoHost(sid,sendHost,()=>({iceServers:[]}),()=>alive,async id=>sameCapture(id,latest),(_sender,_pc,id)=>{active=id;count();},(id,message)=>{log.push({hostFailure:message,epoch:id.view.epoch});},factory);
  client=new EpochVideoClient(sid,sendClient,()=>({iceServers:[]}),()=>alive,id=>!!displayed.observe(id),entry=>{
    const old=visible,v=document.createElement('video');v.muted=true;v.autoplay=true;v.playsInline=true;v.srcObject=entry.stream;visible=v;screen.replaceChildren(v);if(old){old.pause();old.srcObject=null;}
    const tick=()=>{if(!alive||visible!==v)return;ctx.drawImage(v,0,0,1,1);const rgb=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3);presentations.push({epoch:entry.identity.view.epoch,color:rgb,peerId:entry.peerId});if(!presentedOnce.has(entry.peerId)){presentedOnce.add(entry.peerId);client.presented(entry.peerId,v);}count();v.requestVideoFrameCallback(tick);};v.requestVideoFrameCallback(tick);void v.play().catch(error=>failures.push(String(error)));
  },id=>displayed.presented(id,false),(id,message)=>{log.push({clientFailure:message,epoch:id.view.epoch});},factory);
  const assert=(yes:unknown,message:string)=>{if(!yes)throw new Error(message);};
  const stage=async(id:CaptureIdentity,track:MediaStreamTrack)=>{latest=id;await host.stage(id,track);count();};
  const settled=(id:CaptureIdentity)=>sameCapture(active,id)&&host.count===1&&client.count===1&&sameCapture(displayed.current,id);
  try{
    const red=source('epoch 1 / left',[190,35,45]),blue=source('epoch 2 / right',[30,65,200]);
    status.textContent='Initial source';await stage(identity(1),red);await until(()=>settled(identity(1)),'initial source');
    const first=presentations.find(p=>p.epoch===1)!;assert(first.color[0]>first.color[2]+80,'Initial source did not show red');log.push({check:'initial real RTC source',pass:true,first});
    status.textContent='Same-size switch with three dropped commits';dropCommits=3;const switchAt=performance.now();await stage(identity(2,'right'),blue);await until(()=>settled(identity(2,'right')),'same-size commit retry');
    const second=presentations.find(p=>p.epoch===2)!;assert(second.color[2]>second.color[0]+80,'New identity was proven by the preceding red source');assert(dropCommits===0,'Commit drop scenario was not exercised');log.push({check:'same-size source and commit-loss retry',pass:true,ms:performance.now()-switchAt,first:second});
    status.textContent='Rapid supersession';const green=source('superseded epoch 3',[30,180,55]),amber=source('epoch 4',[200,130,20]);latest=identity(4,'right');void host.stage(identity(3),green).catch(error=>failures.push(String(error)));void host.stage(latest,amber).catch(error=>failures.push(String(error)));count();await until(()=>settled(identity(4,'right')),'rapid supersession');assert(!presentations.some(p=>p.epoch===3),'Superseded source became visible');log.push({check:'rapid supersession',pass:true});
    status.textContent='Same-identity watchdog track replacement';const replacement=source('epoch 4 / replacement',[100,25,175]);const oldPc=host.peer;await stage(identity(4,'right'),replacement);await until(()=>host.peer!==oldPc&&settled(identity(4,'right')),'same-identity track replacement');await until(()=>presentations.some(p=>p.epoch===4&&p.color[2]>p.color[1]+70),'replacement picture');log.push({check:'same-identity track replacement',pass:true});
    status.textContent='Failed pending setup preserves the preceding picture';dropOffers=true;const failed=source('failed epoch 5',[15,160,170]);await stage(identity(5),failed);await until(()=>host.count===1,'failed pending retirement');dropOffers=false;assert(sameCapture(active,identity(4,'right')),'Failed setup retired the active host');assert(client.count===1&&visible?.readyState===4,'Failed setup lost the active client sink');log.push({check:'offer-send failure retains active source',pass:true});
    assert(failures.length===0,`Async failure: ${failures.join('; ')}`);assert(maxHostPeers<=2&&maxClientPeers<=2,'Peer bounds exceeded');
    log.push({check:'bounded active + pending peers',pass:true,maxHostPeers,maxClientPeers});status.textContent='Complete';
  }catch(error){failures.push(String(error));status.textContent='Failed';}
  finally{
    alive=false;host.close();client.close();visible?.pause();if(visible)visible.srcObject=null;
    for(const owned of sources){clearInterval(owned.timer);owned.stream.getTracks().forEach(track=>track.stop());}
    for(const pc of peers){if(pc.connectionState==='closed')closedPcs++;else pc.close();}
    result.textContent=JSON.stringify({browser:navigator.userAgent,documentVisibility:document.visibilityState,elapsedMs:performance.now()-started,log,failures,presentations:presentations.filter((p,i,a)=>i===a.findIndex(other=>other.peerId===p.peerId)),createdPeers:peers.length,closedPcs,maxHostPeers,maxClientPeers,hostAfterClose:host.count,clientAfterClose:client.count},null,2);button.disabled=false;
  }
};
