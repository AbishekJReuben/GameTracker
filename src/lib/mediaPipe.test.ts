import { describe, expect, it, vi } from "vitest";
import { MediaPipe } from "./mediaPipe";

/** Minimal stand-in for the browser WebSocket, driven by the test. */
class FakeWs {
  static last: FakeWs | null = null;
  readyState = 0; // CONNECTING
  binaryType = "blob";
  sent: string[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.last = this;
  }
  send(t: string) {
    this.sent.push(t);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // test helpers
  accept(id: number) {
    this.readyState = 1; // OPEN
    this.onmessage?.({ data: JSON.stringify({ hello: id }) });
  }
  binary(bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const Ctor = FakeWs as unknown as new (url: string) => WebSocket;
const ep = { port: 45678, token: "t0k/en" };

describe("MediaPipe", () => {
  it("connects with the token, resolves on hello and forwards binary in order", async () => {
    const got: number[][] = [];
    const p = MediaPipe.open(ep, (b) => got.push([...new Uint8Array(b)]), 1000, Ctor);
    const ws = FakeWs.last!;
    expect(ws.url).toBe("ws://127.0.0.1:45678/pipe?token=t0k%2Fen");
    expect(ws.binaryType).toBe("arraybuffer");
    ws.accept(7);
    const pipe = await p;
    expect(pipe?.id).toBe(7);
    ws.binary([1, 2]);
    ws.binary([3]);
    expect(got).toEqual([[1, 2], [3]]);
  });

  it("resolves null when the server refuses or never says hello", async () => {
    const refused = MediaPipe.open(ep, () => {}, 1000, Ctor);
    FakeWs.last!.drop();
    expect(await refused).toBeNull();

    vi.useFakeTimers();
    const silent = MediaPipe.open(ep, () => {}, 50, Ctor);
    vi.advanceTimersByTime(60);
    expect(await silent).toBeNull();
    vi.useRealTimers();
  });

  it("frames input and acks exactly as the Rust PipeMsg enum expects", async () => {
    const p = MediaPipe.open(ep, () => {}, 1000, Ctor);
    const ws = FakeWs.last!;
    ws.accept(3);
    const pipe = (await p)!;
    const raw = '{"type":"click","x":0.5,"y":0.5,"button":"left"}';
    expect(pipe.injectRaw(raw)).toBe(true);
    expect(pipe.injectOnRaw(2, raw)).toBe(true);
    expect(pipe.ack(4, 99)).toBe(true);
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { t: "in", e: JSON.parse(raw) },
      { t: "inm", m: 2, e: JSON.parse(raw) },
      { t: "ack", g: 4, s: 99 },
    ]);
  });

  it("reports an unexpected close once, but not a deliberate one", async () => {
    const p1 = MediaPipe.open(ep, () => {}, 1000, Ctor);
    const ws1 = FakeWs.last!;
    ws1.accept(1);
    const pipe1 = (await p1)!;
    const closed = vi.fn();
    pipe1.onClose(closed);
    ws1.drop();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(pipe1.sendText("x")).toBe(false);

    const p2 = MediaPipe.open(ep, () => {}, 1000, Ctor);
    const ws2 = FakeWs.last!;
    ws2.accept(2);
    const pipe2 = (await p2)!;
    const closed2 = vi.fn();
    pipe2.onClose(closed2);
    pipe2.close();
    expect(closed2).not.toHaveBeenCalled();
  });
});
