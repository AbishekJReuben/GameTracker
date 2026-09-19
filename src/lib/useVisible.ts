import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

let windowVisible = true;
const listeners = new Set<() => void>();
export const isUiVisible = () => windowVisible && (typeof document === "undefined" || document.visibilityState === "visible");
function notifyVisibility() {
  document.documentElement.dataset.uiVisible = String(isUiVisible());
  listeners.forEach((listener) => listener());
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
