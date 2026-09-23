import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudConn, POWER_IDLE_GRACE_MS } from "./cloud";

vi.mock("./nativeDecoder", () => ({
  nativeDecoderPossible: vi.fn(() => false), nativeFeedReady: vi.fn(() => true),
  probeNativeDecoder: vi.fn(), initNativeDecoder: vi.fn().mockResolvedValue(null),
  teardownNativeDecoder: vi.fn().mockResolvedValue(undefined),
  setStreamPowerActive: vi.fn().mockResolvedValue(undefined),
  dumpNativeDecoderDiag: vi.fn().mockResolvedValue(""),
  getNativeDecoderStats: vi.fn(), feedNativeDecoder: vi.fn(() => true),
}));

type Internals = {
  powerIdle: boolean;
  wcAwaitKey: boolean;
  sendControl(msg: unknown): boolean;
};

let conn: CloudConn;
let c: Internals;
let hidden = false;
let sent: { type: string; idle?: boolean }[] = [];
const win = window as Window & { __GT_PIP_ACTIVE__?: boolean };

function setHidden(v: boolean) {
  hidden = v;
  document.dispatchEvent(new Event("visibilitychange"));
}
function setPip(active: boolean) {
  win.__GT_PIP_ACTIVE__ = active;
  window.dispatchEvent(new CustomEvent("gt:pip", { detail: { active } }));
}
const powerMessages = () => sent.filter((m) => m.type === "power");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"] });
  hidden = false;
  win.__GT_PIP_ACTIVE__ = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  conn = new CloudConn("wss://unused.example", "test");
  c = conn as unknown as Internals;
  sent = [];
  c.sendControl = (msg: unknown) => {
    sent.push(msg as { type: string; idle?: boolean });
    return true;
  };
});

afterEach(() => {
  conn.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete win.__GT_PIP_ACTIVE__;
});

describe("power idle is debounced (PiP / resume handoff)", () => {
  it("entering PiP never tells the host to stop encoding", () => {
    setHidden(true); // Android: page hidden first...
    vi.advanceTimersByTime(300);
    setPip(true); // ...then the PiP flag lands
    vi.advanceTimersByTime(POWER_IDLE_GRACE_MS * 3);
    expect(c.powerIdle).toBe(false);
    expect(powerMessages()).toEqual([]);
  });

  it("leaving PiP back to full screen never pauses either", () => {
    setHidden(true);
    setPip(true);
    vi.advanceTimersByTime(5000);
    setPip(false); // flag drops a beat before the page turns visible
    vi.advanceTimersByTime(400);
    setHidden(false);
    vi.advanceTimersByTime(POWER_IDLE_GRACE_MS * 3);
    expect(c.powerIdle).toBe(false);
    expect(powerMessages()).toEqual([]);
  });

  it("a real background still idles the host after the grace, and waking is immediate", () => {
    setHidden(true);
    vi.advanceTimersByTime(POWER_IDLE_GRACE_MS - 1);
    expect(c.powerIdle).toBe(false);
    vi.advanceTimersByTime(2);
    expect(c.powerIdle).toBe(true);
    expect(powerMessages()).toEqual([{ type: "power", idle: true }]);

    setHidden(false);
    expect(c.powerIdle).toBe(false);
    expect(c.wcAwaitKey).toBe(true); // decoder threw frames away while idle → wait for the IDR
    expect(powerMessages()).toEqual([
      { type: "power", idle: true },
      { type: "power", idle: false },
    ]);
  });

  it("a quick hide/show (notification shade, app switch and back) sends nothing", () => {
    setHidden(true);
    vi.advanceTimersByTime(800);
    setHidden(false);
    vi.advanceTimersByTime(POWER_IDLE_GRACE_MS * 2);
    expect(powerMessages()).toEqual([]);
    expect(c.powerIdle).toBe(false);
  });

  it("keeps decoding (no forced IDR wait) while hidden inside the grace window", () => {
    c.wcAwaitKey = false;
    setHidden(true);
    vi.advanceTimersByTime(500);
    expect(c.powerIdle).toBe(false);
    expect(c.wcAwaitKey).toBe(false);
  });
});
