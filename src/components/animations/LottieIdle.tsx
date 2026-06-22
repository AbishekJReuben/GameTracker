import { useEffect, useState } from "react";
import Lottie, { type LottieRefCurrentProps } from "lottie-react";
import { useRef } from "react";
import { useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

type LottieData = object;

const cache = new Map<string, LottieData>();

async function loadAnimation(src: string): Promise<LottieData> {
  const hit = cache.get(src);
  if (hit) return hit;
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Lottie fetch failed: ${src}`);
  const data = (await res.json()) as LottieData;
  cache.set(src, data);
  return data;
}

/** Tasteful idle / loading Lottie — respects motion prefs and caches JSON. */
export function LottieIdle({
  src,
  className,
  loop = true,
  speed = 1,
  opacity = 1,
}: {
  src: string;
  className?: string;
  loop?: boolean;
  speed?: number;
  opacity?: number;
}) {
  const enabled = useMotionEnabled();
  const lottieRef = useRef<LottieRefCurrentProps>(null);
  const [data, setData] = useState<LottieData | null>(() => cache.get(src) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadAnimation(src)
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src, enabled]);

  useEffect(() => {
    if (!lottieRef.current || !enabled) return;
    lottieRef.current.setSpeed(speed);
  }, [speed, data, enabled]);

  if (!enabled || failed) return null;
  if (!data) {
    return (
      <div
        className={cn("animate-pulse rounded-full bg-white/[0.06]", className)}
        aria-hidden
      />
    );
  }

  return (
    <Lottie
      lottieRef={lottieRef}
      animationData={data}
      loop={loop}
      className={cn("pointer-events-none", className)}
      style={{ opacity }}
      aria-hidden
    />
  );
}
