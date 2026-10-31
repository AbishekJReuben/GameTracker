import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotesApp } from "./NotesApp";

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  invoked: [] as { command: string; args?: unknown }[],
  listening: Promise.resolve() as Promise<void>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    tauri.invoked.push({ command, args });
    return command === "notes_panel_config" ? { sttEnabled: false, draft: "", hotkey: "" } : null;
  },
  convertFileSrc: (path: string) => path,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
    await tauri.listening;
    tauri.handlers.set(name, handler);
    return () => {};
  },
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

vi.mock("@/lib/clip", async (original) => ({
  ...(await original<typeof import("@/lib/clip")>()),
  clip: {
    changes: async () => ({ rev: 0, reload: false, items: [] }),
    pinned: async () => [],
    list: async () => [],
    tags: async () => [],
  },
}));

let frames: FrameRequestCallback[] = [];

const nextFrame = () => {
  const due = frames;
  frames = [];
  due.forEach((frame) => frame(0));
};
const settle = () => act(() => new Promise<void>((done) => setTimeout(done, 5)));
const sent = (command: string) => tauri.invoked.filter((call) => call.command === command);
const fire = (name: string, payload?: unknown) => act(() => tauri.handlers.get(name)?.({ payload }));

beforeEach(() => {
  frames = [];
  tauri.handlers.clear();
  tauri.invoked.length = 0;
  tauri.listening = Promise.resolve();
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("says it's ready only once it can hear the answer", async () => {
  let listen = () => {};
  tauri.listening = new Promise((done) => (listen = done));
  render(<NotesApp />);
  await settle();
  expect(sent("notes_panel_ready")).toEqual([]);

  listen();
  await waitFor(() => expect(sent("notes_panel_ready")).toHaveLength(1));
});

it("answers a wake after a frame has been drawn, naming the open that asked", async () => {
  render(<NotesApp />);
  await waitFor(() => expect(tauri.handlers.has("notes://wake")).toBe(true));

  fire("notes://wake", 7);
  nextFrame();
  expect(sent("notes_panel_painted")).toEqual([]);

  nextFrame();
  expect(sent("notes_panel_painted")).toEqual([{ command: "notes_panel_painted", args: { id: 7 } }]);
});

it("waits for the reveal to take the search box", async () => {
  render(<NotesApp />);
  await waitFor(() => expect(tauri.handlers.has("notes://reveal")).toBe(true));
  const search = screen.getByPlaceholderText(/search/i);

  fire("notes://wake", 1);
  expect(search).not.toHaveFocus();

  fire("notes://reveal");
  expect(search).toHaveFocus();
});
