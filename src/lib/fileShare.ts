/**
 * Browser-native, direct-first file sharing over the existing GameTracker
 * signaling service. The desktop webview is the WebRTC host; Rust only streams
 * selected file bytes into it. The receiver is an ordinary HTTPS browser page.
 */
import { api, type SavedShare, type ShareDownloadSession, type ShareManifest, type ShareItem } from "@/lib/api";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { Signaling, defaultIceServers, gatheredLocalSdp, pipeIce, type SignalMsg } from "@/lib/rtc";

export type ShareRoute = "direct" | "relayed" | "connecting" | "unknown";
export type ShareState = "waiting" | "connecting" | "ready" | "transferring" | "complete" | "error" | "closed";

export interface ShareStats {
  state: ShareState;
  route: ShareRoute;
  sentBytes: number;
  receivedBytes: number;
  totalBytes: number;
  speedBps: number;
  rttMs: number | null;
  bufferedBytes: number;
  etaSeconds: number | null;
  peakSpeedBps: number;
  peer: string | null;
  detail?: string;
}

export interface ShareHost {
  room: string;
  link: string;
  manifest: ShareManifest;
  saved: SavedShare;
  /** A compact, user-copyable trace without receiver-private information. */
  logs(): string;
  stop(): void;
}

type Control =
  | { t: "manifest"; manifest: PublicManifest }
  | { t: "accept"; name?: string }
  | { t: "complete" }
  | { t: "ping"; id: number; sentAt: number }
  | { t: "pong"; id: number; sentAt: number }
  | { t: "error"; message: string };

export interface PublicItem { id: number; path: string; size: number; modifiedMs?: number | null }
export interface PublicManifest { items: PublicItem[]; totalBytes: number }

const HEADER = 16;
// WebRTC SCTP messages must stay below the conservative 64 KiB interoperability
// boundary.  Disk reads, however, cross the Tauri IPC boundary, where doing a
// request for every tiny WebRTC message was the dominant speed limit.  Read a
// full MiB at a time, then split it into independently safe SCTP frames.
const FRAME_PAYLOAD = 60 * 1024;
const READ_BATCH = 1024 * 1024;
const READ_AHEAD = 8;
const WRITE_BATCH = 1024 * 1024;
// Browser data-channel queue limits vary sharply (and are much smaller on
// mobile Chromium). Keep a conservative window and explicitly account for the
// next frame before enqueuing it; this prevents a full queue from aborting a
// live transfer.
const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;
const DONE_FRAME_ID = 0xffff_ffff;

function roomCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return [...b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function signalHttp(signal = DEFAULT_SIGNAL_URL): string {
  return signal.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:").replace(/\/+$/, "");
}

function publicManifest(manifest: ShareManifest): PublicManifest {
  return {
    totalBytes: manifest.totalBytes,
    items: manifest.items.map(({ id, path, size, modifiedMs }) => ({ id, path, size, modifiedMs })),
  };
}

function jsonSend(ch: RTCDataChannel | null, message: Control) {
  if (ch?.readyState === "open") ch.send(JSON.stringify(message));
}

function waitForDrain(ch: RTCDataChannel): Promise<void> {
  if (ch.bufferedAmount <= LOW_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    ch.bufferedAmountLowThreshold = LOW_WATER;
    const done = () => {
      ch.removeEventListener("bufferedamountlow", done);
      resolve();
    };
    ch.addEventListener("bufferedamountlow", done, { once: true });
  });
}

async function sendFrame(ch: RTCDataChannel, frame: ArrayBuffer) {
  // `bufferedAmount` can lag the internal SCTP queue by one event loop. The
  // retry catches that race, waits briefly, and then continues the same file.
  while (ch.readyState === "open") {
    if (ch.bufferedAmount + frame.byteLength > HIGH_WATER) {
      await waitForDrain(ch);
      continue;
    }
    try {
      ch.send(frame);
      return;
    } catch (error) {
      if (!(error instanceof DOMException) || !/queue is full/i.test(error.message)) throw error;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
    }
  }
  throw new Error("Receiver disconnected while sending.");
}

function binaryFrame(itemId: number, offset: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(HEADER + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, itemId, false);
  view.setBigUint64(4, BigInt(offset), false);
  view.setUint32(12, payload.byteLength, false);
  out.set(payload, HEADER);
  return out.buffer;
}

function parseFrame(raw: ArrayBuffer): { id: number; offset: number; bytes: Uint8Array } | null {
  if (raw.byteLength < HEADER) return null;
  const view = new DataView(raw);
  const length = view.getUint32(12, false);
  if (length !== raw.byteLength - HEADER) return null;
  const offset = Number(view.getBigUint64(4, false));
  if (!Number.isSafeInteger(offset)) return null;
  return { id: view.getUint32(0, false), offset, bytes: new Uint8Array(raw, HEADER, length) };
}

class Telemetry {
  private stats: ShareStats;
  private timer: number | null = null;
  private lastAt = performance.now();
  private lastBytes = 0;
  private pingId = 0;
  constructor(private pc: () => RTCPeerConnection | null, totalBytes: number, private onStats: (s: ShareStats) => void) {
    this.stats = { state: "connecting", route: "connecting", sentBytes: 0, receivedBytes: 0, totalBytes, speedBps: 0, peakSpeedBps: 0, rttMs: null, bufferedBytes: 0, etaSeconds: null, peer: null };
  }
  set(patch: Partial<ShareStats>) { this.stats = { ...this.stats, ...patch }; this.emit(); }
  addSent(bytes: number) { this.stats.sentBytes += bytes; this.emit(); }
  addReceived(bytes: number) { this.stats.receivedBytes += bytes; this.emit(); }
  // File bytes can delay a control-channel pong behind SCTP's shared queue.
  // The selected ICE candidate-pair RTT collected below is the real network RTT.
  onPong(_sentAt: number) { /* getStats() owns rttMs */ }
  start(control: () => RTCDataChannel | null, data: () => RTCDataChannel | null) {
    this.timer = window.setInterval(async () => {
      const now = performance.now();
      const moved = this.stats.sentBytes + this.stats.receivedBytes;
      const elapsed = Math.max(0.001, (now - this.lastAt) / 1000);
      const speedBps = Math.max(0, (moved - this.lastBytes) / elapsed);
      this.lastAt = now;
      this.lastBytes = moved;
      const done = Math.max(this.stats.sentBytes, this.stats.receivedBytes);
      this.stats.speedBps = speedBps;
      this.stats.peakSpeedBps = Math.max(this.stats.peakSpeedBps, speedBps);
      this.stats.bufferedBytes = data()?.bufferedAmount ?? 0;
      this.stats.etaSeconds = speedBps > 0 ? Math.max(0, (this.stats.totalBytes - done) / speedBps) : null;
      jsonSend(control(), { t: "ping", id: ++this.pingId, sentAt: now });
      const pc = this.pc();
      if (pc) {
        try {
          const reports = await pc.getStats();
          reports.forEach((r) => {
            if (r.type !== "candidate-pair" || !r.nominated && !r.selected) return;
            const local = reports.get(r.localCandidateId) as any;
            const remote = reports.get(r.remoteCandidateId) as any;
            const relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
            this.stats.route = relay ? "relayed" : "direct";
            if (typeof r.currentRoundTripTime === "number") this.stats.rttMs = r.currentRoundTripTime * 1000;
          });
        } catch { /* transient browser stats failure */ }
      }
      this.emit();
    }, 1000);
  }
  stop() { if (this.timer !== null) window.clearInterval(this.timer); this.timer = null; }
  snapshot() { return { ...this.stats }; }
  private emit() { this.onStats({ ...this.stats }); }
}

/** Start a share in the installed desktop app. */
export async function hostShare(
  paths: string[],
  options: { signalUrl?: string; onStats: (stats: ShareStats) => void; onManifest?: (manifest: ShareManifest) => void },
): Promise<ShareHost> {
  const room = roomCode();
  const saved = await api.shareCreate(room, paths);
  return hostSavedShare(saved, options);
}

/** Re-open a saved link after app navigation or an app restart. */
export async function hostSavedShare(
  saved: SavedShare,
  options: { signalUrl?: string; onStats: (stats: ShareStats) => void; onManifest?: (manifest: ShareManifest) => void },
): Promise<ShareHost> {
  const manifest = saved.manifest;
  options.onManifest?.(manifest);
  const room = saved.room;
  const signalUrl = options.signalUrl || DEFAULT_SIGNAL_URL;
  const link = `${signalHttp(signalUrl)}/share#${room}`;
  let pc: RTCPeerConnection | null = null;
  let control: RTCDataChannel | null = null;
  let data: RTCDataChannel | null = null;
  let stopped = false;
  let sending = false;
  let accepted = false;
  let negotiating = false;
  let audit: ShareDownloadSession | null = null;
  const events: string[] = [];
  const log = (message: string) => {
    events.push(`${new Date().toISOString()} ${message}`);
    if (events.length > 80) events.shift();
  };
  const telemetry = new Telemetry(() => pc, manifest.totalBytes, options.onStats);
  const sig = new Signaling(signalUrl, room, "host");

  const fail = (message: string) => {
    log(`error: ${message}`);
    telemetry.set({ state: "error", detail: message });
    jsonSend(control, { t: "error", message });
    void finishAudit("failed", message);
  };
  const finishAudit = async (state: string, error?: string) => {
    if (!audit) return;
    const snapshot = telemetry.snapshot();
    const ended = {
      ...audit, endedUtc: new Date().toISOString(), state, route: snapshot.route,
      bytesTransferred: Math.min(snapshot.sentBytes, Number.MAX_SAFE_INTEGER),
      averageSpeedBps: snapshot.speedBps, peakSpeedBps: snapshot.peakSpeedBps,
      rttMs: snapshot.rttMs, error: error || null,
    };
    audit = null;
    await api.shareSessionFinish(ended).catch(() => {});
  };
  const beginAudit = async (peerName?: string) => {
    await finishAudit("interrupted", "A newer receiver replaced this session.");
    try {
      audit = await api.shareSessionStart(saved.id, peerName, manifest.totalBytes);
      log(`download accepted${peerName ? ` by ${peerName}` : ""}`);
    } catch (error) { log(`audit start failed: ${String(error)}`); }
  };
  const releasePeer = () => {
    const oldData = data;
    const oldControl = control;
    const oldPc = pc;
    // Clear references before closing: stale close events must not tear down a
    // new receiver session that is using this same reusable link.
    data = null;
    control = null;
    pc = null;
    accepted = false;
    sending = false;
    oldData?.close();
    oldControl?.close();
    oldPc?.close();
  };
  const transfer = async () => {
    const channel = data;
    if (sending || stopped || !channel || channel.readyState !== "open") return;
    sending = true;
    telemetry.set({ state: "transferring", peer: telemetry ? "Browser receiver" : null });
    try {
      for (const item of manifest.items) {
        // Keep several independent Tauri reads in flight. Each call opens and
        // seeks a file independently, so an SSD can satisfy them concurrently;
        // we still send in offset order to preserve the simple receiver format.
        const reads = new Map<number, Promise<Uint8Array>>();
        let nextOffset = 0;
        const prefetch = () => {
          while (reads.size < READ_AHEAD && nextOffset < item.size) {
            const offset = nextOffset;
            nextOffset += READ_BATCH;
            reads.set(offset, api.shareReadChunk(item.sourcePath, offset, Math.min(READ_BATCH, item.size - offset))
              .then((bytes) => bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
          }
        };
        prefetch();
        for (let batchOffset = 0; batchOffset < item.size; batchOffset += READ_BATCH) {
          if (stopped || channel.readyState !== "open") return;
          // One IPC call per MiB rather than one per 16 KiB eliminates thousands
          // of command serializations on a typical video transfer.
          const pending = reads.get(batchOffset);
          if (!pending) throw new Error("Share read-ahead lost its place.");
          const payload = await pending;
          reads.delete(batchOffset);
          prefetch();
          if (!payload.byteLength) throw new Error(`${item.path} ended unexpectedly.`);
          for (let start = 0; start < payload.byteLength; start += FRAME_PAYLOAD) {
            if (stopped || channel.readyState !== "open") return;
            const frame = payload.subarray(start, Math.min(start + FRAME_PAYLOAD, payload.byteLength));
            await sendFrame(channel, binaryFrame(item.id, batchOffset + start, frame));
            telemetry.addSent(frame.byteLength);
          }
        }
      }
      // Completion rides the SAME ordered data channel as the bytes. A control
      // message on a different SCTP stream can overtake a final file frame.
      await sendFrame(channel, binaryFrame(DONE_FRAME_ID, 0, new Uint8Array()));
      await waitForDrain(channel);
      jsonSend(control, { t: "complete" });
      telemetry.set({ state: "complete" });
      log(`completed ${manifest.items.length} item(s), ${manifest.totalBytes} bytes`);
      await finishAudit("complete");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      sending = false;
    }
  };

  const makeOffer = async (replace = false) => {
    if (stopped) return;
    // A join notice and guest `ready` intentionally arrive together. Without a
    // gate they race two offers, and an answer to the first closed connection
    // gets applied to the second one (both sides remain "connecting").
    if (negotiating) return;
    negotiating = true;
    try {
    // A second browser joins using the same permanent link. It may replace a
    // completed page before the server observes peer-left, so always discard
    // the old peer for an explicit new guest rather than silently refusing it.
    if (!replace && pc && pc.connectionState !== "closed" && pc.connectionState !== "failed") return;
    if (pc) releasePeer();
    const connection = new RTCPeerConnection({ iceServers: defaultIceServers(), iceCandidatePoolSize: 4 });
    pc = connection;
    pipeIce(connection, sig);
    connection.onconnectionstatechange = () => {
      if (pc !== connection) return;
      const state = connection.connectionState;
      if (state === "connected") telemetry.set({ state: "ready", route: "unknown" });
      else if (state === "failed") fail("Peer connection failed. Try copying a new link.");
      else if (state === "closed") telemetry.set({ state: "waiting", peer: null });
    };
    control = connection.createDataChannel("share-control");
    data = connection.createDataChannel("share-data", { ordered: true });
    data.binaryType = "arraybuffer";
    data.onopen = () => { if (accepted) transfer(); };
    control.onopen = () => { telemetry.set({ state: "ready" }); jsonSend(control, { t: "manifest", manifest: publicManifest(manifest) }); };
    control.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Control;
        if (msg.t === "accept") {
          accepted = true;
          void (async () => { await beginAudit(msg.name); await transfer(); })();
        }
        else if (msg.t === "ping") jsonSend(control, { t: "pong", id: msg.id, sentAt: msg.sentAt });
        else if (msg.t === "pong") telemetry.onPong(msg.sentAt);
        else if (msg.t === "error") fail(msg.message);
      } catch { /* ignore malformed peer control */ }
    };
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    sig.send({ type: "offer", sdp: await gatheredLocalSdp(connection) });
    } finally {
      negotiating = false;
    }
  };

  sig.onMessage(async (message: SignalMsg) => {
    const msg = message as any;
    if (msg.type === "peer-joined" && msg.role === "guest") { log("receiver joined"); await makeOffer(true); }
    // `peer-joined` is the authoritative first-offer trigger. `ready` only
    // fills the rare reconnect gap where the host has no current connection.
    else if (msg.type === "ready" && !pc) { log("receiver requested a fresh offer"); await makeOffer(); }
    else if (msg.type === "answer" && pc && msg.sdp) await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    else if (msg.type === "candidate" && pc && msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {});
    else if (msg.type === "peer-left") {
      void finishAudit("interrupted", "Receiver closed the download page.");
      releasePeer();
      telemetry.set({ state: "waiting", route: "connecting", peer: null });
    }
  });
  sig.onClose(() => { if (!stopped) telemetry.set({ state: "error", detail: "Signaling connection closed." }); });
  await sig.connect();
  telemetry.set({ state: "waiting", route: "connecting" });
  telemetry.start(() => control, () => data);
  return {
    room, link, manifest, saved,
    logs() { return ["GameTracker Share sender diagnostics", `share=${saved.id}`, `room=${room}`, `signal=${signalUrl}`, ...events, `state=${JSON.stringify(telemetry.snapshot())}`].join("\n"); },
    stop() { stopped = true; void finishAudit("cancelled", "Sender revoked or stopped this share."); telemetry.stop(); telemetry.set({ state: "closed" }); releasePeer(); sig.close(); },
  };
}

type Destination =
  | { kind: "file"; writer: FileSystemWritableFileStream }
  | { kind: "directory"; root: FileSystemDirectoryHandle; writers: Map<number, FileSystemWritableFileStream> }
  | { kind: "memory"; chunks: Map<number, ArrayBuffer[]> };

type PendingWrite = {
  item: PublicItem;
  writer: FileSystemWritableFileStream;
  offset: number;
  chunks: Uint8Array[];
  bytes: number;
};

async function chooseDestination(manifest: PublicManifest): Promise<Destination> {
  const anyWindow = window as any;
  if (manifest.items.length === 1 && typeof anyWindow.showSaveFilePicker === "function") {
    const parts = manifest.items[0].path.split("/");
    const h = await anyWindow.showSaveFilePicker({ suggestedName: parts[parts.length - 1] });
    return { kind: "file", writer: await h.createWritable() };
  }
  if (manifest.items.length > 1 && typeof anyWindow.showDirectoryPicker === "function") {
    const root = await anyWindow.showDirectoryPicker({ mode: "readwrite" });
    return { kind: "directory", root, writers: new Map() };
  }
  return { kind: "memory", chunks: new Map() };
}

async function writerFor(destination: Destination, item: PublicItem): Promise<FileSystemWritableFileStream | null> {
  if (destination.kind === "file") return destination.writer;
  if (destination.kind !== "directory") return null;
  const existing = destination.writers.get(item.id);
  if (existing) return existing;
  const parts = item.path.split("/").filter(Boolean);
  const name = parts.pop() || "download";
  let dir = destination.root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  destination.writers.set(item.id, writer);
  return writer;
}

/** Join a link from a normal browser. Returns an imperative receiver session. */
export async function joinShare(
  room: string,
  options: { signalUrl?: string; onStats: (stats: ShareStats) => void; onManifest: (manifest: PublicManifest) => void; onReady: () => void; onDone: (fallback: boolean) => void; onError: (message: string) => void },
) {
  const signalUrl = options.signalUrl || DEFAULT_SIGNAL_URL;
  let pc: RTCPeerConnection | null = null;
  let control: RTCDataChannel | null = null;
  let data: RTCDataChannel | null = null;
  let manifest: PublicManifest | null = null;
  let destination: Destination | null = null;
  let writeChain = Promise.resolve();
  const pendingWrites = new Map<number, PendingWrite>();
  let stopped = false;
  let finished = false;
  const events: string[] = [];
  const log = (message: string) => {
    events.push(`${new Date().toISOString()} ${message}`);
    if (events.length > 80) events.shift();
  };
  const telemetry = new Telemetry(() => pc, 0, options.onStats);
  const sig = new Signaling(signalUrl, room, "guest");

  const onControl = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(String(event.data)) as Control;
      if (msg.t === "manifest") {
        manifest = msg.manifest;
        telemetry.set({ totalBytes: manifest.totalBytes, state: "ready" });
        options.onManifest(manifest);
        options.onReady();
        log(`manifest received: ${manifest.items.length} item(s), ${manifest.totalBytes} bytes`);
      } else if (msg.t === "ping") jsonSend(control, { t: "pong", id: msg.id, sentAt: msg.sentAt });
      else if (msg.t === "pong") telemetry.onPong(msg.sentAt);
      // A data-channel completion sentinel is authoritative: control and file
      // channels are independent SCTP streams, so this notice can arrive first.
      else if (msg.t === "complete") { /* await ordered data sentinel */ }
      else if (msg.t === "error") { log(`sender error: ${msg.message}`); options.onError(msg.message); }
    } catch { /* ignore malformed peer control */ }
  };
  const flushWrite = async (pending: PendingWrite) => {
    if (!pending.bytes) return;
    const payload = new Uint8Array(pending.bytes);
    let at = 0;
    for (const chunk of pending.chunks) { payload.set(chunk, at); at += chunk.byteLength; }
    await pending.writer.write({ type: "write", position: pending.offset, data: payload.buffer });
    pending.offset += pending.bytes;
    pending.bytes = 0;
    pending.chunks = [];
  };
  const flushAllWrites = async () => {
    for (const pending of pendingWrites.values()) await flushWrite(pending);
  };
  const writeFrame = async (raw: ArrayBuffer) => {
    const frame = parseFrame(raw);
    if (!frame || !manifest || !destination) return;
    // This callback is itself the tail of `writeChain`, so waiting for that
    // promise here would await itself forever. The ordered channel guarantees
    // every preceding write has already settled before this marker runs.
    if (frame.id === DONE_FRAME_ID) { await finish(true); return; }
    const item = manifest.items.find((v) => v.id === frame.id);
    if (!item || frame.offset + frame.bytes.byteLength > item.size) throw new Error("Received an invalid file chunk.");
    const writer = await writerFor(destination, item);
    if (writer) {
      let pending = pendingWrites.get(item.id);
      // A new file or unexpected position is a hard boundary. Flush first so
      // every byte keeps its exact source offset, then start the new batch.
      if (pending && frame.offset !== pending.offset + pending.bytes) {
        await flushWrite(pending);
        pending = undefined;
      }
      if (!pending) {
        pending = { item, writer, offset: frame.offset, chunks: [], bytes: 0 };
        pendingWrites.set(item.id, pending);
      }
      pending.chunks.push(frame.bytes);
      pending.bytes += frame.bytes.byteLength;
      if (pending.bytes >= WRITE_BATCH) await flushWrite(pending);
    }
    else if (destination.kind === "memory") {
      const chunks = destination.chunks.get(item.id) || [];
      chunks.push(new Uint8Array(frame.bytes).buffer);
      destination.chunks.set(item.id, chunks);
    }
    telemetry.addReceived(frame.bytes.byteLength);
  };
  const finish = async (afterOrderedMarker = false) => {
    if (finished) return;
    finished = true;
    if (!afterOrderedMarker) await writeChain;
    if (!manifest || !destination) return;
    await flushAllWrites();
    if (destination.kind === "file") await destination.writer.close();
    else if (destination.kind === "directory") await Promise.all([...destination.writers.values()].map((v) => v.close()));
    else {
      for (const item of manifest.items) {
        const blob = new Blob(destination.chunks.get(item.id) || [], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const parts = item.path.split("/");
        const a = document.createElement("a"); a.href = url; a.download = parts[parts.length - 1] || "download"; a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    }
    telemetry.set({ state: "complete" });
    log("download completed");
    options.onDone(destination.kind === "memory");
  };

  sig.onMessage(async (message: SignalMsg) => {
    const msg = message as any;
    if (msg.type === "offer") {
      pc?.close();
      pc = new RTCPeerConnection({ iceServers: defaultIceServers(), iceCandidatePoolSize: 4 });
      pipeIce(pc, sig);
      pc.onconnectionstatechange = () => {
        const state = pc?.connectionState;
        if (state === "connected") telemetry.set({ route: "unknown", state: "connecting" });
        if (state === "failed") { log("peer connection failed"); options.onError("Connection failed. Ask the sender to check the share diagnostics."); }
      };
      pc.ondatachannel = (event) => {
        if (event.channel.label === "share-control") { control = event.channel; control.onmessage = onControl; }
        if (event.channel.label === "share-data") {
          data = event.channel; data.binaryType = "arraybuffer";
          data.onmessage = (ev) => { writeChain = writeChain.then(() => writeFrame(ev.data as ArrayBuffer)).catch((e) => { options.onError(String(e)); jsonSend(control, { t: "error", message: String(e) }); }); };
        }
      };
      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sig.send({ type: "answer", sdp: await gatheredLocalSdp(pc) });
    } else if (msg.type === "candidate" && pc && msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {});
  });
  sig.onClose(() => { if (!stopped) options.onError("Signaling connection closed."); });
  await sig.connect();
  sig.send({ type: "ready", nonce: crypto.randomUUID() });
  telemetry.start(() => control, () => data);

  return {
    async accept(name?: string) {
      if (!manifest || !control || control.readyState !== "open") throw new Error("Waiting for sender manifest.");
      destination = await chooseDestination(manifest);
      log(`destination selected: ${destination.kind}`);
      telemetry.set({ state: "transferring", peer: name || "GameTracker sender" });
      jsonSend(control, { t: "accept", name });
    },
    logs() { return ["GameTracker Share receiver diagnostics", `room=${room}`, `signal=${signalUrl}`, ...events, `state=${JSON.stringify(telemetry.snapshot())}`].join("\n"); },
    close() { stopped = true; telemetry.stop(); data?.close(); control?.close(); pc?.close(); sig.close(); },
  };
}

export function shareSignalUrl(signal = DEFAULT_SIGNAL_URL) { return signalHttp(signal); }
