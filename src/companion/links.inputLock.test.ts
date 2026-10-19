import {beforeEach,describe,expect,it,vi} from 'vitest';
import {makeRtcLink,type ControlMsg} from './links';
import type {CloudConn} from './cloud';
import {saveInputLocked} from './remotePreferences';

function fixture(epoch=true){
  const input=vi.fn((_msg:unknown,_lossy?:boolean,_anchor?:unknown)=>true),control=vi.fn((_msg:unknown)=>true),move=vi.fn((_msg:unknown)=>true),request=vi.fn(()=>true);
  const conn={displayedView:{sessionId:'s',view:{epoch:1}},remoteHandshake:epoch?{capabilities:['view-epoch-input-v1'],layout:{displays:[{id:'left',index:0}]}}:null,sendViewInput:input,sendControl:control,sendMove:move,requestRemoteView:request};
  return {link:makeRtcLink(conn as unknown as CloudConn),input,control,move,request};
}
beforeEach(()=>localStorage.clear());
describe('view-only input lock',()=>{
  it('blocks every input source, including relative/hover moves and nested shortcuts',()=>{
    const f=fixture();f.link.setInputLocked!(true);
    const messages:ControlMsg[]=[{type:'move',x:.2,y:.5},{type:'moverel',dx:1,dy:2},{type:'click',x:.8,y:.6,button:'right'},{type:'down'},{type:'up'},{type:'scroll',dy:1},{type:'text',value:'oops'},{type:'key',name:'enter'},{type:'keydown',name:'ctrl'},{type:'keyup',name:'ctrl'},{type:'seq',events:[{type:'seq',events:[{type:'click'}]}]},{type:'gamepad',buttons:1,lx:1,ly:0,rx:0,ry:0,lt:0,rt:0}];
    messages.forEach(msg=>expect(f.link.send(msg)).toBe(false));
    expect(f.input).not.toHaveBeenCalled();expect(f.control).not.toHaveBeenCalled();expect(f.move).not.toHaveBeenCalled();
  });
  it('releases accepted nested key/button/gamepad holds without moving the cursor',()=>{
    const f=fixture();f.link.send({type:'move',x:.2,y:.3});
    f.link.send({type:'seq',events:[{type:'keydown',name:'ctrl'},{type:'seq',events:[{type:'keydown',name:'w'},{type:'down',button:'left'}]},{type:'gamepad',buttons:1,lx:1,ly:0,rx:0,ry:0,lt:0,rt:0}]});f.input.mockClear();
    f.link.setInputLocked!(true);
    expect(f.input.mock.calls).toEqual([[{type:'seq',events:[{type:'up',button:'left'},{type:'keyup',name:'ctrl'},{type:'keyup',name:'w'},{type:'gamepadstop'}]},false,undefined]]);
    f.link.setInputLocked!(true);expect(f.input).toHaveBeenCalledTimes(1);
  });
  it('keeps viewing/stream controls working and never reuses a pre-lock pointer anchor',()=>{
    const f=fixture();f.link.send({type:'move',x:.2,y:.3});f.link.setInputLocked!(true);
    expect(f.link.send({type:'monitor',index:0})).toBe(true);expect(f.request).toHaveBeenCalled();
    f.link.setQuality({maxW:1920,quality:72,fps:30});expect(f.control).toHaveBeenCalledWith(expect.objectContaining({type:'quality'}));
    f.link.setInputLocked!(false);f.link.send({type:'down'});expect(f.input).toHaveBeenLastCalledWith({type:'down'},false,undefined);
  });
  it('preserves the lock for a newly created web/Android transport',()=>{
    saveInputLocked(true);const f=fixture();expect(f.link.inputLocked!()).toBe(true);expect(f.link.send({type:'text',value:'no'})).toBe(false);expect(f.input).not.toHaveBeenCalled();
  });
  it('does not remember a hold that the transport rejected',()=>{
    const f=fixture();f.input.mockReturnValueOnce(false);f.link.send({type:'keydown',name:'ctrl'});f.input.mockClear();f.link.setInputLocked!(true);expect(f.input).not.toHaveBeenCalled();
  });
  it('also protects older hosts and clears their queued absolute anchor',()=>{
    const f=fixture(false);f.link.send({type:'move',x:.2,y:.3});f.link.send({type:'down'});f.link.send({type:'move',x:.8,y:.9});f.control.mockClear();f.link.setInputLocked!(true);
    expect(f.control.mock.calls).toEqual([[{type:'seq',events:[{type:'up',button:'left'}]}]]);
    expect(f.link.send({type:'move',x:.1,y:.1})).toBe(false);f.link.setInputLocked!(false);f.link.send({type:'up'});
    expect(f.control.mock.calls).toHaveLength(2);expect(f.control).toHaveBeenLastCalledWith({type:'up'});
  });
});
