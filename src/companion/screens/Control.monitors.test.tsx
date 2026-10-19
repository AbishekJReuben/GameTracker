import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {RemoteLink} from '../links';
import type {RemoteHandshake} from '@/lib/remoteProtocol';
import type {CaptureIdentity} from '@/lib/captureView';
import {readView,saveView,readInputLocked} from '../remotePreferences';
const api=vi.hoisted(()=>({get:vi.fn()}));
vi.hoisted(()=>{vi.stubGlobal('__APP_VERSION__','test');});
vi.mock('../link',()=>({apiGet:api.get}));
import {ControlScreen} from './Control';

const displays=['left','right'].map((id,index)=>({id,index,name:id,x:index*1920,y:0,width:1920,height:1080,rotation:0,isPrimary:index===0,selected:index===0,layoutRevision:1}));
function fixture(){
  const handshake:RemoteHandshake={version:1,sessionId:'test-session',capabilities:['display-geometry-v1','view-state-v1','all-screens-v1','view-epoch-input-v1'],layout:{revision:1,bounds:{x:0,y:0,width:3840,height:1080},displays},view:{epoch:1,layoutRevision:1,mode:'single',selectedDisplayId:'left',source:displays[0],width:1920,height:1080,displays:[displays[0]]},overlayAvailable:false};
  let current:CaptureIdentity={sessionId:handshake.sessionId,requestId:'initial',view:handshake.view},pending:CaptureIdentity|null=null,changing=false,refuse=false;
  const events=new Set<(e:{event:string;[key:string]:unknown})=>void>();
  const emit=(e:{event:string;[key:string]:unknown})=>events.forEach(cb=>cb(e));
  const request=vi.fn((mode:'single'|'all',id:string)=>{
    if(refuse){emit({event:'remote-view',applied:current,pending:null,changing:false});return false;}
    const display=displays.find(d=>d.id===id)!;changing=true;
    pending={sessionId:handshake.sessionId,requestId:`view-${current.view.epoch+1}`,view:{...current.view,epoch:current.view.epoch+1,mode,selectedDisplayId:id,source:mode==='all'?handshake.layout.bounds:display,width:1920,height:mode==='all'?540:1080,displays:mode==='all'?displays:[display]}};
    emit({event:'remote-view',applied:current,pending,changing});return true;
  });
  const link:RemoteLink={remoteHandshake:()=>handshake,appliedView:()=>current,viewChanging:()=>changing,requestView:request,onStream:()=>{},onEvent:cb=>{events.add(cb);return()=>{events.delete(cb);};},onStatus:cb=>cb(true),send:vi.fn(()=>true),setQuality:()=>{},netStats:async()=>null,close:()=>{}};
  api.get.mockImplementation(async(path:string)=>path==='/api/monitors'?displays:null);
  return {link,request,refuse:()=>{refuse=true;},present(){if(!pending)throw Error('No pending view');emit({event:'native-view-frame',identity:pending});current=pending;emit({event:'remote-view',applied:current,pending:null,changing:true});},confirm(){if(!pending)throw Error('No pending view');current=pending;pending=null;changing=false;handshake.view=current.view;emit({event:'remote-view',applied:current,pending:null,changing});emit({event:'remote-view-applied',identity:current});}};
}
beforeEach(()=>{
  localStorage.clear();vi.clearAllMocks();
  Object.defineProperty(window,'__GT_PIP_ACTIVE__',{configurable:true,writable:true,value:false});
  Object.defineProperty(window,'matchMedia',{configurable:true,value:vi.fn(()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}))});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();delete (window as Window & {__GT_PIP_ACTIVE__?:boolean}).__GT_PIP_ACTIVE__;});
it('keeps the input lock visible with a collapsed toolbar and remembers it on remount',()=>{
  const f=fixture(),view=render(<ControlScreen link={f.link}/>);
  fireEvent.click(screen.getByRole('button',{name:'Lock remote input'}));
  expect(readInputLocked()).toBe(true);expect(screen.getByRole('button',{name:'Unlock remote input'})).toHaveAttribute('aria-pressed','true');
  fireEvent.click(screen.getByTitle('Hide toolbar'));expect(screen.getByRole('button',{name:'Unlock remote input'})).toBeInTheDocument();
  view.unmount();render(<ControlScreen link={f.link}/>);expect(screen.getByRole('button',{name:'Unlock remote input'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Unlock remote input'}));expect(readInputLocked()).toBe(false);
});
it('blocks viewport and keyboard input while still allowing display selection and zoom controls',async()=>{
  const f=fixture(),{container}=render(<ControlScreen link={f.link}/>);fireEvent.click(screen.getByRole('button',{name:'Lock remote input'}));vi.mocked(f.link.send).mockClear();
  const viewport=screen.getByTestId('remote-viewport');
  fireEvent.pointerMove(viewport,{pointerId:1,pointerType:'mouse',clientX:200,clientY:200,buttons:0});
  fireEvent.pointerDown(viewport,{pointerId:1,pointerType:'mouse',clientX:200,clientY:200,button:0});fireEvent.pointerUp(viewport,{pointerId:1,pointerType:'mouse',button:0});
  fireEvent.wheel(viewport,{deltaY:100});const input=container.querySelector('input[inputmode="text"]')!;expect(input).toBeDisabled();fireEvent.keyDown(input,{key:'Enter'});fireEvent.input(input,{target:{value:'oops'}});
  expect(f.link.send).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:/Switch display/}));expect(f.request).toHaveBeenCalledWith('single','right',expect.any(Number));
  fireEvent.click(screen.getByTitle('Zoom (25%–1000%)'));expect(screen.getByRole('slider',{name:'Zoom level'})).toBeEnabled();
  await act(async()=>{});
});
it('pinches and pans the picture locally while the remote cursor stays untouched',async()=>{
  const f=fixture(),{container}=render(<ControlScreen link={f.link}/>),viewport=screen.getByTestId('remote-viewport');
  Object.defineProperties(viewport,{clientWidth:{value:1000},clientHeight:{value:600}});vi.spyOn(viewport,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:1000,bottom:600,width:1000,height:600,toJSON(){}});
  const video=container.querySelector('video')!;Object.defineProperties(video,{videoWidth:{value:1920},videoHeight:{value:1080}});fireEvent.loadedMetadata(video);
  fireEvent.click(screen.getByRole('button',{name:'Lock remote input'}));vi.mocked(f.link.send).mockClear();
  const pointer=(type:string,id:number,x:number,y:number)=>{const event=new MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0,buttons:type==='pointerup'?0:1});Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:'touch'}});fireEvent(viewport,event);};
  pointer('pointerdown',1,300,300);pointer('pointerdown',2,500,300);pointer('pointermove',2,700,300);
  await act(async()=>{await new Promise(r=>setTimeout(r,40));});expect(readView().zoom).toBe(2);
  pointer('pointerup',2,700,300);const before=readView().panX;pointer('pointermove',1,400,300);pointer('pointerup',1,400,300);
  await act(async()=>{await new Promise(r=>setTimeout(r,40));});expect(readView().panX).toBeGreaterThan(before);expect(f.link.send).not.toHaveBeenCalled();
});
it('clears the decoder banner on picture recovery rather than codec initialization',()=>{
  const f=fixture();let notify!:(event:{event:string;[key:string]:unknown})=>void;
  const timers=vi.spyOn(window,'setTimeout'),cancel=vi.spyOn(window,'clearTimeout');
  const subscribe=f.link.onEvent;f.link.onEvent=cb=>{notify=cb;return subscribe(cb);};render(<ControlScreen link={f.link}/>);
  act(()=>notify({event:'decoder',state:'error',reason:'Phone decoder error',detail:'CodecException'}));
  const noticeTimer=timers.mock.results[timers.mock.calls.findIndex(call=>call[1]===20000)].value;
  expect(screen.getByText('Phone decoder error')).toBeInTheDocument();
  act(()=>notify({event:'decoder',state:'native'}));expect(screen.getByText('Phone decoder error')).toBeInTheDocument();
  act(()=>notify({event:'decoder',state:'recovered'}));expect(screen.queryByText('Phone decoder error')).not.toBeInTheDocument();
  expect(cancel).toHaveBeenCalledWith(noticeTimer);
});
it('keeps a monitor-switch warning when the decoder reports picture recovery',()=>{
  const f=fixture();let notify!:(event:{event:string;[key:string]:unknown})=>void;
  const subscribe=f.link.onEvent;f.link.onEvent=cb=>{notify=cb;return subscribe(cb);};render(<ControlScreen link={f.link}/>);
  act(()=>notify({event:'remote-view-error',message:'Selected display disconnected'}));
  act(()=>notify({event:'decoder',state:'recovered'}));expect(screen.getByText('Selected display disconnected')).toBeInTheDocument();
  act(()=>notify({event:'remote-view-recovered'}));expect(screen.queryByText('Selected display disconnected')).not.toBeInTheDocument();
});
it('cycles the quick monitor button repeatedly using the last displayed selection',async()=>{
  const f=fixture();render(<ControlScreen link={f.link}/>);
  for(const id of ['right','left','right','left']){
    fireEvent.click(await screen.findByRole('button',{name:/Switch display/}));
    expect(f.request).toHaveBeenLastCalledWith('single',id,expect.any(Number));
    act(()=>f.confirm());
    expect(screen.getByRole('button',{name:`Switch display (${id==='right'?2:1} of 2)`})).toBeInTheDocument();
  }
});
it('saves the monitor after native presentation is confirmed, without needing a pan or zoom',async()=>{
  saveView({version:1,mode:'single',selectedDisplayId:'left',zoom:1,panX:0,panY:0});
  const f=fixture();render(<ControlScreen link={f.link}/>);
  fireEvent.click(await screen.findByRole('button',{name:/Switch display/}));
  await act(async()=>{f.present();await new Promise(r=>setTimeout(r,35));});
  expect(readView().selectedDisplayId).toBe('left');
  act(()=>f.confirm());await waitFor(()=>expect(readView().selectedDisplayId).toBe('right'));
});
it('restores a saved monitor when the handshake is already cached before Control mounts',async()=>{
  saveView({version:1,mode:'single',selectedDisplayId:'right',zoom:1.5,panX:10,panY:20});
  const f=fixture();render(<ControlScreen link={f.link}/>);
  await waitFor(()=>expect(f.request).toHaveBeenCalledWith('single','right',expect.any(Number)));
  act(()=>f.confirm());expect(screen.getByRole('button',{name:'Switch display (2 of 2)'})).toBeInTheDocument();
});
it('uses one split-screen action through enter, focus and return states',async()=>{
  const f=fixture();render(<ControlScreen link={f.link}/>);
  fireEvent.click(await screen.findByRole('button',{name:'All screens'}));act(()=>f.confirm());
  expect(screen.queryByRole('button',{name:'All screens'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Focus selected display'}));act(()=>f.confirm());
  expect(screen.queryByRole('button',{name:'All screens'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Return to all screens'}));
  expect(f.request.mock.calls.map(c=>c[0])).toEqual(['all','single','all']);
});
it('does not change the displayed or saved monitor when sending a switch fails',async()=>{
  saveView({version:1,mode:'single',selectedDisplayId:'left',zoom:1,panX:0,panY:0});
  const f=fixture();f.refuse();render(<ControlScreen link={f.link}/>);
  fireEvent.click(await screen.findByRole('button',{name:/Switch display/}));
  expect(screen.getByRole('button',{name:'Switch display (1 of 2)'})).toBeInTheDocument();expect(readView().selectedDisplayId).toBe('left');
});
it('cycles selection within All screens without restarting its capture',async()=>{
  const f=fixture();render(<ControlScreen link={f.link}/>);
  fireEvent.click(await screen.findByRole('button',{name:'All screens'}));act(()=>f.confirm());
  fireEvent.click(screen.getByRole('button',{name:'Switch display (1 of 2)'}));
  expect(screen.getByRole('button',{name:'Switch display (2 of 2)'})).toBeInTheDocument();
  expect(readView()).toMatchObject({mode:'all',selectedDisplayId:'right'});
  fireEvent.click(screen.getByRole('button',{name:'Switch display (2 of 2)'}));
  expect(screen.getByRole('button',{name:'Switch display (1 of 2)'})).toBeInTheDocument();
  expect(f.request).toHaveBeenCalledTimes(1);expect(readView().selectedDisplayId).toBe('left');
});
it('falls back to the available host display when the saved monitor was disconnected',async()=>{
  saveView({version:1,mode:'single',selectedDisplayId:'unplugged',zoom:5,panX:9000,panY:9000});
  const f=fixture();render(<ControlScreen link={f.link}/>);
  expect(await screen.findByRole('button',{name:'Switch display (1 of 2)'})).toBeInTheDocument();
  expect(f.request).not.toHaveBeenCalled();expect(readView()).toMatchObject({selectedDisplayId:'left',zoom:1,panX:0,panY:0});
});
it('a fixed pop-out cannot restore or overwrite the primary monitor preference',async()=>{
  const saved={version:1 as const,mode:'single' as const,selectedDisplayId:'right',zoom:1.5,panX:10,panY:20};saveView(saved);
  const f=fixture();render(<ControlScreen link={f.link} popoutMonitor={0}/>);
  expect(await screen.findByLabelText('Display 1')).toBeInTheDocument();
  expect(f.request).not.toHaveBeenCalled();expect(readView()).toEqual(saved);
});
it('keeps legacy monitor switching and remembered selection working',async()=>{
  const f=fixture();f.link.remoteHandshake=()=>null;f.link.appliedView=()=>null;
  render(<ControlScreen link={f.link}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Switch display (1 of 2)'}));
  expect(f.link.send).toHaveBeenLastCalledWith({type:'monitor',index:1});
  expect(screen.getByRole('button',{name:'Switch display (2 of 2)'})).toBeInTheDocument();
  expect(readView().selectedDisplayId).toBe('right');
  fireEvent.click(screen.getByRole('button',{name:'Switch display (2 of 2)'}));
  expect(f.link.send).toHaveBeenLastCalledWith({type:'monitor',index:0});
});
it('a refused restore cannot overwrite the saved monitor with the host default',async()=>{
  saveView({version:1,mode:'single',selectedDisplayId:'right',zoom:1.5,panX:10,panY:20});
  const f=fixture();f.refuse();render(<ControlScreen link={f.link}/>);
  await waitFor(()=>expect(f.request).toHaveBeenCalledWith('single','right',expect.any(Number)));
  expect(readView()).toMatchObject({selectedDisplayId:'right',zoom:1.5,panX:10,panY:20});
});
it('does not restore an All-screens preference into PiP, then restores it on returning',async()=>{
  saveView({version:1,mode:'all',selectedDisplayId:'right',zoom:1,panX:0,panY:0});
  const pip=window as Window & {__GT_PIP_ACTIVE__?:boolean};pip.__GT_PIP_ACTIVE__=true;
  const f=fixture();render(<ControlScreen link={f.link}/>);
  expect(f.request).not.toHaveBeenCalled();expect(readView()).toMatchObject({mode:'all',selectedDisplayId:'right'});
  act(()=>{pip.__GT_PIP_ACTIVE__=false;window.dispatchEvent(new CustomEvent('gt:pip',{detail:{active:false}}));});
  await waitFor(()=>expect(f.request).toHaveBeenCalledWith('all','right',expect.any(Number)));
  act(()=>f.confirm());expect(readView()).toMatchObject({mode:'all',selectedDisplayId:'right'});
});
