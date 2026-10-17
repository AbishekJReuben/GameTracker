import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./api',()=>({api:{remotePresenceAuthorize:vi.fn(),remotePresenceUpdate:vi.fn().mockResolvedValue(true),remotePresenceEnd:vi.fn().mockResolvedValue(undefined)}}));
import { api } from './api';
import { HostPresenceSession } from './hostPresenceSession';
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.remotePresenceAuthorize).mockResolvedValue({sessionId:'s'} as never);});
it('does not register a pending or older peer; device identity stays distinct from display name',async()=>{
  const session=new HostPresenceSession('s');session.learnAuth({deviceId:'device',name:'Moto',displayName:'Arul',capabilities:['view-state-v1']});
  expect(api.remotePresenceAuthorize).not.toHaveBeenCalled();expect(session.handle({type:'presence',update:{}})).toBe(true);expect(api.remotePresenceUpdate).not.toHaveBeenCalled();
  await session.authorize();expect(api.remotePresenceAuthorize).toHaveBeenCalledWith('s','device','Arul',['view-state-v1'],undefined);
  expect(session.handle({type:'move',x:0,y:0})).toBe(false);
  const legacy=new HostPresenceSession('old');legacy.learnAuth({deviceId:'old',name:'Phone'});await legacy.authorize();expect(api.remotePresenceAuthorize).toHaveBeenCalledTimes(1);
});
it('retires a registration that resolves after teardown and makes cleanup idempotent',async()=>{
  let complete!:(v:never)=>void;vi.mocked(api.remotePresenceAuthorize).mockReturnValue(new Promise(resolve=>{complete=resolve;}));
  const session=new HostPresenceSession('s');session.learnAuth({deviceId:'d',capabilities:['view-state-v1']});const pending=session.authorize();session.end();session.end();complete({sessionId:'s'} as never);await pending;
  expect(session.authFields()).toEqual({});expect(api.remotePresenceEnd).toHaveBeenCalledWith('s',false);expect(session.handle({type:'presence',update:{}})).toBe(true);expect(api.remotePresenceUpdate).not.toHaveBeenCalled();
});
it('reports native display degradation, but drops a status result after session retirement',async()=>{
  const report=vi.fn(),session=new HostPresenceSession('s',undefined,report);session.learnAuth({deviceId:'d',capabilities:['view-state-v1']});await session.authorize();
  const overlay={available:true,degraded:true,activeDisplayIds:[],failedDisplays:{p:'Capture exclusion failed'},message:'Decoration unavailable'};
  vi.mocked(api.remotePresenceUpdate).mockResolvedValue({accepted:true,overlay});session.handle({type:'presence',update:{}});await Promise.resolve();expect(report).toHaveBeenCalledWith(overlay);
  let complete!:(v:{accepted:boolean;overlay:typeof overlay})=>void;vi.mocked(api.remotePresenceUpdate).mockReturnValue(new Promise(r=>{complete=r;}));
  session.handle({type:'presence',update:{}});session.end();complete({accepted:true,overlay});await Promise.resolve();expect(report).toHaveBeenCalledTimes(1);
});
