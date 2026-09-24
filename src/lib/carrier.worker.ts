// RTCRtpScriptTransform worker for the DIRECT RTP carrier (see carrier.ts).
//
// side "send" (desktop host): access units posted from the page wait in `queue`;
// every encoded VP8 dummy frame takes all of them with it.
// side "recv" (phone/web/Quest): each VP8 frame is split; our records go back to
// the page (buffers transferred), the untouched VP8 frame continues to the decoder
// so the dummy stream never starves and never PLIs.
//
// Plain module worker: bundled by Vite from `new URL(..., import.meta.url)`, so it
// loads from 'self' under the apps' CSP (blob: workers would not).
import { type CarrierRecord, packCarrierFrame, unpackCarrierFrame } from "./carrier";

type EncodedFrame = { data: ArrayBuffer };
type Transformer = {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
  options?: { side?: string };
};
type WorkerScope = {
  onmessage: ((e: MessageEvent) => void) | null;
  onrtctransform: ((e: { transformer: Transformer }) => void) | null;
  postMessage: (m: unknown, transfer?: Transferable[]) => void;
};

const scope = self as unknown as WorkerScope;
/** Bound: if the carrier stalls, don't grow without limit — the phone sees the
 *  sequence gap and asks for a keyframe. */
const MAX_QUEUED = 120;
const queue: CarrierRecord[] = [];
let sent = 0;
let dropped = 0;

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: string; flags?: number; seq?: number; tsMs?: number; data?: ArrayBuffer };
  if (m?.type === "rec" && m.data) {
    queue.push({ flags: m.flags ?? 0, seq: m.seq ?? 0, tsMs: m.tsMs ?? 0, data: new Uint8Array(m.data) });
    while (queue.length > MAX_QUEUED) {
      queue.shift();
      dropped++;
    }
  } else if (m?.type === "clear") {
    queue.length = 0;
  } else if (m?.type === "stats") {
    scope.postMessage({ type: "stats", sent, dropped, queued: queue.length });
  }
};

scope.onrtctransform = (ev) => {
  const t = ev.transformer;
  if (t.options?.side === "send") {
    t.readable
      .pipeThrough(
        new TransformStream<EncodedFrame, EncodedFrame>({
          transform(frame, ctl) {
            if (queue.length) {
              const recs = queue.splice(0);
              sent += recs.length;
              frame.data = packCarrierFrame(new Uint8Array(frame.data), recs);
            }
            ctl.enqueue(frame);
          },
        }),
      )
      .pipeTo(t.writable)
      .catch(() => {});
    return;
  }
  t.readable
    .pipeThrough(
      new TransformStream<EncodedFrame, EncodedFrame>({
        transform(frame, ctl) {
          const got = unpackCarrierFrame(frame.data);
          if (got) {
            if (got.records.length) {
              const recs = got.records.map((r) => ({ flags: r.flags, seq: r.seq, tsMs: r.tsMs, data: r.data.buffer }));
              scope.postMessage({ type: "recs", recs, at: performance.now() }, recs.map((r) => r.data));
            }
            frame.data = frame.data.slice(0, got.vp8Len);
          }
          ctl.enqueue(frame);
        },
      }),
    )
    .pipeTo(t.writable)
    .catch(() => {});
};
