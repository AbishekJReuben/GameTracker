import {describe,it,expect,vi} from 'vitest';
import {coordinateIndependent,includesRelease} from './inputPolicy';
import {foregroundEdit} from './imeInput';
import {CloudConn} from './cloud';

describe('foreground input during a coordinate view transaction',()=>{
  it('the actual client admits IME/keyboard/controller state while gating coordinates',()=>{
    const conn=new CloudConn('wss://unused.invalid','test');const original=(conn as any).views;
    (conn as any).views={enabled:true,current:{sessionId:'s',view:{epoch:1}},changing:true,close:vi.fn()};const sent=vi.spyOn(conn,'sendControl').mockReturnValue(true);
    const keyboard={type:'seq',events:foregroundEdit('日','日本語😀',new Set(['ctrl']))};expect(coordinateIndependent(keyboard)).toBe(true);expect(conn.sendViewInput(keyboard)).toBe(true);
    expect(conn.sendViewInput({type:'gamepad',buttons:0})).toBe(true);expect(conn.sendViewInput({type:'gamepadstop'})).toBe(true);expect(conn.sendViewInput({type:'down'})).toBe(false);expect(conn.sendViewInput({type:'click',x:.5,y:.5})).toBe(false);
    const mixed={type:'seq',events:[{type:'keydown',name:'ctrl'},{type:'move',x:.5,y:.5},{type:'click'},{type:'keyup',name:'ctrl'}]};expect(coordinateIndependent(mixed)).toBe(false);expect(includesRelease(mixed)).toBe(true);expect(conn.sendViewInput(mixed)).toBe(true); // native executes necessary releases only
    expect(sent.mock.calls[0][0]).toMatchObject({type:'viewinput',epoch:1,event:keyboard});(conn as any).views=original;conn.close();
  });
  it('IME replacement is one ordered edit and never splits a surrogate pair into two deletes',()=>{
    expect(foregroundEdit('a😀','a語',[])).toEqual([{type:'key',name:'backspace'},{type:'text',value:'語'}]);expect(foregroundEdit('日本','日本語😀',[])).toEqual([{type:'text',value:'語😀'}]);expect(foregroundEdit('','C',['ctrl'])).toEqual([{type:'key',name:'c'},{type:'keyup',name:'ctrl'}]);
  });
});
