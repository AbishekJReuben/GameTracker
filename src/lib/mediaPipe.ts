/**
 * Host-page client for the Rust loopback **media pipe** (`src-tauri/src/remote/pipe.rs`).
 *
 * Why: a Tauri 2 `Channel` message ≥ 1 KB is delivered as an `eval` + `ipc://` fetch,
 * and on Windows both hops run on the app's main UI thread — so every encoded frame,
 * every 10 ms audio packet and (via `invoke`) every phone input event competed for
 * that one thread, and separate invokes were not even ordered. This socket carries
 * the same bytes over 127.0.0.1: capture thread → tokio → the WebView's network
 * stack, in order, with no UI-thread hop in either direction.
 *
 * The pipe is strictly an optimisation: `open` resolves null on any failure and
 * callers keep the Channel / invoke paths. A pipeline started on a pipe sends ONLY
 * there, so when a pipe closes mid-stream its owner restarts on the Channel path
 * (new capture generation + IDR) instead of mixing transports.
 */

export interface PipeEndpoint {
  port: number;
  token: string;
}

type WsCtor = new (url: string) => WebSocket;

export class MediaPipe {
  private closedByUs = false;
  private closeCbs = new Set<() => void>();

  private constructor(
    private readonly ws: WebSocket,
    /** Rust-side client id (`{"hello":id}`); pass it to the start commands. */
    readonly id: number,
  ) {
    ws.onclose = () => {
      const cbs = [...this.closeCbs];
      this.closeCbs.clear();
      if (!this.closedByUs) for (const cb of cbs) cb();
    };
  }

  /**
   * Connect and wait for the hello. `onBinary` gets every binary message (frames or
   * PCM, exactly as the Channel would have delivered them). Resolves null on error,
   * refusal or timeout — never throws.
   */
  static open(
    ep: PipeEndpoint,
    onBinary: (buf: ArrayBuffer) => void,
    timeoutMs = 1500,
    Ctor: WsCtor = WebSocket,
  ): Promise<MediaPipe | null> {
    return new Promise((resolve) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new Ctor(`ws://127.0.0.1:${ep.port}/pipe?token=${encodeURIComponent(ep.token)}`);
      } catch {
        resolve(null);
        return;
      }
      ws.binaryType = "arraybuffer";
      const fail = () => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve(null);
      };
      const timer = setTimeout(fail, timeoutMs);
      ws.onerror = fail;
      ws.onclose = fail;
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") {
          if (settled) onBinary(ev.data as ArrayBuffer);
          return;
        }
        if (settled) return;
        let id = 0;
        try {
          id = Number((JSON.parse(ev.data) as { hello?: number }).hello) || 0;
        } catch {
          /* not a hello */
        }
        if (!id) return;
        settled = true;
        clearTimeout(timer);
        ws.onerror = null;
        const pipe = new MediaPipe(ws, id);
        ws.onmessage = (m: MessageEvent) => {
          if (typeof m.data !== "string") onBinary(m.data as ArrayBuffer);
        };
        resolve(pipe);
      };
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Run once if the pipe closes on its own (not via `close()`). */
  onClose(cb: () => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  /** Send a text control message; false if the socket isn't open. */
  sendText(text: string): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  /** Primary-display input. `rawEvent` is the guest's JSON text, forwarded as-is. */
  injectRaw(rawEvent: string): boolean {
    return this.sendText(`{"t":"in","e":${rawEvent}}`);
  }

  /** Pop-out input pinned to `monitor`. */
  injectOnRaw(monitor: number, rawEvent: string): boolean {
    return this.sendText(`{"t":"inm","m":${monitor | 0},"e":${rawEvent}}`);
  }

  /** Fast-delivery credit return (was an invoke per frame). */
  ack(generation: number, sequence: number): boolean {
    return this.sendText(`{"t":"ack","g":${generation >>> 0},"s":${sequence >>> 0}}`);
  }

  close() {
    this.closedByUs = true;
    this.closeCbs.clear();
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
