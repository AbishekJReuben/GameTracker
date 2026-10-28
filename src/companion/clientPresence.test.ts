import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientPresence, VIEW_RECT_INTERVAL_MS } from './clientPresence';
import { saveControllerName, saveAppearance, readAppearance, changeAppearance } from './remotePreferences';
import type { RemoteHandshake, RemotePresenceUpdate } from '@/lib/remoteProtocol';
const d={id:'p',index:0,name:'Primary',x:0,y:0,width:1920,height:1080,rotation:0,isPrimary:true,selected:true,layoutRevision:1};
const handshake:RemoteHandshake={version:1,capabilities:['display-geometry-v1','view-state-v1','controller-name-v1','desktop-appearance-v1'],sessionId:'approved-session',layout:{revision:1,bounds:d,displays:[d]},view:{epoch:1,layoutRevision:1,mode:'single',selectedDisplayId:'p',source:d,width:1920,height:1080,displays:[d]},overlayAvailable:false};
describe('truthful negotiated client presence',()=>{
  let p:ClientPresence;let sent:{update:RemotePresenceUpdate}[];
  beforeEach(()=>{vi.useFakeTimers();localStorage.clear();sent=[];p=new ClientPresence(msg=>{sent.push(msg as {update:RemotePresenceUpdate});return true;});});
  afterEach(()=>{p.close();vi.useRealTimers();});
  it('sends nothing to an older host and never assumes visibility from auth alone',()=>{
    p.setScope({sink:true});p.accept(undefined);vi.advanceTimersByTime(2000);expect(sent).toHaveLength(0);
    p.setScope({sink:false});p.accept(handshake);expect(sent[sent.length-1]?.update.controlVisible).toBe(false);expect(sent[sent.length-1]?.update.visibleDisplayIds).toEqual([]);
  });
  it('shares the already-debounced idle policy and keeps PiP/immersive explicitly visible',()=>{
    p.accept(handshake);p.setScope({sink:true,idle:false});expect(sent[sent.length-1]?.update.controlVisible).toBe(true);
    // A hidden document during Android's handoff does not change this adapter's
    // policy until the existing CloudConn grace actually commits idle.
    p.setScope({pip:true,idle:false});expect(sent[sent.length-1]?.update.pipVisible).toBe(true);expect(sent[sent.length-1]?.update.visibleDisplayIds).toEqual(['p']);
    p.setScope({pip:false,idle:false});expect(sent[sent.length-1]?.update.controlVisible).toBe(true);
    p.setScope({idle:true});expect(sent[sent.length-1]?.update.visibleDisplayIds).toEqual([]);
    p.setScope({idle:false,immersive:true});expect(sent[sent.length-1]?.update.immersiveVisible).toBe(true);
    p.setScope({sink:false});expect(sent[sent.length-1]?.update.visibleDisplayIds).toEqual([]);
  });
  it('coalesces live appearance/name changes without reconnecting or touching quality',()=>{
    p.accept(handshake);p.setScope({sink:true});const before=sent.length;
    for(let i=0;i<30;i++)saveControllerName('Arul '+i);
    let appearance=readAppearance();appearance=changeAppearance(appearance,{...appearance.value,intensity:.5});saveAppearance(appearance);
    expect(sent).toHaveLength(before);vi.advanceTimersByTime(80);expect(sent).toHaveLength(before+1);
    expect(sent[sent.length-1]?.update.displayName).toBe('Arul 29');expect(sent[sent.length-1]?.update.appearance.intensity).toBe(.5);
  });
  it('sends the viewing area only to a viewport-v1 host, rate-limited and only while Control is on screen',()=>{
    const view={mode:'single' as const,epoch:1,selectedDisplayId:'p',visibleDisplayIds:['p']};
    p.accept(handshake);p.setScope({sink:true});p.setView({...view,viewRect:{x:0,y:0,width:960,height:540}});
    expect('viewRect' in sent[sent.length-1]!.update).toBe(false);
    p.accept({...handshake,sessionId:'lens',capabilities:[...handshake.capabilities,'viewport-v1']});
    p.setView({...view,viewRect:{x:0,y:0,width:960,height:540}});vi.advanceTimersByTime(VIEW_RECT_INTERVAL_MS);expect(sent[sent.length-1]?.update.viewRect).toEqual({x:0,y:0,width:960,height:540});
    vi.advanceTimersByTime(VIEW_RECT_INTERVAL_MS);const before=sent.length;
    for(let i=1;i<=20;i++)p.setView({...view,viewRect:{x:i*10,y:0,width:960,height:540}});
    expect(sent.length-before).toBe(1);vi.advanceTimersByTime(VIEW_RECT_INTERVAL_MS);expect(sent.length-before).toBe(2);
    expect(sent[sent.length-1]?.update.viewRect?.x).toBe(200);
    p.setView({...view,visibleDisplayIds:[],viewRect:{x:200,y:0,width:960,height:540}});expect(sent.length-before).toBe(3);
    p.setScope({pip:true});expect(sent[sent.length-1]?.update.viewRect).toBeNull();
    p.setScope({pip:false,immersive:true});expect(sent[sent.length-1]?.update.viewRect).toBeNull();
  });
  it('stops the old session timer and cannot retain a visible report after teardown',()=>{
    p.accept(handshake);p.setScope({sink:true});p.reset();const n=sent.length;vi.advanceTimersByTime(5000);expect(sent).toHaveLength(n);
    p.accept({...handshake,sessionId:'new'});expect(sent[sent.length-1]?.update.sequence).toBe(1);
    p.close();expect(sent[sent.length-1]?.update.visibleDisplayIds).toEqual([]);const end=sent.length;vi.advanceTimersByTime(5000);expect(sent).toHaveLength(end);
  });
});
