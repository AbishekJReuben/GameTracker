import { describe, expect, it, vi } from 'vitest';
import { RemoteGrantLease, type RemoteGrantSnapshot } from './remoteGrantLease';

function fixture() {
  let now = 1_000_000;
  let grants: RemoteGrantSnapshot = { trusted: [{id:'device-one'}], temporary: [] };
  const denied=vi.fn(),load=vi.fn(async()=>grants);
  const lease=new RemoteGrantLease('device-one',load,denied,()=>now);
  return {lease,load,denied,setNow:(n:number)=>{now=n;},setGrants:(g:RemoteGrantSnapshot)=>{grants=g;}};
}
describe('session grant lease',()=>{
  it('accepts a current permanent grant without using a pairing credential',async()=>{
    const f=fixture();expect(await f.lease.refresh()).toBe(true);expect(f.lease.check()).toBe(true);expect(f.lease.accessLevel).toBe('permanent');expect(f.load).toHaveBeenCalledWith();
  });
  it('revocation closes an established lease exactly once',async()=>{
    const f=fixture();await f.lease.refresh();f.setGrants({trusted:[],temporary:[]});expect(await f.lease.refresh()).toBe(false);expect(f.lease.check()).toBe(false);expect(await f.lease.refresh()).toBe(false);expect(f.denied.mock.calls).toEqual([['revoked']]);
  });
  it('enforces temporary expiry between refresh ticks',async()=>{
    const f=fixture();f.setGrants({trusted:[],temporary:[{id:'device-one',expiresUtc:new Date(1_000_100).toISOString()}]});expect(await f.lease.refresh()).toBe(true);f.setNow(1_000_100);expect(f.lease.check()).toBe(false);expect(f.denied).toHaveBeenCalledWith('expired');
  });
  it('refreshes an extended temporary deadline and supports promotion',async()=>{
    const f=fixture();f.setGrants({trusted:[],temporary:[{id:'device-one',expiresUtc:new Date(1_000_100).toISOString()}]});await f.lease.refresh();f.setNow(1_000_050);f.setGrants({trusted:[],temporary:[{id:'device-one',expiresUtc:new Date(1_001_000).toISOString()}]});await f.lease.refresh();f.setNow(1_000_200);expect(f.lease.check()).toBe(true);f.setGrants({trusted:[{id:'device-one'}],temporary:[]});await f.lease.refresh();expect(f.lease.accessLevel).toBe('permanent');
  });
  it('does not accept another device grant or malformed expiry',async()=>{
    for(const grants of [{trusted:[{id:'other-device'}],temporary:[]},{trusted:[],temporary:[{id:'device-one',expiresUtc:'invalid'}]}]){const f=fixture();f.setGrants(grants);expect(await f.lease.refresh()).toBe(false);expect(f.lease.check()).toBe(false);}
  });
  it('fails closed when the local grant query fails',async()=>{
    const f=fixture();await f.lease.refresh();f.load.mockRejectedValueOnce(new Error('synthetic'));expect(await f.lease.refresh()).toBe(false);expect(f.denied).toHaveBeenCalledWith('unavailable');
  });
  it('expires verification freshness rather than trusting a stalled polling loop forever',async()=>{
    const f=fixture();await f.lease.refresh();f.setNow(1_005_000);expect(f.lease.check()).toBe(false);expect(f.denied).toHaveBeenCalledWith('stale');
  });
  it('deduplicates refresh and ignores completion after session retirement',async()=>{
    const f=fixture();let finish!:(g:RemoteGrantSnapshot)=>void;f.load.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));const first=f.lease.refresh(),second=f.lease.refresh();expect(first).toBe(second);f.lease.close();finish({trusted:[{id:'device-one'}],temporary:[]});expect(await first).toBe(false);expect(f.lease.accessLevel).toBe('none');expect(f.denied).not.toHaveBeenCalled();
  });
  it('does not treat a long-delayed old snapshot as freshly verified',async()=>{
    const f=fixture();let finish!:(g:RemoteGrantSnapshot)=>void;f.load.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));const pending=f.lease.refresh();f.setNow(1_006_000);finish({trusted:[{id:'device-one'}],temporary:[]});expect(await pending).toBe(false);expect(f.denied).toHaveBeenCalledWith('stale');
  });
  it('fails closed on an invalid snapshot shape',async()=>{
    const f=fixture();f.load.mockResolvedValueOnce({} as RemoteGrantSnapshot);expect(await f.lease.refresh()).toBe(false);expect(f.denied).toHaveBeenCalledWith('unavailable');
  });
});
