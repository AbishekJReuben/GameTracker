// Actual ControlScreen/settings and ClientPresence, with an isolated local fake
// video/transport. Never connects to a PC, injects input, or touches a live port.
import React,{useEffect,useState} from 'react';
import { createRoot } from 'react-dom/client';
import { ControlScreen } from '../../src/companion/screens/Control';
import { ClientPresence } from '../../src/companion/clientPresence';
import { setCloudMode } from '../../src/companion/link';
import { readAppearance } from '../../src/companion/remotePreferences';
import {useCompanionClip} from '../../src/companion/clipboardCompanion';
import type { RemoteLink } from '../../src/companion/links';
import type { RemoteHandshake,RemotePresenceUpdate } from '../../src/lib/remoteProtocol';
import '../../src/index.css';
const toolbarProbe=new URLSearchParams(location.search).has('toolbar');
const notesProbe=new URLSearchParams(location.search).has('notes');
const display={id:'fixture-primary',index:0,name:'Fixture display',x:0,y:0,width:1920,height:1080,rotation:0,isPrimary:true,selected:true,layoutRevision:1};
const handshake:RemoteHandshake={version:1,sessionId:'isolated-fixture',capabilities:['display-geometry-v1','view-state-v1','controller-name-v1','desktop-appearance-v1'],layout:{revision:1,bounds:display,displays:[display]},view:{epoch:1,layoutRevision:1,mode:'single',selectedDisplayId:display.id,source:display,width:1920,height:1080,displays:[display]},overlayAvailable:true};
if(toolbarProbe){
  handshake.layout.displays=[display,{...display,id:'fixture-secondary',index:1,name:'Generic PnP Monitor with a deliberately long display name',x:-1920,isPrimary:false,selected:false}];
  handshake.layout.bounds={x:-1920,y:0,width:3840,height:1080};
  handshake.view={...handshake.view,mode:'all',source:handshake.layout.bounds,width:1280,height:360,displays:handshake.layout.displays};
  handshake.capabilities.push('all-screens-v1','view-epoch-input-v1');
}
let identity={sessionId:handshake.sessionId,requestId:'fixture-1',view:handshake.view};
const events=new Set<(event:{event:string;[key:string]:unknown})=>void>();
const state={sink:false,unmounts:0,presence:null as RemotePresenceUpdate|null,inputEvents:0,qualityChanges:0,copied:''};
if(notesProbe){
  // Synthetic feed and local clipboard shim: no relay, credentials, live notes,
  // or workstation clipboard is accessed by this preview.
  useCompanionClip.setState({ready:true,connected:true,items:[{id:'browser-note',kind:'text',text:'Copied on desktop — ready to copy in the browser.',size:56,createdUtc:new Date().toISOString(),deviceId:'fixture',deviceName:'Fixture desktop',source:'auto',pinned:false}],init:async()=>{},stop:()=>{}});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{state.copied=text;}}});
}
const presence=new ClientPresence(message=>{state.presence=message.update as RemotePresenceUpdate;return true;});presence.accept(handshake);
const source=document.createElement('canvas');source.width=1280;source.height=720;const ctx=source.getContext('2d')!;
setInterval(()=>{ctx.fillStyle='#162033';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#dce5f6';ctx.font='600 34px system-ui';ctx.fillText('Isolated desktop fixture',60,100);ctx.font='22px system-ui';ctx.fillText('No PC capture or input is connected.',60,145);ctx.fillStyle='#28c7ba';ctx.fillRect(60,230,200+Math.sin(performance.now()/1000)*30,6);},66);
const stream=source.captureStream(15);
const link:RemoteLink={
  appliedView:()=>toolbarProbe?identity:null,
  requestView:(mode,selectedDisplayId)=>{const selected=handshake.layout.displays.find(d=>d.id===selectedDisplayId)!;identity={...identity,requestId:`fixture-${identity.view.epoch+1}`,view:{...identity.view,epoch:identity.view.epoch+1,mode,selectedDisplayId,source:mode==='all'?handshake.layout.bounds:selected,displays:mode==='all'?handshake.layout.displays:[selected],width:1280,height:mode==='all'?360:720}};handshake.view=identity.view;setTimeout(()=>events.forEach(event=>event({event:'remote-view',applied:identity,pending:null,changing:false})),0);return true;},
  remoteHandshake:()=>handshake,remoteOverlayStatus:()=>({available:true,degraded:false,activeDisplayIds:state.sink?[display.id]:[],failedDisplays:{},message:null}),
  reportView:view=>presence.setView(view),onStream:callback=>{callback(stream);return()=>{};},onEvent:callback=>{events.add(callback);return()=>{events.delete(callback);};},onStatus:callback=>{callback(true);},
  send:()=>{state.inputEvents++;return true;},setQuality:()=>{state.qualityChanges++;},noteVideoSink:active=>{state.sink=active;if(!active)state.unmounts++;presence.setScope({sink:active,idle:false});},netStats:async()=>null,close:()=>{},
};
setCloudMode({request:async(path:string)=>path==='/api/monitors'?handshake.layout.displays:path==='/api/remote/streamlog'?{log:''}:null} as never);
function Probe(){const[,tick]=useState(0);useEffect(()=>{const id=setInterval(()=>tick(n=>n+1),250);return()=>clearInterval(id);},[]);
  return <div style={{height:'100dvh',display:'flex',flexDirection:'column'}}><div className="shrink-0 bg-amber-950 p-2 text-xs text-amber-100" role="status" aria-label="Isolated fixture evidence">Isolated fixture — no PC connection. Video sink: {state.sink?'active':'inactive'}; sink unmounts: {state.unmounts}; presence: {state.presence?.controlVisible?'visible':'absent'}; appearance: {readAppearance().preset}; host intensity: {state.presence?.appearance.intensity??'pending'}; quality updates: {state.qualityChanges}; input events: {state.inputEvents}.{notesProbe&&` Local copied text: ${state.copied||'(none)'}`}</div><div className="min-h-0 flex-1"><ControlScreen link={link} onNavigate={toolbarProbe?()=>{}:undefined}/></div></div>;
}
createRoot(document.getElementById('root')!).render(<Probe/>);
