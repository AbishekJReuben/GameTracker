import { describe,expect,it } from 'vitest';
import { parseHandshake, type RemoteHandshake } from './remoteProtocol';
const d={id:'p',index:0,name:'Primary',x:-1920,y:0,width:1920,height:1080,rotation:0,isPrimary:true,selected:true,layoutRevision:2};
const h:RemoteHandshake={version:1,capabilities:['view-state-v1'],sessionId:'s',layout:{revision:2,bounds:d,displays:[d]},view:{epoch:0,layoutRevision:2,mode:'single',selectedDisplayId:'p',source:d,width:1920,height:1080,displays:[d]},overlayAvailable:false};
describe('negotiated remote geometry validation',()=>{
  it('accepts physical negative origins, initial epoch zero and harmless optional fields',()=>{
    expect(parseHandshake({...h,newField:true,capabilities:['view-state-v1','future-v9']})).toMatchObject({...h,capabilities:['view-state-v1']});
  });
  it('rejects stale geometry, duplicates and a selected display outside the capture',()=>{
    expect(parseHandshake({...h,view:{...h.view,layoutRevision:1}})).toBeNull();
    expect(parseHandshake({...h,layout:{...h.layout,displays:[d,d]}})).toBeNull();
    expect(parseHandshake({...h,view:{...h.view,selectedDisplayId:'elsewhere'}})).toBeNull();
  });
  it('rejects malformed dimensions, unbounded outputs and source/captured-geometry disagreement',()=>{
    for(const width of [NaN,Infinity,-1,0,100000])expect(parseHandshake({...h,view:{...h.view,width}})).toBeNull();
    expect(parseHandshake({...h,view:{...h.view,source:{...d,x:0}}})).toBeNull();
    expect(parseHandshake({...h,view:{...h.view,displays:[{...d,width:500}]}})).toBeNull();
  });
});
