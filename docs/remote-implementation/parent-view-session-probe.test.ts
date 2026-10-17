import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {CaptureIdentity,ViewStatus} from '../../src/lib/captureView';
import type {DisplaySnapshot} from '../../src/lib/displayLayout';
const native=vi.hoisted(()=>({remoteViewRequest:vi.fn(),remoteViewAcknowledge:vi.fn(),remoteViewStatus:vi.fn(),remoteViewCancel:vi.fn()}));
vi.mock('../../src/lib/api',()=>({api:native}));
import {HostViewSession} from '../../src/lib/hostViewSession';
import {ClientViewSession} from '../../src/companion/clientViewSession';
import {REMOTE_CAPABILITIES} from '../../src/lib/remoteProtocol';

function identity(epoch:number,revision=1,selected='left',requestId=`r${epoch}`):CaptureIdentity{
  const display={id:selected,index:selected==='left'?0:1,name:selected,x:selected==='left'?-1920:0,y:0,width:1920,height:1080,rotation:0,isPrimary:selected==='right',selected:true,layoutRevision:revision};
  return {sessionId:'parent-coordinator',requestId,view:{epoch,layoutRevision:revision,mode:'single',selectedDisplayId:selected,source:{x:display.x,y:0,width:1920,height:1080},width:1920,height:1080,displays:[display]}};
}
function layout(revision=1):DisplaySnapshot{const left=identity(1,revision).view.displays[0],right=identity(1,revision,'right').view.displays[0];return {revision,bounds:{x:-1920,y:0,width:3840,height:1080},displays:[left,right]};}
function state(id:CaptureIdentity,pending=false):ViewStatus{return {requested:id,applied:pending?null:id,pending,error:null,layout:layout(id.view.layoutRevision)};}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const owned:{close:()=>void}[]=[];
beforeEach(()=>{vi.resetAllMocks();native.remoteViewAcknowledge.mockResolvedValue(true);native.remoteViewStatus.mockResolvedValue(null);native.remoteViewCancel.mockResolvedValue(null);});
afterEach(()=>{owned.splice(0).forEach(item=>item.close());vi.useRealTimers();});
function host(){const send=vi.fn(()=>true),changed=vi.fn(),committed=vi.fn();const session=new HostViewSession('parent-coordinator',()=>true,()=>true,send,changed,committed);owned.push(session);return {session,send,changed,committed};}
function client(){const send=vi.fn(()=>true),event=vi.fn(),confirmed=vi.fn(),failed=vi.fn();const session=new ClientViewSession(send,event,()=>({}),()=>true,()=>{},confirmed,failed);session.accept({version:1,sessionId:'parent-coordinator',capabilities:REMOTE_CAPABILITIES,layout:layout(),view:identity(1).view,overlayAvailable:true});owned.push(session);return {session,send,event,confirmed,failed};}
function seed(f:ReturnType<typeof client>,id=identity(1)){f.session.observe(id);expect(f.session.directPresented(id)).toBe(true);f.session.handle({event:'view-applied',identity:id});expect(f.session.changing).toBe(false);}
function request(requestId:string,selectedDisplayId='right'){return {type:'view-request',request:{requestId,mode:'single',selectedDisplayId,maxWidth:1920}};}

describe('parent independent coordinator boundary checks',()=>{
  it('a failed send keeps the old displayed source and clears only the rejected intent',()=>{const f=client();seed(f);f.send.mockReturnValue(false);expect(f.session.request('single','right',1920)).toBe(false);expect(f.session.current).toEqual(identity(1));expect(f.session.changing).toBe(false);});
  it('native validation failure restores acceptance of the actual preceding source',async()=>{const f=host();const old=identity(1);f.session.observe(old);native.remoteViewRequest.mockRejectedValueOnce(new Error('Display no longer connected'));await f.session.handle(request('invalid-selection'));expect(f.send).toHaveBeenCalledWith(expect.objectContaining({event:'view-error',requestId:'invalid-selection'}));expect(f.session.observe(old)).toEqual(old);});
  it('superseded native requests cannot announce or accept a preceding requested source',async()=>{
    const f=host(),first=deferred<CaptureIdentity>();const a=identity(2,1,'right','first'),b=identity(3,1,'left','second');native.remoteViewRequest.mockReturnValueOnce(first.promise).mockResolvedValueOnce(b);
    const p1=f.session.handle(request('first'));await vi.waitFor(()=>expect(native.remoteViewRequest).toHaveBeenCalledTimes(1));const p2=f.session.handle(request('second','left'));first.resolve(a);await Promise.all([p1,p2]);
    const announced=f.send.mock.calls.map(args=>args[0]).filter((message:any)=>message.event==='view-requested');expect(announced).toEqual([{event:'view-requested',identity:b}]);expect(f.session.observe(a)).toBeNull();expect(f.session.observe(b)).toEqual(b);expect(f.session.observe(a)).toBeNull();
  });
  it('late acknowledgment cannot commit a retired session',async()=>{const f=host(),ack=deferred<boolean>(),a=identity(1);native.remoteViewAcknowledge.mockReturnValueOnce(ack.promise);f.session.observe(a);const pending=f.session.acknowledge(a);f.session.close();ack.resolve(true);expect(await pending).toBe(false);expect(f.committed).not.toHaveBeenCalled();});
  it('late acknowledgment cannot commit a preceding source after newer pixels arrive',async()=>{const f=host(),ack=deferred<boolean>(),a=identity(1),b=identity(2,1,'right');native.remoteViewAcknowledge.mockReturnValueOnce(ack.promise);f.session.observe(a);const pending=f.session.acknowledge(a);f.session.observe(b);ack.resolve(true);expect(await pending).toBe(false);expect(f.committed).not.toHaveBeenCalled();});
  it('a stale native topology status cannot replace the known newer topology at frame confirmation',()=>{
    const f=client();seed(f);const b=identity(2,2,'right');f.session.handle({event:'view-state',sessionId:'parent-coordinator',status:state(b,true)});expect(f.session.directPresented(b)).toBe(true);
    f.session.handle({event:'view-state',sessionId:'parent-coordinator',status:state(identity(1))});f.session.handle({event:'view-applied',identity:b});expect(f.session.current).toEqual(b);expect(f.confirmed).toHaveBeenLastCalledWith(b,layout(2));
  });
  it('a failure for an older request cannot clear the newest pending intent',()=>{const f=client();seed(f);f.session.request('single','right',1920);f.session.request('all','right',1920);f.session.handle({event:'view-error',sessionId:'parent-coordinator',requestId:'view-1',message:'old rejection'});expect(f.session.changing).toBe(true);expect(f.failed).not.toHaveBeenCalled();f.session.handle({event:'view-error',sessionId:'parent-coordinator',requestId:'view-2',message:'current rejection'});expect(f.session.changing).toBe(false);expect(f.failed).toHaveBeenCalledWith('current rejection');});
  it('retries a lost DIRECT acknowledgment only after actual presentation, then stops on confirmation',()=>{
    vi.useFakeTimers();const f=client();seed(f);const b=identity(2,1,'right');f.send.mockClear();f.session.observe(b);f.send.mockReturnValueOnce(false);expect(f.session.directPresented(b)).toBe(true);expect(f.session.changing).toBe(true);expect(f.send).toHaveBeenCalledTimes(1);vi.advanceTimersByTime(401);expect(f.send).toHaveBeenCalledTimes(2);expect(f.send).toHaveBeenLastCalledWith({type:'view-frame',sessionId:'parent-coordinator',epoch:2});f.session.handle({event:'view-state',sessionId:'parent-coordinator',status:state(b)});expect(f.session.changing).toBe(false);vi.advanceTimersByTime(1200);expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('configuration and status alone never generate a DIRECT displayed-frame acknowledgment',()=>{
    vi.useFakeTimers();const f=client();seed(f);f.send.mockClear();const b=identity(2,1,'right');f.session.handle({event:'view-state',sessionId:'parent-coordinator',status:state(b,true)});vi.advanceTimersByTime(1600);expect(f.send).not.toHaveBeenCalled();expect(f.session.current).toEqual(identity(1));expect(f.session.changing).toBe(true);
  });
});
