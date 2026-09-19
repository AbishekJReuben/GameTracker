/** Ordered DIRECT wire. Retain a single fragment without copying; allocate only
 * when an access unit actually spans messages. Never decode a truncated unit. */
export type VideoHeader = { key: boolean; seq: number; tsMs: number; len: number };
export const MAX_VIDEO_BYTES = 16_000_000;

export class VideoAssembler {
  private head: VideoHeader | null = null;
  private buffer: Uint8Array | null = null;
  private received = 0;
  private sequence: number | null = null;

  constructor(private readonly discontinuity: () => void) {}

  reset() {
    this.head = null;
    this.buffer = null;
    this.received = 0;
    this.sequence = null;
  }

  push(data: ArrayBuffer): { head: VideoHeader; bytes: Uint8Array<ArrayBuffer> } | null {
    // A sender can fail after the header or halfway through the payload. A new
    // header must discard that partial AU, not become 20 bytes of H.264 garbage.
    if (data.byteLength === 20) {
      const v = new DataView(data);
      if (v.getUint8(0) === 0x47 && v.getUint8(1) === 0x56 && v.getUint8(3) === 0) {
        const len = v.getUint32(16, true);
        const tsMs = v.getFloat64(8, true);
        if (this.head) this.discontinuity();
        this.head = null;
        this.buffer = null;
        this.received = 0;
        if (!len || len > MAX_VIDEO_BYTES || !Number.isFinite(tsMs) || tsMs < 0) {
          this.discontinuity();
          return null;
        }
        const seq = v.getUint32(4, true);
        if (this.sequence !== null && seq !== ((this.sequence + 1) >>> 0)) this.discontinuity();
        this.head = { key: (v.getUint8(2) & 1) !== 0, seq, tsMs, len };
        return null;
      }
    }
    const head = this.head;
    if (!head) return null;
    if (!data.byteLength || data.byteLength > head.len - this.received) {
      this.reset();
      this.discontinuity();
      return null;
    }
    const chunk = new Uint8Array(data);
    if (this.received === 0 && chunk.length === head.len) {
      this.head = null;
      this.sequence = head.seq;
      return { head, bytes: chunk };
    }
    this.buffer ??= new Uint8Array(head.len);
    this.buffer.set(chunk, this.received);
    this.received += chunk.length;
    if (this.received !== head.len) return null;
    const bytes = this.buffer as Uint8Array<ArrayBuffer>;
    this.head = null;
    this.buffer = null;
    this.received = 0;
    this.sequence = head.seq;
    return { head, bytes };
  }
}

/** decodeQueueSize alone excludes work already inside the platform codec. Keep
 * an input-to-output budget too, or a busy hardware decoder can hide a backlog. */
export function decodeOverloaded(queued: number, pending: number, oldestAgeMs: number) {
  return queued >= 4 || pending >= 6 || (pending > 0 && oldestAgeMs > 150);
}

/** Binary WebView bridge header: GD, version, key, timestamp-us f64, length u32,
 * session u32. The session rejects IPC messages delayed across a reconnect.
 * One bounded copy replaces byte->string->base64->Java string->base64 decode. */
export function nativeVideoPacket(tsUs: number, key: boolean, bytes: Uint8Array, session = 0): ArrayBuffer {
  const packet = new Uint8Array(20 + bytes.byteLength);
  const v = new DataView(packet.buffer);
  v.setUint8(0, 0x47);
  v.setUint8(1, 0x44);
  v.setUint8(2, 2);
  v.setUint8(3, key ? 1 : 0);
  v.setFloat64(4, tsUs, true);
  v.setUint32(12, bytes.byteLength, true);
  v.setUint32(16, session, true);
  packet.set(bytes, 20);
  return packet.buffer;
}
