import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudConn } from "./cloud";
import type { VideoHeader } from "./videoReceive";

vi.mock("./nativeDecoder", () => ({
  nativeDecoderPossible: vi.fn(() => false), nativeFeedReady: vi.fn(() => true),
  probeNativeDecoder: vi.fn(), initNativeDecoder: vi.fn().mockResolvedValue(null),
  teardownNativeDecoder: vi.fn().mockResolvedValue(undefined),
  setStreamPowerActive: vi.fn().mockResolvedValue(undefined),
  dumpNativeDecoderDiag: vi.fn().mockResolvedValue(""),
  getNativeDecoderStats: vi.fn(), feedNativeDecoder: vi.fn(() => true),
}));

type Internals = {
  wcIngest(h: VideoHeader, b: Uint8Array<ArrayBuffer>): void;
  wcFeedFrame(h: VideoHeader, b: Uint8Array<ArrayBuffer>): void;
  onWcMsg(d: unknown): void;
  sendControl(m: unknown): boolean;
  maybeStartWc(): Promise<void>;
  wcEligible(): boolean;
  wcAwaitKey: boolean;
  wcTransport: string;
  onData(raw: string): void;
};

let conn: CloudConn;
let c: Internals;
let fed: number[];
let sent: Record<string, unknown>[];
const frame = (seq: number, key = false): [VideoHeader, Uint8Array<ArrayBuffer>] =>
  [{ key, seq, tsMs: seq * 16, len: 4 }, new Uint8Array([0, 0, 1, key ? 5 : 1])];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(100000);
  conn = new CloudConn("wss://unused.example", "test");
  c = conn as unknown as Internals;
  fed = [];
  sent = [];
  vi.spyOn(c, "wcFeedFrame").mockImplementation((h) => { fed.push(h.seq); });
  vi.spyOn(c, "sendControl").mockImplementation((m) => { sent.push(m as Record<string, unknown>); return true; });
});
afterEach(() => { conn.close(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("DIRECT over two transports (RTP carrier)", () => {
  it("merges the data channel and the carrier by sequence", () => {
    c.wcIngest(...frame(0, true));
    c.wcIngest(...frame(1));
    // Switch to RTP: frames 3 and 4 overtake the last data-channel frame.
    c.wcIngest(...frame(3));
    c.wcIngest(...frame(4));
    expect(fed).toEqual([0, 1]);
    c.wcIngest(...frame(2));
    expect(fed).toEqual([0, 1, 2, 3, 4]);
  });

  it("a gap that doesn't fill in time is a loss: wait for a keyframe", () => {
    c.wcIngest(...frame(0, true));
    c.wcAwaitKey = false;
    c.wcIngest(...frame(2));
    expect(fed).toEqual([0]);
    vi.advanceTimersByTime(400);
    expect(c.wcAwaitKey).toBe(true);
    expect(sent.some((m) => m.type === "vkf")).toBe(true);
    expect(fed).toEqual([0, 2]); // handed on; wcFeedFrame drops it while awaiting a key
  });

  it("offers the carrier only when the browser has receiver transforms", async () => {
    vi.spyOn(c, "wcEligible").mockReturnValue(true);
    vi.stubGlobal("VideoDecoder", class { static isConfigSupported = async () => ({ supported: true }); });
    vi.stubGlobal("RTCRtpScriptTransform", class {});
    vi.stubGlobal("Worker", class {});
    await c.maybeStartWc();
    expect(sent.find((m) => m.type === "vmode")?.carrier).toBe(true);
  });

  it("tracks the host's transport announcements", () => {
    c.onData(JSON.stringify({ event: "vtransport", mode: "rtp" }));
    expect(c.wcTransport).toBe("rtp");
    c.onData(JSON.stringify({ event: "vtransport", mode: "bogus" }));
    expect(c.wcTransport).toBe("rtp");
    c.onData(JSON.stringify({ event: "vtransport", mode: "sctp" }));
    expect(c.wcTransport).toBe("sctp");
  });
});
