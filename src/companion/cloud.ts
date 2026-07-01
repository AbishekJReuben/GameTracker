/**
 * Phone-side WebRTC **guest**. Joins the signaling room by connection code, accepts
 * the host's offer, and exposes the three data channels as a simple API:
 *   - request(path)   : id-correlated stats request over the "data" channel
 *   - onFrame(cb)     : base64 JPEG frames from the "screen" channel
 *   - sendControl(m)  : input events over the "control" channel
 */

import { Signaling, defaultIceServers, pipeIce, type IceServer } from "@/lib/rtc";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class CloudConn {
  private sig: Signaling;
  private pc: RTCPeerConnection | null = null;
  private chScreen?: RTCDataChannel;
  private chControl?: RTCDataChannel;
  private chData?: RTCDataChannel;
  private reqId = 1;
  private pending = new Map<number, Pending>();
  private frameCb: ((b64: string) => void) | null = null;
  private statusCb: ((s: RTCPeerConnectionState | "error") => void) | null = null;

  constructor(private signalUrl: string, private code: string, private iceServers?: IceServer[]) {
    this.sig = new Signaling(signalUrl, code, "guest");
  }

  async connect(): Promise<void> {
    this.sig.onMessage(async (m) => {
      if (m.type === "offer") await this.onOffer(m.sdp);
      else if (m.type === "candidate" && this.pc) {
        try {
          await this.pc.addIceCandidate(m.candidate);
        } catch {
          /* ignore */
        }
      } else if (m.type === "peer-left") this.statusCb?.("disconnected");
      else if (m.type === "room-full") this.statusCb?.("error");
    });
    await this.sig.connect();
    // Our join makes the host emit its offer; we answer in onOffer().
  }

  private async onOffer(sdp: string) {
    this.pc = new RTCPeerConnection({ iceServers: defaultIceServers(this.iceServers) });
    pipeIce(this.pc, this.sig);
    this.pc.onconnectionstatechange = () => this.statusCb?.(this.pc!.connectionState);
    this.pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === "screen") {
        this.chScreen = ch;
        ch.onmessage = (ev) => this.frameCb?.(ev.data as string);
      } else if (ch.label === "control") {
        this.chControl = ch;
      } else if (ch.label === "data") {
        this.chData = ch;
        ch.onmessage = (ev) => this.onData(ev.data as string);
      }
    };
    await this.pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sig.send({ type: "answer", sdp: answer.sdp ?? "" });
  }

  private onData(raw: string) {
    try {
      const msg = JSON.parse(raw) as { id: number; ok: boolean; data?: unknown; error?: string };
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error ?? "request failed"));
    } catch {
      /* ignore */
    }
  }

  request<T>(path: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.chData || this.chData.readyState !== "open") {
        reject(new Error("Not connected yet."));
        return;
      }
      const id = this.reqId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.chData.send(JSON.stringify({ id, path }));
      window.setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("Request timed out."));
        }
      }, 8000);
    });
  }

  onFrame(cb: (b64: string) => void) {
    this.frameCb = cb;
  }
  sendControl(msg: unknown) {
    if (this.chControl?.readyState === "open") this.chControl.send(JSON.stringify(msg));
  }
  onStatus(cb: (s: RTCPeerConnectionState | "error") => void) {
    this.statusCb = cb;
  }
  close() {
    this.pc?.close();
    this.pc = null;
    this.sig.close();
  }
}
