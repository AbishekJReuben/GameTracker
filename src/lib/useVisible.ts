import { useEffect, useRef, useState } from "react";

/** True while the window/tab is visible. Lets animation loops pause when hidden. */
export function useDocumentVisible() {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible"
  );
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/** Track whether an element is in the viewport (so offscreen FX can pause). */
export function useInView<T extends Element>(rootMargin = "120px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? true),
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return { ref, inView };
}
