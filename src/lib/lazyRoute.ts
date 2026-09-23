import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * Route-level code splitting with an explicit preload.
 *
 * Every screen used to be imported eagerly, so the desktop parsed ~2 MB of JS at
 * launch (it autostarts at login, usually straight to the tray) and the phone app
 * ~1.4 MB before showing anything. Screens are now separate chunks; the entry
 * screen stays eager and `preloadWhenIdle` warms the rest once the app is idle, so
 * the first visit to any screen is still instant — only startup gets cheaper.
 */
export type LazyRoute<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  preload: () => Promise<unknown>;
};

export function lazyRoute<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): LazyRoute<T> {
  let pending: Promise<{ default: T }> | null = null;
  const once = () => (pending ??= load());
  const C = lazy(once) as LazyRoute<T>;
  C.preload = once;
  return C;
}

/** Warm route chunks in the background after startup, one at a time. */
export function preloadWhenIdle(routes: { preload: () => Promise<unknown> }[], delayMs = 2500): () => void {
  let cancelled = false;
  const idle = (cb: () => void) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(cb, { timeout: 2000 });
    else setTimeout(cb, 50);
  };
  const timer = setTimeout(() => {
    const next = (i: number) => {
      if (cancelled || i >= routes.length) return;
      idle(() => {
        if (cancelled) return;
        routes[i]
          .preload()
          .catch(() => {})
          .finally(() => next(i + 1));
      });
    };
    next(0);
  }, delayMs);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}
