import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { assetUrl } from "@/lib/api";
import { accentFor, initials } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useMotionEnabled } from "@/store/app";

interface Props {
  id: string;
  name: string;
  cover?: string | null;
  icon?: string | null;
  accent?: string | null;
  steamAppId?: number | null;
  className?: string;
  rounded?: string;
  variant?: "cover" | "icon";
  kenBurns?: boolean;
}

function SteamCornerBadge() {
  return (
    <div
      className="pointer-events-none absolute bottom-[6%] right-[6%] z-20 flex aspect-square w-[22%] min-w-[14px] max-w-[26px] items-center justify-center rounded-[22%] bg-[#171a21]/92 shadow-md ring-1 ring-white/25"
      title="Steam"
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-[62%] w-[62%] fill-white">
        <path d="M12 2C6.48 2 2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15.9c-.98-.15-1.84-.6-2.55-1.24l1.02 4.25c.9.46 1.9.71 2.95.71 1.43 0 2.75-.5 3.78-1.34l-1.55-1.34c.64.37 1.38.59 2.17.59.61 0 1.19-.13 1.72-.35l-1.02-4.24A5.96 5.96 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6c0 .32-.03.64-.08.95h2.38C19.48 4.84 16.48 2 12 2z" />
      </svg>
    </div>
  );
}

/** Renders cover art, icon, or a deterministic gradient placeholder with initials. */
export function GameArt({
  id,
  name,
  cover,
  icon,
  accent,
  steamAppId,
  className,
  rounded = "rounded-2xl",
  variant = "cover",
  kenBurns = false,
}: Props) {
  const enabled = useMotionEnabled();
  const src = assetUrl(variant === "cover" ? cover || icon : icon || cover);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    // Cached images (e.g. when navigating back to a screen) may already be
    // complete before React attaches `onLoad`, so the event never fires and the
    // image would stay at opacity 0. Reveal it immediately when that happens.
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setLoaded(true);
    }
  }, [src]);
  const showImage = !!src && !failed;
  const [a, b] = accentFor(id);
  const from = accent || a;
  const to = b;

  return (
    <div className={cn("relative overflow-hidden [container-type:inline-size]", rounded, className)}>
      {/* Animated gradient base — always present as fallback */}
      {enabled ? (
        <motion.div
          className="absolute inset-0"
          animate={{ backgroundPosition: ["0% 40%", "100% 60%", "0% 40%"] }}
          transition={{ duration: 9, repeat: Infinity, ease: "linear" }}
          style={{
            background: `linear-gradient(135deg, ${from}, ${to}, ${from})`,
            backgroundSize: "220% 220%",
          }}
        />
      ) : (
        <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${from}, ${to})` }} />
      )}

      {!showImage ? (
        <>
          <div className="absolute inset-0 opacity-30 mix-blend-overlay bg-grid-faint [background-size:14px_14px]" />
          <div className="absolute inset-0 grid place-items-center">
            {enabled ? (
              <motion.span
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.15, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="font-display text-[clamp(1rem,32cqw,3rem)] font-800 text-white/90 drop-shadow"
              >
                {initials(name)}
              </motion.span>
            ) : (
              <span className="font-display text-[clamp(1rem,32cqw,3rem)] font-800 text-white/90 drop-shadow">
                {initials(name)}
              </span>
            )}
          </div>
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/30 to-transparent" />
        </>
      ) : (
        <AnimatePresence mode="wait">
          <motion.div
            key={src}
            className="absolute inset-0"
            initial={enabled && kenBurns ? { scale: 1.08 } : false}
            animate={
              enabled && kenBurns
                ? { scale: [1.08, 1.14, 1.1], x: [0, -12, 6], y: [0, -8, 4] }
                : undefined
            }
            transition={kenBurns ? { duration: 22, repeat: Infinity, ease: "linear" } : undefined}
          >
            <motion.img
              ref={imgRef}
              src={src ?? undefined}
              alt={name}
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
              initial={enabled ? { opacity: 0 } : false}
              animate={{ opacity: loaded ? 1 : 0 }}
              transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          </motion.div>
        </AnimatePresence>
      )}
      {variant === "cover" && steamAppId != null && steamAppId > 0 ? <SteamCornerBadge /> : null}
    </div>
  );
}
