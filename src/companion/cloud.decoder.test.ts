import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudConn } from "./cloud";
import type { VideoHeader } from "./videoReceive";
import * as native from "./nativeDecoder";

vi.mock("./nativeDecoder", () => ({
  nativeDecoderPossible: vi.fn(() => false), nativeFeedReady: vi.fn(() => true),
  probeNativeDecoder: vi.fn(), initNativeDecoder: vi.fn().mockResolvedValue(null),
  teardownNativeDecoder: vi.fn().mockResolvedValue(undefined),
  resetNativeDecoder: vi.fn().mockResolvedValue(null),
  setStreamPowerActive: vi.fn().mockResolvedValue(undefined),
  dumpNativeDecoderDiag: vi.fn().mockResolvedValue(""),
  getNativeDecoderStats: vi.fn(), feedNativeDecoder: vi.fn(() => true),
  nativeFrameProofAvailable:vi.fn(()=>true),nativeFeedGeneration:vi.fn(()=>0),nativeBoundsSequence:vi.fn(()=>0),nativeBoundsViewEpoch:vi.fn(()=>0),nativePresentationTimestamp:vi.fn(()=>1),revealNativeFrame:vi.fn(),clearNativeTransition:vi.fn(),
}));

class Decoder {
  static all: Decoder[] = [];
  decodeQueueSize = 0;
  decode = vi.fn();
  configure = vi.fn();
  close = vi.fn();
  constructor(public init: VideoDecoderInit) { Decoder.all.push(this); }
}
class Chunk { constructor(public init: EncodedVideoChunkInit & { transfer?: ArrayBuffer[] }) {} }
type Internals = {
  wcBuildWebCodecsDecoder(): boolean; wcBuildDecoder(): boolean;
  wcFeedFrame(h: VideoHeader, data: Uint8Array<ArrayBuffer>): void;
  wcReset(reprobe: boolean): void; wcPlayDrain(): void; wcFlushPaceQueue(present?: boolean): void;
  wcPollNativeStats(): Promise<void>;
  emitDecoderFallback(reason:string,detail:string):Promise<void>;
  wcMeta: Map<number, unknown>; wcAwaitKey: boolean; wcFrameCb: (f: VideoFrame) => void;
  wcPlayQ: { frame: VideoFrame; showAt: number }[];
  wcNative: boolean; wcActive: boolean; wcNativeFrames: number; wcNativePollAt: number;
  wcFrames: number; wcLastFrameAt: number;
  wcNativeReady: boolean;
  powerIdle: boolean;
};
let conn: CloudConn;
let c: Internals;
let sequence = 0;
function feed(key = false) {
  const n = ++sequence;
  c.wcFeedFrame({ key, seq: n, len: 4, tsMs: n * 16 }, new Uint8Array([0, 0, 1, key ? 5 : 1]));
}
function frame(timestamp = 16000) { return { timestamp, close: vi.fn() } as unknown as VideoFrame; }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(100000);
  vi.mocked(native.nativeDecoderPossible).mockReturnValue(false);
  Decoder.all = []; sequence = 0;
  vi.stubGlobal("VideoDecoder", Decoder); vi.stubGlobal("EncodedVideoChunk", Chunk);
  conn = new CloudConn("wss://unused.example", "test");
  c = conn as unknown as Internals;
});
afterEach(() => { conn.close(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("phone decoder lifecycle (no visual testing)", () => {
  it('does not flash a warning for a native error that recovers within one poll',async()=>{
    const events:Record<string,unknown>[]=[];conn.onEvent(e=>events.push(e));c.wcNative=true;c.wcActive=true;
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({frames:0,queue:0,decodeMs:0,active:false,width:2160,height:1214,error:'CodecException'});
    await c.wcPollNativeStats();await vi.advanceTimersByTimeAsync(250);
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({frames:1,queue:0,decodeMs:9,active:true,width:2160,height:1214,error:''});await c.wcPollNativeStats();
    expect(events.filter(e=>e.event==='decoder'&&e.state==='error')).toHaveLength(0);
  });
  it('clears a persistent native error only after fresh surface presentation',async()=>{
    const events:Record<string,unknown>[]=[];conn.onEvent(e=>events.push(e));c.wcNative=true;c.wcActive=true;
    const stats={frames:0,queue:0,decodeMs:0,active:false,width:2160,height:1214,error:'CodecException'};
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue(stats);
    for(let i=0;i<4;i++){await c.wcPollNativeStats();await vi.advanceTimersByTimeAsync(250);}
    expect(events.filter(e=>e.event==='decoder'&&e.state==='error')).toHaveLength(1);
    const rendered={version:2,feedSession:4,codecGeneration:7,ptsUs:100,frames:1,boundsSequence:8,visiblePtsUs:0,visibleBoundsSequence:0,layer:'texture' as const};
    vi.mocked(native.nativeFeedGeneration).mockReturnValue(4);vi.mocked(native.nativeBoundsSequence).mockReturnValue(8);
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({...stats,active:true,error:'',frames:1,rendered});await c.wcPollNativeStats();
    expect(events.filter(e=>e.state==='recovered')).toHaveLength(0);
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({...stats,active:true,error:'',frames:1,rendered:{...rendered,visiblePtsUs:100,visibleBoundsSequence:8}});
    await c.wcPollNativeStats();await c.wcPollNativeStats();expect(events.filter(e=>e.state==='recovered')).toHaveLength(1);
    vi.mocked(native.nativeFeedGeneration).mockReturnValue(0);vi.mocked(native.nativeBoundsSequence).mockReturnValue(0);
  });
  it('cannot restore an old fallback warning when its diagnostics arrive after a good picture',async()=>{
    const events:Record<string,unknown>[]=[];conn.onEvent(e=>events.push(e));
    let resolve!:(value:string)=>void;vi.mocked(native.dumpNativeDecoderDiag).mockReturnValue(new Promise(r=>{resolve=r;}));
    const warning=c.emitDecoderFallback('Phone decoder fallback','old failure');
    c.wcBuildWebCodecsDecoder();c.wcFrameCb=()=>true;feed(true);Decoder.all[0].init.output(frame());await Promise.resolve();
    resolve('late dump');await warning;
    expect(events.filter(e=>e.event==='decoder'&&e.state==='fallback')).toHaveLength(0);
  });
  it("recovers a silent mid-session native stall before abandoning the phone decoder", async () => {
    c.wcNative = true; c.wcNativeReady = true; c.wcActive = true; c.wcFrames = 48256;
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({
      frames: 3990, queue: 0, decodeMs: 13.2, active: true, width: 2160, height: 1214,
      error: "", surfaceReady: true, csdQueued: true, awaitKey: false,
    });
    for (let i = 0; i < 15; i++) {
      c.wcFrames++; c.wcLastFrameAt = Date.now();
      await c.wcPollNativeStats(); await vi.advanceTimersByTimeAsync(250);
    }
    expect(native.resetNativeDecoder).toHaveBeenCalledOnce();
    expect(c.wcNative).toBe(true);
    expect(Decoder.all).toHaveLength(0);
  });
  it('uses actual surface presentation when codec releases buffers but the TextureView freezes', async () => {
    c.wcNative = true; c.wcNativeReady = true; c.wcActive = true;
    const rendered={version:2,feedSession:4,codecGeneration:7,ptsUs:100,frames:3990,boundsSequence:8,layer:'texture' as const};
    for (let i = 0; i < 15; i++) {
      vi.mocked(native.getNativeDecoderStats).mockResolvedValue({ rendered, frames: 3990+i, queue: 0, decodeMs: 13.2,
        active: true, width: 2160, height: 1214, error: '', csdQueued: true });
      c.wcFrames++; c.wcLastFrameAt = Date.now();
      await c.wcPollNativeStats(); await vi.advanceTimersByTimeAsync(250);
    }
    expect(native.resetNativeDecoder).toHaveBeenCalledOnce();
    expect(c.wcNative).toBe(true);
  });

  it('falls back after two native recovery attempts when pictures never resume', async () => {
    c.wcNative = true; c.wcNativeReady = true; c.wcActive = true;
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({ frames:3990,queue:0,decodeMs:13.2,active:true,
      width:2160,height:1214,error:'',surfaceReady:true,csdQueued:true });
    for (let i=0;i<45;i++) {
      c.wcFrames++;c.wcLastFrameAt=Date.now();
      await c.wcPollNativeStats();await vi.advanceTimersByTimeAsync(250);
    }
    expect(native.resetNativeDecoder).toHaveBeenCalledTimes(2);
    expect(c.wcNative).toBe(false);expect(Decoder.all).toHaveLength(1);
    expect(native.teardownNativeDecoder).toHaveBeenCalledWith(true);
  });

  it('cannot revive native decoding when recovery completes after teardown', async () => {
    c.wcNative = true;c.wcNativeReady = true;c.wcActive = true;
    let resolve!: (value:null)=>void;
    vi.mocked(native.resetNativeDecoder).mockReturnValue(new Promise(r=>{resolve=r;}));
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({frames:3990,queue:0,decodeMs:13.2,active:true,
      width:2160,height:1214,error:'',csdQueued:true});
    for(let i=0;i<15;i++){
      c.wcFrames++;c.wcLastFrameAt=Date.now();await c.wcPollNativeStats();await vi.advanceTimersByTimeAsync(250);
    }
    expect(native.resetNativeDecoder).toHaveBeenCalledOnce();c.wcReset(false);resolve(null);
    await Promise.resolve();await Promise.resolve();
    expect(c.wcNative).toBe(false);expect(c.wcNativeReady).toBe(false);
  });
  it('reveals actual native resized frames on the old-host compatibility path without inventing an epoch acknowledgment',async()=>{
    c.wcNative=true;c.wcActive=true;vi.mocked(native.nativeBoundsSequence).mockReturnValue(8);vi.mocked(native.nativeFeedGeneration).mockReturnValue(4);
    const rendered={version:2,feedSession:4,codecGeneration:7,ptsUs:100,frames:1,boundsSequence:8,visiblePtsUs:0,visibleBoundsSequence:0,layer:'texture' as const};
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({rendered,frames:1,queue:0,decodeMs:1,active:true,width:1920,height:1080,error:''});await c.wcPollNativeStats();expect(native.revealNativeFrame).toHaveBeenCalledExactlyOnceWith(rendered);
    vi.mocked(native.nativeBoundsSequence).mockReturnValue(0);vi.mocked(native.nativeFeedGeneration).mockReturnValue(0);
  });
  it("caps hidden hardware work even when decodeQueueSize remains zero, then waits for IDR", () => {
    c.wcBuildWebCodecsDecoder();
    feed(true);
    for (let i = 0; i < 5; i++) feed();
    expect(Decoder.all[0].decode).toHaveBeenCalledTimes(6);
    feed();
    expect(Decoder.all[0].close).toHaveBeenCalledOnce();
    expect(c.wcMeta.size).toBe(0); expect(c.wcAwaitKey).toBe(true);
    feed(); expect(Decoder.all[1].decode).not.toHaveBeenCalled();
    feed(true); expect(Decoder.all[1].decode).toHaveBeenCalledOnce();
    expect(c.wcAwaitKey).toBe(false);
  });

  it("recovers a slow decoder at the next keyframe without discarding that keyframe", () => {
    c.wcBuildWebCodecsDecoder(); feed(true);
    vi.advanceTimersByTime(151); feed(true);
    expect(Decoder.all).toHaveLength(2);
    expect(Decoder.all[1].decode).toHaveBeenCalledOnce();
    expect(c.wcMeta.size).toBe(1);
  });

  it("transfers AU storage to WebCodecs and retires bookkeeping on output", () => {
    c.wcBuildWebCodecsDecoder(); feed(true);
    const chunk = Decoder.all[0].decode.mock.calls[0][0] as Chunk;
    expect(chunk.init.transfer).toEqual([(chunk.init.data as Uint8Array).buffer]);
    Decoder.all[0].init.output(frame());
    expect(c.wcMeta.size).toBe(0);
  });

  it("late callbacks from an old decoder cannot render or kill the new decoder", () => {
    c.wcBuildWebCodecsDecoder(); feed(true);
    const old = Decoder.all[0];
    c.wcBuildWebCodecsDecoder(); feed(true);
    const sink = vi.fn(); c.wcFrameCb = sink;
    const stale = frame(); old.init.output(stale);
    old.init.error(new DOMException("stale"));
    expect(stale.close).toHaveBeenCalledOnce(); expect(sink).not.toHaveBeenCalled();
    expect(Decoder.all[1].close).not.toHaveBeenCalled(); expect(c.wcAwaitKey).toBe(false);
  });

  it("coalesces decoded bursts within the same task without adding a display-frame wait", async () => {
    c.wcBuildWebCodecsDecoder(); feed(true); feed();
    const first = frame(16000), second = frame(32000);
    const sink = vi.fn((f: VideoFrame) => f.close()); c.wcFrameCb = sink;
    Decoder.all[0].init.output(first); Decoder.all[0].init.output(second);
    expect(first.close).toHaveBeenCalledOnce(); expect(sink).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(sink).toHaveBeenCalledExactlyOnceWith(second);
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("cannot paint an immediate frame queued just before a decoder reset", async () => {
    c.wcBuildWebCodecsDecoder(); feed(true);
    const f = frame(), sink = vi.fn(); c.wcFrameCb = sink;
    Decoder.all[0].init.output(f); c.wcReset(false);
    await Promise.resolve();
    expect(f.close).toHaveBeenCalledOnce(); expect(sink).not.toHaveBeenCalled();
  });

  it("presents only the newest due decoded frame and closes every superseded frame", () => {
    const frames = [frame(1), frame(2), frame(3)];
    const sink = vi.fn((f: VideoFrame) => f.close()); c.wcFrameCb = sink;
    c.wcPlayQ = frames.map((f) => ({ frame: f, showAt: Date.now() - 10 }));
    c.wcPlayDrain();
    expect(sink).toHaveBeenCalledExactlyOnceWith(frames[2]);
    frames.forEach((f) => expect(f.close).toHaveBeenCalledOnce());
  });

  it("teardown closes pending pictures without drawing them", () => {
    const f = frame(); const sink = vi.fn(); c.wcFrameCb = sink;
    c.wcPlayQ = [{ frame: f, showAt: Date.now() + 40 }];
    c.wcReset(false);
    expect(f.close).toHaveBeenCalledOnce(); expect(sink).not.toHaveBeenCalled();
  });

  it("hidden clients skip IDRs too and close already-decoded outputs", () => {
    c.wcBuildWebCodecsDecoder(); c.powerIdle = true; feed(true);
    expect(Decoder.all[0].decode).not.toHaveBeenCalled();
    const f = frame(); Decoder.all[0].init.output(f); expect(f.close).toHaveBeenCalledOnce();
  });

  it("a stale native probe cannot initialize after teardown", async () => {
    vi.mocked(native.nativeDecoderPossible).mockReturnValue(true);
    let resolve!: (v: native.DecoderProbe) => void;
    vi.mocked(native.probeNativeDecoder).mockReturnValue(new Promise((r) => { resolve = r; }));
    c.wcBuildDecoder(); c.wcReset(false);
    resolve({ available: true, name: "test", lowLatency: true, detail: "", maxBitrateKbps: 0, high: false });
    await Promise.resolve(); await Promise.resolve();
    expect(native.initNativeDecoder).not.toHaveBeenCalled();
  });

  it("reports 60 native fps and the real queue rather than capping at 32fps/zero queue", async () => {
    c.wcNative = true; c.wcActive = true;
    c.wcNativeFrames = 100;
    vi.advanceTimersByTime(1000); c.wcNativePollAt = performance.now();
    vi.advanceTimersByTime(250);
    vi.mocked(native.getNativeDecoderStats).mockResolvedValue({
      frames: 115, queue: 3, decodeMs: 2, active: true, width: 1920, height: 1080, error: "",
    });
    await c.wcPollNativeStats();
    expect(conn.wcInfo()?.fps).toBe(60); expect(conn.wcInfo()?.queue).toBe(3);
  });

  it("does not overlap JNI stats polls or apply a result after decoder replacement", async () => {
    c.wcNative = true; c.wcActive = true;
    let resolve!: (v: native.DecoderStats) => void;
    vi.mocked(native.getNativeDecoderStats).mockReturnValue(new Promise((r) => { resolve = r; }));
    const pending = c.wcPollNativeStats(); await c.wcPollNativeStats();
    expect(native.getNativeDecoderStats).toHaveBeenCalledOnce();
    c.wcReset(false);
    resolve({ frames: 30, queue: 2, decodeMs: 9, active: true, width: 1920, height: 1080, error: "" });
    await pending;
    expect(c.wcNativeFrames).toBe(0);
  });
});
