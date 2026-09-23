import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudConn } from "./cloud";
import * as native from "./nativeDecoder";
import { STREAM_TUNE_DEFAULTS } from "./streamTune";

vi.mock("./nativeDecoder", () => ({
  nativeDecoderPossible: vi.fn(() => false), nativeFeedReady: vi.fn(() => true),
  probeNativeDecoder: vi.fn(), initNativeDecoder: vi.fn().mockResolvedValue(null),
  teardownNativeDecoder: vi.fn().mockResolvedValue(undefined),
  setStreamPowerActive: vi.fn().mockResolvedValue(undefined),
  dumpNativeDecoderDiag: vi.fn().mockResolvedValue(""),
  getNativeDecoderStats: vi.fn(), feedNativeDecoder: vi.fn(() => true),
}));

/** Codecs the fake WebCodecs decoder claims to support. */
let supported = new Set<string>();
class Decoder {
  static all: Decoder[] = [];
  static isConfigSupported = vi.fn(async (cfg: VideoDecoderConfig) => ({ supported: supported.has(cfg.codec), config: cfg }));
  decodeQueueSize = 0;
  decode = vi.fn();
  configure = vi.fn();
  close = vi.fn();
  constructor(public init: VideoDecoderInit) { Decoder.all.push(this); }
}

type Internals = {
  wcProbeDecoder(): Promise<boolean>;
  maybeStartWc(): Promise<void>;
  wcEligible(): boolean;
  wcWantHigh(): boolean;
  wcBuildWebCodecsDecoder(): boolean;
  startLinkReports(): void;
  sendControl(msg: unknown): boolean;
  bestClock(): { off: number; rtt: number } | null;
  wcCodec: string; wcActive: boolean; wcHighFailed: boolean; wcSupported: boolean | null;
  authState: string; audioStudio: boolean;
  a2Loss: { push(seq: number, now: number): void };
};
let conn: CloudConn;
let c: Internals;
let sent: Record<string, unknown>[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(100000);
  vi.mocked(native.nativeDecoderPossible).mockReturnValue(false);
  supported = new Set(["avc1.42C028"]);
  Decoder.all = [];
  vi.stubGlobal("VideoDecoder", Decoder);
  conn = new CloudConn("wss://unused.example", "test");
  c = conn as unknown as Internals;
  sent = [];
  vi.spyOn(c, "sendControl").mockImplementation((m) => { sent.push(m as Record<string, unknown>); return true; });
});
afterEach(() => { conn.close(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("H.264 High opt-in (R3)", () => {
  it("asks for High + the decoder cap when MediaCodec lists High", async () => {
    vi.mocked(native.nativeDecoderPossible).mockReturnValue(true);
    vi.mocked(native.probeNativeDecoder).mockResolvedValue({
      available: true, name: "c2.qti.avc.decoder.low_latency", lowLatency: true, detail: "",
      maxBitrateKbps: 30000, high: true,
    });
    vi.spyOn(c, "wcEligible").mockReturnValue(true);
    await c.maybeStartWc();
    expect(sent).toContainEqual({ type: "vmode", mode: "wc", high: true, maxKbps: 30000 });
  });

  it("stays on Baseline (and sends no cap) when the decoder lacks High", async () => {
    vi.spyOn(c, "wcEligible").mockReturnValue(true);
    await c.maybeStartWc();
    expect(sent).toContainEqual({ type: "vmode", mode: "wc", high: false });
  });

  it("uses WebCodecs isConfigSupported for High off the APK", async () => {
    supported = new Set(["avc1.42C028", "avc1.640C2A"]);
    expect(await c.wcProbeDecoder()).toBe(true);
    expect(c.wcWantHigh()).toBe(true);
  });

  it("the Tune toggle turns it off", async () => {
    supported = new Set(["avc1.42C028", "avc1.640C2A"]);
    await c.wcProbeDecoder();
    conn.applyStreamTune({ ...STREAM_TUNE_DEFAULTS, h264High: false });
    expect(c.wcWantHigh()).toBe(false);
  });

  it("drops to Baseline live when a High stream never decodes", async () => {
    supported = new Set(["avc1.42C028", "avc1.640C2A"]);
    await c.wcProbeDecoder();
    c.wcActive = true;
    c.wcCodec = "avc1.640C2A";
    c.wcBuildWebCodecsDecoder();
    Decoder.all[0].init.error(new DOMException("bad"));
    expect(c.wcHighFailed).toBe(false); // one error could be anything
    c.wcBuildWebCodecsDecoder();
    Decoder.all[1].init.error(new DOMException("bad"));
    expect(c.wcHighFailed).toBe(true);
    expect(sent).toContainEqual({ type: "vprofile", high: false });
    expect(c.wcWantHigh()).toBe(false);
  });

  it("does not blame High for errors after frames decoded", async () => {
    supported = new Set(["avc1.42C028", "avc1.640C2A"]);
    await c.wcProbeDecoder();
    c.wcActive = true;
    c.wcCodec = "avc1.640C2A";
    c.wcBuildWebCodecsDecoder();
    const d = Decoder.all[0];
    d.init.output({ timestamp: 1, close: vi.fn() } as unknown as VideoFrame);
    d.init.error(new DOMException("bad"));
    c.wcBuildWebCodecsDecoder();
    Decoder.all[1].init.output({ timestamp: 2, close: vi.fn() } as unknown as VideoFrame);
    Decoder.all[1].init.error(new DOMException("bad"));
    expect(c.wcHighFailed).toBe(false);
  });
});

describe("link report carries raw loss + RTT (R6)", () => {
  it("reports audio2 sequence gaps and the base RTT", () => {
    c.wcActive = true;
    c.authState = "ok";
    c.audioStudio = true;
    vi.spyOn(c, "bestClock").mockReturnValue({ off: 0, rtt: 24 });
    const now = Date.now();
    for (let i = 0; i < 400; i++) if (i % 100 !== 7) c.a2Loss.push(i, now - 4000 + i * 10);
    c.startLinkReports();
    vi.advanceTimersByTime(250);
    const r = sent.find((m) => m.type === "vstat")!;
    expect(r.lossN).toBe(4);
    expect(r.loss).toBeCloseTo(0.01, 4);
    expect(r.rttMs).toBe(24);
  });

  it("sends −1 without STUDIO audio", () => {
    c.wcActive = true;
    c.authState = "ok";
    c.audioStudio = false;
    c.startLinkReports();
    vi.advanceTimersByTime(250);
    expect(sent.find((m) => m.type === "vstat")!.loss).toBe(-1);
  });
});
