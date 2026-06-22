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
  className?: string;
  rounded?: string;
  variant?: "cover" | "icon";
  kenBurns?: boolean;
}

/** Renders cover art, icon, or a deterministic gradient placeholder with initials. */
export function GameArt({
  id,
  name,
  cover,
  icon,
  accent,
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
    </div>
  );
}
