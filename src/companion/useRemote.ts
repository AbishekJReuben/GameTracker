import { useEffect, useRef, useState } from "react";
import { apiGet } from "./link";

/**
 * Poll a remote GET endpoint on an interval. Returns the latest data, a loading
 * flag, and the last error. Pauses when the tab is hidden to save battery/data.
 */
export function useRemote<T>(path: string, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const d = await apiGet<T>(path);
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e instanceof Error ? e.message : e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    tick();
    timer.current = window.setInterval(tick, intervalMs);
    return () => {
      alive = false;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [path, intervalMs]);

  return { data, error, loading };
}
