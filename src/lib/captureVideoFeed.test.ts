import {afterEach,describe,expect,it,vi} from 'vitest';
import {CaptureVideoFeed} from './captureVideoFeed';
import type {CaptureIdentity} from './captureView';

function identity(epoch=1):CaptureIdentity{
  const display={id:'left',index:0,name:'Left',x:-1920,y:0,width:1920,height:1080,rotation:0,isPrimary:false,selected:true,layoutRevision:1};
  return {sessionId:'s',requestId:`r${epoch}`,view:{epoch,layoutRevision:1,mode:'single',selectedDisplayId:'left',source:{x:-1920,y:0,width:1920,height:1080},width:1920,height:1080,displays:[display]}};
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('capture feeds and failed epoch peer ownership',()=>{
  it('retires exactly the failed pending track and permits a later same-view watchdog retry',async()=>{
    const tracks:MediaStreamTrack[]=[];let serial=0;
    const create=document.createElement.bind(document);
    vi.spyOn(document,'createElement').mockImplementation(((name:string)=>{
      if(name!=='canvas')return create(name);
      const canvas={width:1,height:1,getContext:()=>({drawImage:vi.fn()}),captureStream:()=>{
        const track={id:`track-${++serial}`,stop:vi.fn(),kind:'video',readyState:'live'} as unknown as MediaStreamTrack;tracks.push(track);return {getVideoTracks:()=>[track]};
      }};return canvas;
    }) as typeof document.createElement);
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:1920,height:1080,close:vi.fn()})));
    const ready:MediaStreamTrack[]=[];const bank=new CaptureVideoFeed(()=>60,()=>true,()=>false,(_view,track)=>ready.push(track));const view=identity();
    bank.paint(new Uint8Array([255,216,255]).buffer,view);await vi.waitFor(()=>expect(ready).toHaveLength(1));bank.commit(view);
    expect(bank.count).toBe(1);expect(bank.rebuild(view)).toBe(true);
    bank.paint(new Uint8Array([255,216,255]).buffer,view);await vi.waitFor(()=>expect(ready).toHaveLength(2));
    expect(bank.reject(view,ready[0])).toBe(false);expect(bank.count).toBe(2);
    expect(bank.reject(view,ready[1])).toBe(true);expect(ready[1].stop).toHaveBeenCalledTimes(1);expect(ready[0].stop).not.toHaveBeenCalled();
    expect(bank.rebuild(view)).toBe(true);bank.paint(new Uint8Array([255,216,255]).buffer,view);await vi.waitFor(()=>expect(ready).toHaveLength(3));
    expect(bank.reject(view,ready[1])).toBe(false);bank.commit(view);expect(bank.count).toBe(1);expect(ready[0].stop).toHaveBeenCalledTimes(1);
    bank.close();expect(tracks.every(track=>vi.mocked(track.stop).mock.calls.length===1)).toBe(true);
  });
});
