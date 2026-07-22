/**
 * Browser-native, direct-first file sharing over the existing GameTracker
 * signaling service. The desktop webview is the WebRTC host; Rust only streams
 * selected file bytes into it. The receiver is an ordinary HTTPS browser page.
 */
import { api, type ShareManifest, type ShareItem } from "@/lib/api";
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
  peer: string | null;
  detail?: string;
}

export interface ShareHost {
  room: string;
  link: string;
  manifest: ShareManifest;
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
const CHUNK = 16 * 1024; // conservative across SCTP implementations
const HIGH_WATER = 1_000_000;
const LOW_WATER = 256_000;
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
    this.stats = { state: "connecting", route: "connecting", sentBytes: 0, receivedBytes: 0, totalBytes, speedBps: 0, rttMs: null, bufferedBytes: 0, etaSeconds: null, peer: null };
  }
  set(patch: Partial<ShareStats>) { this.stats = { ...this.stats, ...patch }; this.emit(); }
  addSent(bytes: number) { this.stats.sentBytes += bytes; this.emit(); }
  addReceived(bytes: number) { this.stats.receivedBytes += bytes; this.emit(); }
  onPong(sentAt: number) { this.set({ rttMs: Math.max(0, performance.now() - sentAt) }); }
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
  private emit() { this.onStats({ ...this.stats }); }
}

/** Start a share in the installed desktop app. */
export async function hostShare(
  paths: string[],
  options: { signalUrl?: string; onStats: (stats: ShareStats) => void; onManifest?: (manifest: ShareManifest) => void },
): Promise<ShareHost> {
  const manifest = await api.sharePrepare(paths);
  options.onManifest?.(manifest);
  const room = roomCode();
  const signalUrl = options.signalUrl || DEFAULT_SIGNAL_URL;
  const link = `${signalHttp(signalUrl)}/share#${room}`;
  let pc: RTCPeerConnection | null = null;
  let control: RTCDataChannel | null = null;
  let data: RTCDataChannel | null = null;
  let stopped = false;
  let sending = false;
  let accepted = false;
  const telemetry = new Telemetry(() => pc, manifest.totalBytes, options.onStats);
  const sig = new Signaling(signalUrl, room, "host");

  const fail = (message: string) => {
    telemetry.set({ state: "error", detail: message });
    jsonSend(control, { t: "error", message });
  };
  const transfer = async () => {
    if (sending || stopped || !data || data.readyState !== "open") return;
    sending = true;
    telemetry.set({ state: "transferring", peer: telemetry ? "Browser receiver" : null });
    try {
      for (const item of manifest.items) {
        for (let offset = 0; offset < item.size; offset += CHUNK) {
          if (stopped || data.readyState !== "open") return;
          if (data.bufferedAmount > HIGH_WATER) await waitForDrain(data);
          const bytes = await api.shareReadChunk(item.sourcePath, offset, Math.min(CHUNK, item.size - offset));
          const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          if (!payload.byteLength) throw new Error(`${item.path} ended unexpectedly.`);
          data.send(binaryFrame(item.id, offset, payload));
          telemetry.addSent(payload.byteLength);
        }
      }
      // Completion rides the SAME ordered data channel as the bytes. A control
      // message on a different SCTP stream can overtake a final file frame.
      data.send(binaryFrame(DONE_FRAME_ID, 0, new Uint8Array()));
      await waitForDrain(data);
      jsonSend(control, { t: "complete" });
      telemetry.set({ state: "complete" });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      sending = false;
    }
  };

  const makeOffer = async () => {
    if (stopped || pc) return;
    pc = new RTCPeerConnection({ iceServers: defaultIceServers(), iceCandidatePoolSize: 4 });
    pipeIce(pc, sig);
    pc.onconnectionstatechange = () => {
      const state = pc?.connectionState;
      if (state === "connected") telemetry.set({ state: "ready", route: "unknown" });
      else if (state === "failed") fail("Peer connection failed. Try copying a new link.");
      else if (state === "closed") telemetry.set({ state: "closed" });
    };
    control = pc.createDataChannel("share-control");
    data = pc.createDataChannel("share-data", { ordered: true });
    data.binaryType = "arraybuffer";
    data.onopen = () => { if (accepted) transfer(); };
    control.onopen = () => { telemetry.set({ state: "ready" }); jsonSend(control, { t: "manifest", manifest: publicManifest(manifest) }); };
    control.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as Control;
        if (msg.t === "accept") { accepted = true; transfer(); }
        else if (msg.t === "ping") jsonSend(control, { t: "pong", id: msg.id, sentAt: msg.sentAt });
        else if (msg.t === "pong") telemetry.onPong(msg.sentAt);
        else if (msg.t === "error") fail(msg.message);
      } catch { /* ignore malformed peer control */ }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig.send({ type: "offer", sdp: await gatheredLocalSdp(pc) });
  };

  sig.onMessage(async (message: SignalMsg) => {
    const msg = message as any;
    if (msg.type === "peer-joined" && msg.role === "guest") await makeOffer();
    else if (msg.type === "answer" && pc && msg.sdp) await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    else if (msg.type === "candidate" && pc && msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {});
    else if (msg.type === "peer-left") telemetry.set({ state: sending ? "connecting" : "waiting", peer: null });
  });
  sig.onClose(() => { if (!stopped) telemetry.set({ state: "error", detail: "Signaling connection closed." }); });
  await sig.connect();
  telemetry.set({ state: "waiting", route: "connecting" });
  telemetry.start(() => control, () => data);
  return {
    room, link, manifest,
    stop() { stopped = true; telemetry.stop(); telemetry.set({ state: "closed" }); data?.close(); control?.close(); pc?.close(); sig.close(); },
  };
}

type Destination =
  | { kind: "file"; writer: FileSystemWritableFileStream }
  | { kind: "directory"; root: FileSystemDirectoryHandle; writers: Map<number, FileSystemWritableFileStream> }
  | { kind: "memory"; chunks: Map<number, ArrayBuffer[]> };

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
  let stopped = false;
  let finished = false;
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
      } else if (msg.t === "ping") jsonSend(control, { t: "pong", id: msg.id, sentAt: msg.sentAt });
      else if (msg.t === "pong") telemetry.onPong(msg.sentAt);
      // A data-channel completion sentinel is authoritative: control and file
      // channels are independent SCTP streams, so this notice can arrive first.
      else if (msg.t === "complete") { /* await ordered data sentinel */ }
      else if (msg.t === "error") options.onError(msg.message);
    } catch { /* ignore malformed peer control */ }
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
      const payload = new Uint8Array(frame.bytes).buffer;
      await writer.write({ type: "write", position: frame.offset, data: payload });
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
        if (state === "failed") options.onError("Connection failed. Ask the sender to create a fresh link.");
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
      telemetry.set({ state: "transferring", peer: name || "GameTracker sender" });
      jsonSend(control, { t: "accept", name });
    },
    close() { stopped = true; telemetry.stop(); data?.close(); control?.close(); pc?.close(); sig.close(); },
  };
}

export function shareSignalUrl(signal = DEFAULT_SIGNAL_URL) { return signalHttp(signal); }
