import { afterEach, describe, expect, it, vi } from "vitest";

import { Signaling, gatheredLocalSdp } from "./rtc";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  send(_data: string) {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("Signaling", () => {
  it("serializes async SDP and candidate handlers in wire order", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const sig = new Signaling("https://signal.example", "room", "guest");
    const order: string[] = [];
    let finishOffer!: () => void;
    const offerGate = new Promise<void>((resolve) => {
      finishOffer = resolve;
    });

    sig.onMessage(async (message) => {
      if (message.type === "offer") {
        order.push("offer:start");
        await offerGate;
        order.push("offer:end");
      } else if (message.type === "candidate") {
        order.push("candidate");
      }
    });

    const connected = sig.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    socket.receive({ type: "offer", sdp: "v=0" });
    socket.receive({ type: "candidate", candidate: { candidate: "candidate:1" } });

    await vi.waitFor(() => expect(order).toEqual(["offer:start"]));
    finishOffer();
    await vi.waitFor(() => expect(order).toEqual(["offer:start", "offer:end", "candidate"]));
    sig.close();
  });
});

describe("gatheredLocalSdp", () => {
  it("returns the post-gather local-description snapshot", async () => {
    const pc = new EventTarget() as EventTarget & {
      iceGatheringState: RTCIceGatheringState;
      localDescription: RTCSessionDescriptionInit | null;
    };
    pc.iceGatheringState = "gathering";
    pc.localDescription = { type: "offer", sdp: "without-candidate" };

    const result = gatheredLocalSdp(pc as RTCPeerConnection, 1000);
    pc.localDescription = { type: "offer", sdp: "with-candidate" };
    pc.iceGatheringState = "complete";
    pc.dispatchEvent(new Event("icegatheringstatechange"));

    await expect(result).resolves.toBe("with-candidate");
  });
});
