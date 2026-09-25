import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

let windowVisible = true;
const listeners = new Set<() => void>();
export const isUiVisible = () => windowVisible && (typeof document === "undefined" || document.visibilityState === "visible");
function notifyVisibility() {
  const visible = isUiVisible();
  document.documentElement.dataset.uiVisible = String(visible);
  syncScriptAnimations(visible);
  holdFrames(!visible);
  listeners.forEach((listener) => listener());
}

/*
 * Hiding to the tray hides the native window, but wry leaves the WebView2
 * controller visible, so the page never goes document-hidden and the browser
 * throttles nothing. Measured behind the tray: renderer ~20% and GPU process
 * ~26% of a core, from three sources, each handled here:
 *   - CSS animations: the stylesheet rule on data-ui-visible pauses them.
 *   - Web Animations (Motion's accelerated loops): paused below, re-swept for
 *     ones mounted since, and exactly those resumed on show.
 *   - requestAnimationFrame (Motion's JS loops, shader canvases): held until the
 *     window is shown again, as a browser does for a hidden tab. The wrapper is
 *     public/frame-gate.js, which must load before any module (Motion captures
 *     rAF at import time); this only flips it.
 * Nothing that must work in the tray (remote hosting, Notes sync, music) runs
 * off rAF or Web Animations.
 */
const SWEEP_MS = 5_000;
const pausedByUs = new Set<Animation>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;
function pauseScriptAnimations() {
  for (const animation of document.getAnimations()) {
    // CSSAnimation / CSSTransition: the stylesheet rule owns those.
    if ("animationName" in animation || "transitionProperty" in animation) continue;
    if (animation.playState !== "running") continue;
    animation.pause();
    pausedByUs.add(animation);
  }
}
function syncScriptAnimations(visible: boolean) {
  if (typeof document.getAnimations !== "function") return;
  if (!visible) {
    pauseScriptAnimations();
    sweepTimer ??= setInterval(pauseScriptAnimations, SWEEP_MS);
    return;
  }
  if (sweepTimer !== undefined) { clearInterval(sweepTimer); sweepTimer = undefined; }
  for (const animation of pausedByUs) {
    // Cancelled or replaced by Motion while hidden: leave it alone.
    if (animation.playState === "paused") animation.play();
  }
  pausedByUs.clear();
}
type FrameGate = { hold: boolean; release: () => void };
function holdFrames(hold: boolean) {
  const gate = (window as { __gtFrameGate?: FrameGate }).__gtFrameGate;
  if (!gate || gate.hold === hold) return;
  gate.hold = hold;
  if (!hold) gate.release();
}

export function subscribeUiVisibility(listener: () => void) {
  if (listeners.size === 0) document.addEventListener("visibilitychange", notifyVisibility);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) document.removeEventListener("visibilitychange", notifyVisibility);
  };
}

/** WebView2 can remain document-visible after its native window hides to tray. */
export async function installDesktopVisibility() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  let revision = 0;
  const refresh = async () => {
    const mine = ++revision;
    const [shown, minimized] = await Promise.all([win.isVisible(), win.isMinimized()]);
    if (mine !== revision) return;
    windowVisible = shown && !minimized;
    notifyVisibility();
  };
  const safeRefresh = () => { void refresh().catch(() => {}); };
  await win.onFocusChanged(safeRefresh);
  await win.onResized(safeRefresh);
  await win.onCloseRequested(() => {
    ++revision;
    windowVisible = false;
    notifyVisibility();
  });
  await refresh();
}

/** True while the window/tab is visible. Lets animation loops pause when hidden. */
export function useDocumentVisible() {
  return useSyncExternalStore(subscribeUiVisibility, isUiVisible, () => true);
}

type VisibilityCallback = (visible: boolean) => void;
const observerPools = new Map<string, { observer: IntersectionObserver; callbacks: Map<Element, Set<VisibilityCallback>> }>();
function observeElement(element: Element, margin: string, callback: VisibilityCallback) {
  let pool = observerPools.get(margin);
  if (!pool) {
    const callbacks = new Map<Element, Set<VisibilityCallback>>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) callbacks.get(entry.target)?.forEach((fn) => fn(entry.isIntersecting));
    }, { rootMargin: margin });
    pool = { observer, callbacks };
    observerPools.set(margin, pool);
  }
  let callbacks = pool.callbacks.get(element);
  if (!callbacks) { callbacks = new Set(); pool.callbacks.set(element, callbacks); pool.observer.observe(element); }
  callbacks.add(callback);
  return () => {
    callbacks!.delete(callback);
    if (!callbacks!.size) { pool!.observer.unobserve(element); pool!.callbacks.delete(element); }
    if (!pool!.callbacks.size) { pool!.observer.disconnect(); observerPools.delete(margin); }
  };
}

/** Shared observers: a 300-image gallery uses one observer, not 300. */
export function useInView<T extends Element>(rootMargin = "120px", initial = true) {
  const elementRef = useRef<T | null>(null);
  const [element, setElement] = useState<T | null>(null);
  const ref = useCallback((node: T | null) => { elementRef.current = node; setElement(node); }, []);
  const [inView, setInView] = useState(initial);
  useEffect(() => {
    const el = element;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    return observeElement(el, rootMargin, setInView);
  }, [rootMargin, element]);
  return { ref, elementRef, inView };
}
