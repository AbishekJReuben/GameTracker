/**
 * Small shared companion UI primitives + the game-detail navigation hook.
 *
 * These mirror desktop building blocks but talk to the remote link: cover art is
 * resolved through `loadMedia` (cloud fetches the bytes over the data channel)
 * instead of the desktop asset protocol.
 */

import { useEffect, useState } from "react";
import type { GameStatus } from "@/lib/api";
import { accentFor, initials } from "@/lib/format";
import { loadMedia } from "./link";

/** Status → label + color, shared by Library and GameDetail. */
export const STATUS_STYLE: Record<GameStatus, { label: string; color: string }> = {
  playing: { label: "Playing", color: "#34d399" },
  completed: { label: "Completed", color: "#a78bfa" },
  backlog: { label: "Backlog", color: "#64748b" },
  on_hold: { label: "On Hold", color: "#fbbf24" },
  dropped: { label: "Dropped", color: "#f87171" },
  watched: { label: "Watched", color: "#22d3ee" },
};
export const STATUS_ORDER: GameStatus[] = ["playing", "backlog", "on_hold", "completed", "dropped", "watched"];

/** Cover / icon art that resolves over either transport, with a gradient+initials
 *  fallback so a tile is never empty (even before art streams in). */
export function Art({
  id,
  name,
  cover,
  icon,
  accent,
  rounded = "rounded-xl",
  variant = "cover",
  className,
}: {
  id: string;
  name: string;
  cover?: string | null;
  icon?: string | null;
  accent?: string | null;
  rounded?: string;
  variant?: "cover" | "icon";
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const primary = variant === "cover" ? cover ?? icon : icon ?? cover;
  useEffect(() => {
    let alive = true;
    setSrc(null);
    loadMedia(primary).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [primary]);
  const [a, b] = accentFor(id);
  return (
    <div
      className={`relative overflow-hidden [container-type:inline-size] ${rounded} ${className ?? ""}`}
      style={{ background: `linear-gradient(140deg, ${accent || a}, ${b})` }}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <span className="font-display text-[clamp(0.75rem,30cqw,2.6rem)] font-800 text-white/85">{initials(name)}</span>
        </div>
      )}
    </div>
  );
}

/** A remote image (screenshot / achievement icon) that's already an http(s) URL. */
export function RemoteImg({ url, className, alt = "" }: { url: string; className?: string; alt?: string }) {
  return <img src={url} alt={alt} loading="lazy" className={className} />;
}

/** An image resolved from a local media path over the link (`loadMedia`), with a
 *  fallback slot shown until/unless the art loads (e.g. media thumbnails). */
export function LoadedImg({ path, className, fallback }: { path?: string | null; className?: string; fallback?: React.ReactNode }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    loadMedia(path).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [path]);
  if (src) return <img src={src} alt="" loading="lazy" className={className} />;
  return <>{fallback ?? null}</>;
}

// ---- game-detail navigation (a tiny global so any screen can open the sheet) ----

let currentGame: string | null = null;
const subs = new Set<(id: string | null) => void>();

/** Open the full-screen game detail for `id`. */
export function openGame(id: string) {
  currentGame = id;
  subs.forEach((f) => f(id));
}
/** Close the detail overlay. */
export function closeGame() {
  currentGame = null;
  subs.forEach((f) => f(null));
}
/** Subscribe to the currently-open game id (null when the sheet is closed). */
export function useOpenGame(): string | null {
  const [id, setId] = useState<string | null>(currentGame);
  useEffect(() => {
    const f = (v: string | null) => setId(v);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  return id;
}
