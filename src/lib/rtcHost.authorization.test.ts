import { expect,it,vi } from 'vitest';
import { onlyLiveSession, runAuthorizedStartup } from './hostAuthorization';
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};}
function fixture(){
  let current='old';const capture=vi.fn().mockResolvedValue(undefined),audio=vi.fn().mockResolvedValue(undefined),ack=vi.fn(),track=vi.fn();
  const secret='a successor-only secret';
  const startup={isAlive:()=>current==='old',registerPresence:vi.fn().mockResolvedValue(undefined),activate:vi.fn(),startVideo:capture,startAudio:audio,requestRecoveryFrame:vi.fn().mockResolvedValue(undefined),showTrack:track,acknowledge:()=>ack({channel:current,secret})};
  return {startup,capture,audio,ack,track,replace:()=>{current='successor';}};
}
it('a queued already-authorized auth retry from a retired peer cannot ack/secret the successor',async()=>{
  let current='old';const send=vi.fn();
  const onControl=onlyLiveSession(()=>current==='old',async(event:{type:string})=>{
    if(event.type==='auth')send({channel:current,event:'auth',state:'ok',secret:'private'});
  });
  current='successor';await onControl({type:'auth'});expect(send).not.toHaveBeenCalled();
});
it('the outer rtcHost startup cannot start capture/audio or ack/secret after deferred registration is replaced',async()=>{
  const f=fixture(),registration=deferred();f.startup.registerPresence.mockReturnValue(registration.promise);
  const pending=runAuthorizedStartup(f.startup);f.replace();registration.resolve();expect(await pending).toBe(false);
  expect(f.startup.activate).not.toHaveBeenCalled();expect(f.capture).not.toHaveBeenCalled();expect(f.audio).not.toHaveBeenCalled();expect(f.track).not.toHaveBeenCalled();expect(f.ack).not.toHaveBeenCalled();
});
it('a replacement during capture startup cannot start old audio or mutate/ack the successor',async()=>{
  const f=fixture(),capture=deferred();f.capture.mockReturnValue(capture.promise);
  const pending=runAuthorizedStartup(f.startup);await Promise.resolve();expect(f.capture).toHaveBeenCalledTimes(1);f.replace();capture.resolve();expect(await pending).toBe(false);
  expect(f.audio).not.toHaveBeenCalled();expect(f.track).not.toHaveBeenCalled();expect(f.ack).not.toHaveBeenCalled();
});
it('a replacement during audio/recovery cannot mutate the shared track or leak an authorization ack',async()=>{
  for(const stage of ['audio','recovery']){
    const f=fixture(),wait=deferred();(stage==='audio'?f.audio:f.startup.requestRecoveryFrame).mockReturnValue(wait.promise);
    const pending=runAuthorizedStartup(f.startup);await Promise.resolve();await Promise.resolve();await Promise.resolve();f.replace();wait.resolve();expect(await pending).toBe(false);
    expect(f.track).not.toHaveBeenCalled();expect(f.ack).not.toHaveBeenCalled();
  }
});
