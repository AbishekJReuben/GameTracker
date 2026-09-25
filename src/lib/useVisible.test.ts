import { expect, it, vi } from "vitest";
import { installDesktopVisibility, isUiVisible, subscribeUiVisibility } from "./useVisible";
import frameGateSource from "../../public/frame-gate.js?raw";

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

it("pauses script animations while hidden and resumes only the ones it paused", async () => {
  vi.useFakeTimers();
  const make = (extra: Record<string, unknown> = {}, state: AnimationPlayState = "running") => {
    const a = { playState: state, ...extra } as { playState: AnimationPlayState; pause: () => void; play: () => void };
    a.pause = vi.fn(() => { a.playState = "paused"; });
    a.play = vi.fn(() => { a.playState = "running"; });
    return a;
  };
  const motion = make();
  const css = make({ animationName: "gt-marquee" });
  const transition = make({ transitionProperty: "opacity" });
  const userPaused = make({}, "paused");
  const animations: unknown[] = [motion, css, transition, userPaused];
  Object.defineProperty(document, "getAnimations", { configurable: true, value: () => animations });
  const unsubscribe = subscribeUiVisibility(() => {});
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(motion.pause).toHaveBeenCalledOnce();
    expect(css.pause).not.toHaveBeenCalled();
    expect(transition.pause).not.toHaveBeenCalled();

    // Mounted while hidden: caught by the next sweep.
    const late = make();
    animations.push(late);
    vi.advanceTimersByTime(5_000);
    expect(late.pause).toHaveBeenCalledOnce();
    // Cancelled by Motion while hidden: not revived.
    late.playState = "idle";

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(motion.play).toHaveBeenCalledOnce();
    expect(late.play).not.toHaveBeenCalled();
    expect(userPaused.play).not.toHaveBeenCalled();

    // No sweeping while visible.
    animations.push(make());
    vi.advanceTimersByTime(20_000);
    expect((animations[animations.length - 1] as { pause: () => void }).pause).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    delete (document as { getAnimations?: unknown }).getAnimations;
    unsubscribe();
    vi.useRealTimers();
  }
});

it("holds animation frames while the desktop window is hidden and releases them on show", async () => {
  // The shipping classic script, installed the way index.html does: before anything else.
  new Function(frameGateSource)();
  await installDesktopVisibility();
  const unsubscribe = subscribeUiVisibility(() => {});
  try {
    await vi.waitFor(() => expect(isUiVisible()).toBe(true));
    const ran: string[] = [];
    native.callbacks.close();
    const held = requestAnimationFrame(() => ran.push("held"));
    const cancelled = requestAnimationFrame(() => ran.push("cancelled"));
    expect(held).toBeLessThan(0);
    cancelAnimationFrame(cancelled);
    await new Promise((r) => setTimeout(r, 60));
    expect(ran).toEqual([]);

    native.callbacks.focus();
    await vi.waitFor(() => expect(ran).toEqual(["held"]));
    // Visible again: straight through to the browser.
    expect(requestAnimationFrame(() => ran.push("live"))).toBeGreaterThan(0);
    await vi.waitFor(() => expect(ran).toEqual(["held", "live"]));
  } finally {
    unsubscribe();
  }
});
