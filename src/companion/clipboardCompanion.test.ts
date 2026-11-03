import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), decrypt: vi.fn(), derive: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/clipboardCrypto", () => ({
  deriveKey: mocks.derive,
  clipId: async (secret: string) => `space-${secret}`,
  decryptText: mocks.decrypt,
  decryptBytes: async (_key: unknown, bytes: Uint8Array) => bytes,
  encryptText: async (_key: unknown, text: string) => text,
  encryptBytes: async (_key: unknown, bytes: Uint8Array) => bytes,
  b64ToBytes: () => new Uint8Array(),
}));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(public url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

let store: (typeof import("./clipboardCompanion"))["useCompanionClip"];
const flush = () => vi.advanceTimersByTimeAsync(60);
const note = (id: string, rev: number, extra = {}) => ({
  t: "item", itemId: id, rev, kind: "text", textCipher: id,
  createdUtc: new Date(rev * 1000).toISOString(), deviceId: "desktop", ...extra,
});
const openNotes = async () => {
  localStorage.setItem("gt.remote.secret", "test");
  await store.getState().init();
  const socket = Socket.instances[Socket.instances.length - 1]!;
  socket.open();
  return socket;
};

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  Socket.instances = [];
  mocks.invoke.mockReset().mockImplementation(async (command) => command === "clipboard_service_snapshot" ? "{}" : undefined);
  mocks.decrypt.mockReset().mockImplementation(async (_key, text) => text);
  mocks.derive.mockReset().mockResolvedValue({});
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn());
  URL.createObjectURL = vi.fn(() => "blob:test");
  URL.revokeObjectURL = vi.fn();
  store = (await import("./clipboardCompanion")).useCompanionClip;
});

afterEach(() => {
  store.getState().stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Notes are independent of remote control", () => {
  it("remote approval stores credentials without a socket, crypto or background enable", async () => {
    await store.getState().initializeBackground();
    await store.getState().setSecret("approved");
    expect(localStorage.getItem("gt.remote.secret")).toBe("approved");
    expect(Socket.instances).toHaveLength(0);
    expect(mocks.derive).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("clipboard_service_start", expect.objectContaining({ enabled: false }));
  });

  it("only an explicit background opt-in enables the service and off survives approvals", async () => {
    await store.getState().setSecret("test");
    await store.getState().setBackgroundEnabled(true);
    expect(mocks.invoke).toHaveBeenLastCalledWith("clipboard_service_start", expect.objectContaining({ enabled: true }));
    expect(Socket.instances).toHaveLength(0);
    await store.getState().setBackgroundEnabled(false);
    await store.getState().setSecret("test");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("clipboard_service_start", expect.objectContaining({ enabled: false }));
  });

  it("leaving Notes closes its socket and no timer/stale callback can revive it", async () => {
    const socket = await openNotes();
    store.getState().stop();
    socket.onopen?.();
    socket.onerror?.();
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(120000);
    expect(Socket.instances).toHaveLength(1);
    expect(store.getState().connected).toBe(false);
    expect(socket.sent).toEqual([{ t: "hello", since: 0 }]);
  });

  it("an async key derivation cannot connect after Notes is closed", async () => {
    let finish!: (key: object) => void;
    mocks.derive.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    localStorage.setItem("gt.remote.secret", "test");
    const start = store.getState().init();
    store.getState().stop();
    finish({});
    await start;
    expect(Socket.instances).toHaveLength(0);
  });
});

describe("bounded, incremental Notes sync", () => {
  it("loads full cold history but reconnects from the applied in-memory cursor", async () => {
    localStorage.setItem("gt.clip.rev.space-test", "9999");
    const first = await openNotes();
    expect(first.sent[0]).toEqual({ t: "hello", since: 0 });
    first.message(note("one", 12));
    first.message({ t: "synced", rev: 12 });
    await flush();
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const second = Socket.instances[1];
    second.open();
    expect(second.sent[0]).toEqual({ t: "hello", since: 12 });
    first.onclose?.(); // cancelled socket cannot clobber/reconnect the new one
    first.message(note("stale", 100));
    await vi.advanceTimersByTimeAsync(40000);
    expect(Socket.instances).toHaveLength(2);
    expect(store.getState().items.map((item) => item.id)).toEqual(["one"]);
    expect(store.getState().connected).toBe(true);
  });

  it("clears history/cursor on changed credentials and ignores late decrypts", async () => {
    const old = await openNotes();
    let finish!: (text: string) => void;
    mocks.decrypt.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    old.message(note("old-account", 50));
    await Promise.resolve();
    await store.getState().setSecret("new");
    const next = Socket.instances[1];
    next.open();
    finish("old data");
    await flush();
    expect(next.sent[0]).toEqual({ t: "hello", since: 0 });
    expect(store.getState().items).toEqual([]);
  });

  it("serializes decrypt before tombstone so delayed text cannot resurrect deleted notes", async () => {
    const socket = await openNotes();
    let finish!: (text: string) => void;
    mocks.decrypt.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    socket.message(note("deleted", 1));
    socket.message({ t: "item", itemId: "deleted", rev: 2, deleted: true });
    socket.message({ t: "synced", rev: 2 });
    await Promise.resolve();
    finish("data");
    await flush();
    expect(store.getState().items).toEqual([]);
    expect((await store.getState().diagnostics()).webview.lastRev).toBe(2);
  });

  it("syncing a large image history fetches zero blobs and bounds retained rows", async () => {
    const socket = await openNotes();
    for (let n = 1; n <= 1000; n++) socket.message(note(`image${n}`, n, { kind: "image", hasBlob: true }));
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.getState().items).toHaveLength(300);
    expect((await store.getState().diagnostics()).webview.retainedItems).toBe(300);
    expect(store.getState().items[0].id).toBe("image1000");
  });

  it("does not commit a partial history cursor before the replay-complete marker", async () => {
    const first = await openNotes();
    first.message(note("new-live", 100));
    first.message(note("old-replay", 2));
    await flush();
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    Socket.instances[1].open();
    expect(Socket.instances[1].sent[0]).toEqual({ t: "hello", since: 0 });
  });

  it("loads an image only on demand, dedupes requests, and aborts when hidden", async () => {
    const socket = await openNotes();
    socket.message(note("pic", 1, { kind: "image", hasBlob: true }));
    await flush();
    let finish!: (response: object) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve as any; }));
    const pending = store.getState().loadImage("pic");
    await store.getState().loadImage("pic");
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    store.getState().stop();
    expect(signal.aborted).toBe(true);
    finish({ ok: true, arrayBuffer: async () => new ArrayBuffer(10) });
    await pending;
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("bounds downloaded images to twelve and releases blob URLs on close", async () => {
    const socket = await openNotes();
    for (let n = 1; n <= 13; n++) socket.message(note(`pic${n}`, n, { kind: "image", hasBlob: true }));
    await flush();
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response));
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:${Math.random()}`);
    for (let n = 1; n <= 13; n++) await store.getState().loadImage(`pic${n}`);
    await flush();
    expect(store.getState().items.filter((item) => item.imagePath)).toHaveLength(12);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    store.getState().stop();
    await flush();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(13);
    expect(store.getState().items.every((item) => item.imagePath === null)).toBe(true);
  });
});

describe("nothing is lost while the relay link is down", () => {
  it("a note added offline is sent, in order, once the link is back", async () => {
    const first = await openNotes();
    first.message({ t: "synced", rev: 0 });
    await flush();
    first.close();
    await store.getState().addText("copied in a tunnel");
    await flush();
    await store.getState().togglePin(store.getState().items[0]!);
    expect(first.sent.filter((m) => m.t === "add")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    const second = Socket.instances[1]!;
    second.open();
    await flush();
    const sent = second.sent.map((m) => m.t);
    expect(sent.slice(0, 3)).toEqual(["hello", "add", "pin"]);
    expect(second.sent[1].item.textCipher).toBe("copied in a tunnel");
  });

  it("a queued note survives an app restart", async () => {
    const first = await openNotes();
    first.close();
    await store.getState().addText("before the restart");
    store.getState().stop();
    vi.resetModules();
    store = (await import("./clipboardCompanion")).useCompanionClip;
    const after = await openNotes();
    await flush();
    expect(after.sent.find((m) => m.t === "add")?.item.textCipher).toBe("before the restart");
  });

  it("an image whose upload failed is kept and its blob retried before the note", async () => {
    const put = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", put);
    const first = await openNotes();
    await store.getState().addImage("data:image/png;base64,AAAA");
    await flush();
    expect(store.getState().items).toHaveLength(1);
    expect(first.sent.filter((m) => m.t === "add")).toHaveLength(0);
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const second = Socket.instances[1]!;
    second.open();
    await flush();
    expect(put).toHaveBeenCalledTimes(2);
    expect(second.sent.find((m) => m.t === "add")?.item.hasBlob).toBe(true);
  });
});

describe("a relay that started a new store", () => {
  it("replays from zero when its head is below our cursor", async () => {
    const first = await openNotes();
    first.message(note("one", 40));
    first.message({ t: "synced", rev: 40 });
    await flush();
    first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const second = Socket.instances[1]!;
    second.open();
    expect(second.sent[0]).toEqual({ t: "hello", since: 40 });
    second.message({ t: "synced", rev: 40, head: 7 });
    await flush();
    expect(second.sent[1]).toEqual({ t: "hello", since: 0 });
    second.message(note("two", 7));
    second.message({ t: "synced", rev: 7, head: 7 });
    await flush();
    expect(store.getState().items.map((i) => i.id).sort()).toEqual(["one", "two"]);
  });

  it("replays from zero when a live note carries an older revision", async () => {
    const socket = await openNotes();
    socket.message(note("one", 40));
    socket.message({ t: "synced", rev: 40 });
    await flush();
    socket.message(note("fresh", 3));
    await flush();
    expect(socket.sent[socket.sent.length - 1]).toEqual({ t: "hello", since: 0 });
    expect(store.getState().items.map((i) => i.id)).toContain("fresh");
  });
});
