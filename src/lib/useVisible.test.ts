import { expect, it, vi } from "vitest";
import { installDesktopVisibility, isUiVisible, subscribeUiVisibility } from "./useVisible";

const native = vi.hoisted(() => {
  const callbacks: Record<string, () => void> = {};
  return {
    callbacks,
    isVisible: vi.fn(async () => true),
    isMinimized: vi.fn(async () => false),
    onFocusChanged: vi.fn(async (fn: () => void) => { callbacks.focus = fn; return () => {}; }),
    onResized: vi.fn(async (fn: () => void) => { callbacks.resize = fn; return () => {}; }),
    onCloseRequested: vi.fn(async (fn: () => void) => { callbacks.close = fn; return () => {}; }),
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));

it("handles tray hide, restore, minimization, stale native reads, and document hiding without polling", async () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const notify = vi.fn();
  const unsubscribe = subscribeUiVisibility(notify);
  try {
    await installDesktopVisibility();
    expect(isUiVisible()).toBe(true);
    native.callbacks.close();
    expect(isUiVisible()).toBe(false);
    expect(document.documentElement.dataset.uiVisible).toBe("false");

    native.callbacks.focus();
    await vi.waitFor(() => expect(isUiVisible()).toBe(true));
    native.isMinimized.mockResolvedValue(true);
    native.callbacks.resize();
    await vi.waitFor(() => expect(isUiVisible()).toBe(false));
    native.isMinimized.mockResolvedValue(false);
    native.callbacks.resize();
    await vi.waitFor(() => expect(isUiVisible()).toBe(true));

    let staleRead!: (shown: boolean) => void;
    native.isVisible.mockImplementationOnce(() => new Promise<boolean>(resolve => { staleRead = resolve; }));
    native.callbacks.focus();
    native.callbacks.close();
    staleRead(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(isUiVisible()).toBe(false);
    native.callbacks.focus();
    await vi.waitFor(() => expect(isUiVisible()).toBe(true));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(isUiVisible()).toBe(false);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(isUiVisible()).toBe(true);
  } finally {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    unsubscribe();
  }
  const previous = notify.mock.calls.length;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(notify).toHaveBeenCalledTimes(previous);
});
