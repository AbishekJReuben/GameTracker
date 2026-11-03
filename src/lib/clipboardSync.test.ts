import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("./clipboardCrypto", () => ({
  deriveKey: async () => ({}),
  clipId: async () => "space",
  encryptText: async (_key: unknown, text: string) => text,
  decryptText: async (_key: unknown, text: string) => text,
  encryptBytes: async (_key: unknown, bytes: Uint8Array) => bytes,
  decryptBytes: async (_key: unknown, bytes: Uint8Array) => bytes,
  bytesToB64: () => "",
  b64ToBytes: () => new Uint8Array(4),
}));

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: Socket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onclose?: (ev: { code: number; reason: string }) => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(public url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: "" }); }
  message(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

type Row = { id: string; kind: "text" | "image"; text?: string; createdUtc: string; synced: boolean; b64?: string | null };
let rows: Row[] = [];
let known: string[] = [];
const ts = (n: number) => new Date(Date.UTC(2026, 10, 3, 0, 0, n)).toISOString();

const commands: Record<string, (args: any) => unknown> = {
  get_settings: () => ({ clipboard_enabled: "true", remote_secret_code: "s", remote_signal_url: "wss://relay.test" }),
  clipboard_device_info: () => ({ deviceId: "pc", deviceName: "PC" }),
  clipboard_unsynced: ({ limit, beforeUtc }) =>
    rows
      .filter((r) => !r.synced && (!beforeUtc || r.createdUtc < beforeUtc))
      .sort((a, b) => b.createdUtc.localeCompare(a.createdUtc))
      .slice(0, limit)
      .map((r) => ({ ...r, deviceId: "pc", pinned: false, tags: [], copies: [] })),
  clipboard_mark_synced: ({ id }) => { rows.find((r) => r.id === id)!.synced = true; },
  clipboard_image_b64: ({ id }) => rows.find((r) => r.id === id)?.b64 ?? null,
  clipboard_outbox_list: () => [],
  clipboard_known: ({ ids }) => ids.filter((id: string) => known.includes(id)),
  clipboard_add: () => ({}),
  clipboard_dedupe: () => undefined,
};

let clipSync: (typeof import("./clipboardSync"))["clipSync"];
const flush = () => vi.advanceTimersByTimeAsync(50);
const connect = async () => {
  await clipSync.start();
  const socket = Socket.instances.at(-1)!;
  socket.open();
  return socket;
};

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("gt.clip.deduped.v1.space", "1");
  Socket.instances = [];
  rows = [];
  known = [];
  mocks.invoke.mockReset().mockImplementation(async (cmd: string, args: any) => commands[cmd]?.(args ?? {}));
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) })));
  clipSync = (await import("./clipboardSync")).clipSync;
});

afterEach(() => {
  clipSync.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("upload backlog", () => {
  it("sends the newest copy even when 100 older items can't go", async () => {
    // 100 images whose files are gone, then today's text: the old engine fetched
    // the same 100 oldest items forever and never reached the text.
    for (let i = 0; i < 100; i++) rows.push({ id: `img${i}`, kind: "image", createdUtc: ts(i), synced: false, b64: null });
    rows.push({ id: "today", kind: "text", text: "newest", createdUtc: ts(500), synced: false });
    rows.push({ id: "older", kind: "text", text: "older", createdUtc: ts(-5), synced: false });
    const socket = await connect();
    socket.message({ t: "synced", rev: 0 });
    await flush();
    const adds = socket.sent.filter((m) => m.t === "add").map((m) => m.item.itemId);
    expect(adds).toEqual(["today", "older"]);
    const unsyncedCalls = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "clipboard_unsynced").length;
    expect(unsyncedCalls).toBeLessThanOrEqual(3);
    expect(clipSync.diagnostics().skippedUploads).toBe("100");
  });
});

describe("a relay that started a new store", () => {
  it("catches up from zero when the relay's head is below our cursor", async () => {
    localStorage.setItem("gt.clip.rev.space", "7496");
    const socket = await connect();
    expect(socket.sent[0]).toEqual({ t: "hello", since: 7496 });
    socket.message({ t: "synced", rev: 7496, head: 2719 });
    await flush();
    expect(socket.sent.at(-1)).toEqual({ t: "hello", since: 0 });
    expect(localStorage.getItem("gt.clip.rev.space")).toBe("0");
  });

  it("catches up from zero when a live item carries an older revision", async () => {
    localStorage.setItem("gt.clip.rev.space", "7496");
    const socket = await connect();
    socket.message({ t: "synced", rev: 7496 });
    await flush();
    socket.message({ t: "item", itemId: "x", rev: 2720, kind: "text", textCipher: "hi", deviceId: "phone" });
    await flush();
    expect(socket.sent.some((m) => m.t === "hello" && m.since === 0)).toBe(true);
    expect(mocks.invoke.mock.calls.some(([cmd, a]) => cmd === "clipboard_add" && a.input.id === "x")).toBe(true);
  });

  it("doesn't download images it already has during the catch-up", async () => {
    known = ["have"];
    const socket = await connect();
    socket.message({ t: "item", itemId: "have", rev: 1, kind: "image", hasBlob: true, deviceId: "phone" });
    socket.message({ t: "item", itemId: "new", rev: 2, kind: "image", hasBlob: true, deviceId: "phone" });
    await flush();
    const blobGets = (fetch as any).mock.calls.filter(([url]: [string]) => url.includes("/clip/blob/"));
    expect(blobGets.map(([url]: [string]) => url.split("/").pop())).toEqual(["new"]);
  });
});

describe("fitImage", () => {
  it("passes images under the relay's limit through untouched", async () => {
    const { fitImage } = await import("./clipboardSync");
    const raw = new Uint8Array(1024);
    expect(await fitImage(raw, "image/png")).toEqual({ bytes: raw, mime: "image/png" });
  });

  it("gives up (rather than looping) when an oversized image can't be re-encoded", async () => {
    const { fitImage, MAX_BLOB } = await import("./clipboardSync");
    vi.stubGlobal("OffscreenCanvas", undefined);
    expect(await fitImage(new Uint8Array(MAX_BLOB + 1), "image/png")).toBeNull();
  });
});
