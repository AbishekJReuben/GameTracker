import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {RemoteLink} from '../links';
import type {RemoteHandshake} from '@/lib/remoteProtocol';
import type {CaptureIdentity} from '@/lib/captureView';
import {readView,saveView} from '../remotePreferences';
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
