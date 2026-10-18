// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {EpochVideoHost} from './epochVideo';
import type {CaptureIdentity} from './captureView';

const display={id:'left',index:0,name:'left',x:0,y:0,width:1920,height:1080,rotation:0 as const,isPrimary:true,selected:true,layoutRevision:1};
const identity:CaptureIdentity={sessionId:'rtc-owner',requestId:'first',view:{epoch:1,layoutRevision:1,mode:'single',selectedDisplayId:'left',source:display,width:1920,height:1080,displays:[display]}};
class Stream{static n=0;id=`stream-${++Stream.n}`;constructor(private tracks:MediaStreamTrack[]=[]){}getVideoTracks(){return this.tracks;}getTracks(){return this.tracks;}}
class Peer{
  localDescription:RTCSessionDescriptionInit|null=null;remoteDescription:RTCSessionDescriptionInit|null=null;connectionState='new';
  onicecandidate:unknown=null;ontrack:unknown=null;onconnectionstatechange:unknown=null;
  stream!:MediaStream;track!:MediaStreamTrack;
  addTrack(track:MediaStreamTrack,stream:MediaStream){this.track=track;this.stream=stream;return {track};}
  async createOffer(){return {type:'offer',sdp:`v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=msid:${this.stream.id} ${this.track.id}\r\n`} as RTCSessionDescriptionInit;}
  async setLocalDescription(value:RTCSessionDescriptionInit){this.localDescription=value;}
  close=vi.fn(()=>{this.connectionState='closed';});
}
let host:EpochVideoHost;
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('MediaStream',Stream);});
afterEach(()=>{host?.close();vi.useRealTimers();vi.unstubAllGlobals();});
function fixture(){const send=vi.fn(()=>true),failed=vi.fn(),pcs:Peer[]=[];host=new EpochVideoHost(identity.sessionId,send,()=>({}),()=>true,async()=>true,()=>{},failed,()=>{const p=new Peer();pcs.push(p);return p as unknown as RTCPeerConnection;});const track={id:'track-1',kind:'video',readyState:'live'} as MediaStreamTrack;return {send,failed,pcs,track};}
describe('RTC versus DIRECT ownership',()=>{
  it('allows real RTC fallback again after an explicit DIRECT opt-out',async()=>{
    const f=fixture();host.directCommit(identity);expect(host.resumeRtc()).toBe(true);await host.stage(identity,f.track);
    expect(f.pcs).toHaveLength(1);expect(f.send).toHaveBeenCalledWith(expect.objectContaining({event:'epoch-video-offer'}));
  });
  it('does not start a redundant RTC peer after DIRECT has already committed',async()=>{
    const f=fixture();host.directCommit(identity);await host.stage(identity,f.track);await vi.advanceTimersByTimeAsync(10000);
    expect(f.pcs).toHaveLength(0);expect(f.failed).not.toHaveBeenCalled();
  });
  it('retires a pending RTC timer when DIRECT wins',async()=>{
    const f=fixture();await host.stage(identity,f.track);host.directCommit(identity);await vi.advanceTimersByTimeAsync(10000);
    expect(f.pcs[0].close).toHaveBeenCalledOnce();expect(host.count).toBe(0);expect(f.failed).not.toHaveBeenCalled();
  });
  it('still reports a genuine RTC setup timeout',async()=>{
    const f=fixture();await host.stage(identity,f.track);await vi.advanceTimersByTimeAsync(9001);
    expect(f.failed).toHaveBeenCalledWith(identity,'RTC view setup timed out',f.track);expect(host.count).toBe(0);
  });
});
