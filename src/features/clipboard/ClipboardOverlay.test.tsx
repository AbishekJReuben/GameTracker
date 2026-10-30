import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ setPosition: 0, delay: 0 }));

vi.mock("@tauri-apps/api/window", () => {
  const later = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), calls.delay));
  const win = {
    outerPosition: () => later({ x: 100, y: 100 }),
    innerSize: () => later({ width: 95, height: 95 }),
    scaleFactor: () => later(1.25),
    setPosition: async () => { calls.setPosition++; },
    setSize: async () => {},
    setResizable: async () => {},
  };
  return { getCurrentWindow: () => win, currentMonitor: async () => null };
});
vi.mock("@tauri-apps/api/dpi", () => ({ LogicalSize: class {}, PhysicalPosition: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => ({}), convertFileSrc: (s: string) => s }));
vi.mock("@/store/clipboard", () => {
  const state = { refresh: async () => {}, load: async () => {}, sync: async () => {} };
  return { useClipboard: Object.assign(() => state, { getState: () => state }), visibleClips: () => ({ pinned: [], rest: [] }) };
});
vi.mock("./ClipboardPanel", () => ({ ClipboardPanel: () => <div data-testid="panel" /> }));
import ClipboardOverlay from "./ClipboardOverlay";

const pointer = (el: Element, type: string, x: number, buttons: number) => {
  const e = new MouseEvent(type, { bubbles: true, screenX: x, screenY: 300, button: 0, buttons });
  Object.defineProperties(e, { pointerId: { value: 1 } });
  fireEvent(el, e);
};

beforeEach(() => {
  calls.setPosition = 0;
  calls.delay = 0;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 4));
});

it("a click during a busy UI thread still opens the panel, and nothing sticks to the mouse", async () => {
  render(<ClipboardOverlay />);
  const bubble = await screen.findByTitle(/tap to open/i);
  calls.delay = 120;
  pointer(bubble, "pointerdown", 500, 1);
  pointer(bubble, "pointerup", 500, 0);
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  expect(screen.queryByTestId("panel")).not.toBeNull();
  expect(calls.setPosition).toBe(0);
});

it("a hover with no button held never moves the window", async () => {
  render(<ClipboardOverlay />);
  const bubble = await screen.findByTitle(/tap to open/i);
  pointer(bubble, "pointermove", 520, 0);
  pointer(bubble, "pointermove", 560, 0);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(calls.setPosition).toBe(0);
});
