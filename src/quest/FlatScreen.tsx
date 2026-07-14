/**
 * DEPRECATED / UNUSED — live Quest path is QuestApp → CompanionApp + ImmersiveScreen.
 * Kept on disk for reference only; do not import. Feature work belongs in
 * `src/companion/screens/Control.tsx` and `src/companion/cloud.ts`.
 *
 * Flat (2D) remote screen for the Quest browser window. The controller acts as a
 * laser pointer that generates ordinary PointerEvents; we map them to absolute
 * cursor moves + clicks/drags on the PC, forward the thumbstick wheel to scroll,
 * and raise the Quest system keyboard from a hidden <input> for typing.
 *
 * This is a complete remote on its own; the "Enter VR" button hands off to the
 * immersive big-screen mode.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Command,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  CornerDownLeft,
  Delete,
  Headset,
  LogOut,
  Send,
  X,
  Gauge,
  MousePointerClick,
} from "lucide-react";
import type { RemoteLink, ControlMsg, QualitySettings } from "@/companion/links";
import { TextDiffSender } from "./textDiff";

type Mod = "ctrl" | "alt" | "shift" | "win";

const TAP_MS = 260;
const TAP_SLOP = 0.012; // normalized
const LONGPRESS_MS = 550;
const MOVE_THROTTLE_MS = 16; // ~60 Hz absolute cursor updates

type Layout = { dispW: number; dispH: number; offX: number; offY: number };

/** Object-contain image box of `natW×natH` inside element `el`. */
function containBox(el: HTMLElement, natW: number, natH: number): Layout | null {
  if (!natW || !natH) return null;
  const r = el.getBoundingClientRect();
  const ratio = natW / natH;
  let dispW = r.width;
  let dispH = r.width / ratio;
  if (dispH > r.height) {
    dispH = r.height;
    dispW = r.height * ratio;
  }
  return { dispW, dispH, offX: (r.width - dispW) / 2, offY: (r.height - dispH) / 2 };
}

export function FlatScreen({
  link,
  stream,
  vrSupported,
  onEnterVr,
  onDisconnect,
}: {
  link: RemoteLink;
  stream: MediaStream | null;
  vrSupported: boolean;
  onEnterVr: () => void;
  onDisconnect: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const kbdRef = useRef<HTMLInputElement | null>(null);

  const [typing, setTyping] = useState(false);
  const [mods, setMods] = useState<Set<Mod>>(new Set());
  const [quality, setQuality] = useState<QualitySettings>({ maxW: 1920, quality: 100, fps: 40, mode: "text", bitrate: 12000 });
  const [showQuality, setShowQuality] = useState(false);
  const [hint, setHint] = useState(true);

  const diff = useMemo(() => new TextDiffSender((m) => link.send(m)), [link]);
  const send = (m: ControlMsg) => link.send(m);

  // Attach the WebRTC media stream.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    v.play?.().catch(() => {});
  }, [stream]);

  // Push the chosen quality to the host whenever it changes.
  useEffect(() => {
    link.setQuality(quality);
  }, [link, quality]);

  // ---- pointer → absolute cursor ----
  const press = useRef<{ x: number; y: number; t: number; moved: boolean; dragging: boolean } | null>(null);
  const longTimer = useRef<number | null>(null);
  const lastMove = useRef(0);

  const norm = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const stage = stageRef.current;
    const v = videoRef.current;
    if (!stage || !v) return null;
    const box = containBox(stage, v.videoWidth || 16, v.videoHeight || 9);
    if (!box) return null;
    const r = stage.getBoundingClientRect();
    const px = clientX - r.left - box.offX;
    const py = clientY - r.top - box.offY;
    return {
      x: Math.max(0, Math.min(1, px / box.dispW)),
      y: Math.max(0, Math.min(1, py / box.dispH)),
    };
  };

  const clearLong = () => {
    if (longTimer.current) {
      window.clearTimeout(longTimer.current);
      longTimer.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const n = norm(e.clientX, e.clientY);
    if (!n) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setHint(false);
    send({ type: "move", x: n.x, y: n.y });
    press.current = { x: n.x, y: n.y, t: performance.now(), moved: false, dragging: false };
    clearLong();
    longTimer.current = window.setTimeout(() => {
      // Long press with no movement → right click.
      const p = press.current;
      if (p && !p.moved && !p.dragging) {
        send({ type: "click", button: "right" });
        press.current = null;
        navigator.vibrate?.(12);
      }
    }, LONGPRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const n = norm(e.clientX, e.clientY);
    if (!n) return;
    const now = performance.now();
    if (now - lastMove.current >= MOVE_THROTTLE_MS) {
      lastMove.current = now;
      send({ type: "move", x: n.x, y: n.y });
    }
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(n.x - p.x, n.y - p.y) > TAP_SLOP) {
      p.moved = true;
      clearLong();
      // Start a drag: press the left button down at the current spot.
      p.dragging = true;
      send({ type: "down", button: "left" });
    }
  };

  const onPointerUp = () => {
    clearLong();
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.dragging) {
      send({ type: "up", button: "left" });
    } else if (!p.moved && performance.now() - p.t < TAP_MS) {
      send({ type: "click", button: "left" });
    }
  };

  // ---- wheel → scroll (Quest thumbstick over the page emits wheel) ----
  // React's onWheel is passive (preventDefault is a no-op), so use one native
  // non-passive listener that both suppresses page scroll and forwards notches.
  const wheelAcc = useRef(0);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc.current += e.deltaY;
      const notches = Math.trunc(wheelAcc.current / 40);
      if (notches !== 0) {
        wheelAcc.current -= notches * 40;
        send({ type: "scroll", dy: notches });
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  // ---- keyboard ----
  const releaseMods = () => {
    if (mods.size === 0) return;
    mods.forEach((m) => send({ type: "keyup", name: m }));
    setMods(new Set());
  };
  const toggleMod = (m: Mod) =>
    setMods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        next.delete(m);
        send({ type: "keyup", name: m });
      } else {
        next.add(m);
        send({ type: "keydown", name: m });
      }
      return next;
    });
  const tapKey = (name: string) => {
    send({ type: "key", name });
    releaseMods();
    navigator.vibrate?.(6);
  };

  const startTyping = () => {
    setTyping(true);
    diff.reset(kbdRef.current);
    window.setTimeout(() => kbdRef.current?.focus(), 30);
  };
  const stopTyping = () => {
    kbdRef.current?.blur();
    setTyping(false);
  };

  useEffect(() => {
    return () => {
      clearLong();
      releaseMods();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-[100dvh] flex-col bg-bg-base text-ink">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] bg-bg-900/80 px-3 py-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent-sheen">
          <MousePointerClick className="h-4 w-4 text-white" />
        </span>
        <span className="font-display text-sm font-700">GameTracker Remote</span>
        <span className="ml-1 h-2 w-2 rounded-full bg-green shadow-[0_0_8px] shadow-green/60" title="Connected" />
        <div className="ml-auto flex items-center gap-2">
          <button className="btn btn-subtle h-9 px-3" onClick={() => setShowQuality((v) => !v)} title="Quality">
            <Gauge className="h-4 w-4" />
          </button>
          {vrSupported && (
            <button className="btn btn-primary h-9 gap-1.5 px-3" onClick={onEnterVr}>
              <Headset className="h-4 w-4" /> Enter VR
            </button>
          )}
          <button className="btn btn-subtle h-9 px-3" onClick={onDisconnect} title="Disconnect">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showQuality && (
        <div className="flex flex-wrap items-center gap-4 border-b border-white/[0.06] bg-bg-900/60 px-4 py-3 text-sm">
          <QualityControl
            label="Resolution"
            value={quality.maxW}
            options={[1280, 1600, 1920, 2560]}
            fmt={(v) => `${v}p→`}
            onChange={(maxW) => setQuality((q) => ({ ...q, maxW }))}
          />
          <QualityControl
            label="FPS"
            value={quality.fps}
            options={[30, 40, 60, 90]}
            fmt={(v) => `${v}`}
            onChange={(fps) => setQuality((q) => ({ ...q, fps }))}
          />
          <QualityControl
            label="Mode"
            value={quality.mode === "video" ? 1 : quality.mode === "auto" ? 2 : 0}
            options={[0, 1, 2]}
            fmt={(v) => (v === 1 ? "Video" : v === 2 ? "Auto" : "Text")}
            onChange={(v) => setQuality((q) => ({ ...q, mode: v === 1 ? "video" : v === 2 ? "auto" : "text" }))}
          />
        </div>
      )}

      {/* Video stage */}
      <div
        ref={stageRef}
        className="relative flex-1 touch-none select-none overflow-hidden bg-black"
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <video ref={videoRef} className="absolute inset-0 h-full w-full object-contain" playsInline muted autoPlay />
        {!stream && (
          <div className="absolute inset-0 grid place-items-center text-ink-dim">
            <div className="text-center">
              <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-accent-3" />
              Waiting for your PC's screen…
            </div>
          </div>
        )}
        {hint && stream && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-sm text-white/80 backdrop-blur">
            Point &amp; pull the trigger to click · hold for right-click · thumbstick scrolls
          </div>
        )}
      </div>

      {/* Keys row */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-t border-white/[0.06] bg-bg-900/80 px-3 py-2">
        <button className="btn btn-primary h-10 shrink-0 gap-1.5 px-3" onClick={startTyping}>
          <Keyboard className="h-4 w-4" /> Type
        </button>
        <ModKey label="Ctrl" active={mods.has("ctrl")} onClick={() => toggleMod("ctrl")} />
        <ModKey label="Alt" active={mods.has("alt")} onClick={() => toggleMod("alt")} />
        <ModKey label="Shift" active={mods.has("shift")} onClick={() => toggleMod("shift")} />
        <KeyBtn onClick={() => toggleMod("win")} active={mods.has("win")}>
          <Command className="h-4 w-4" />
        </KeyBtn>
        <Divider />
        <KeyBtn onClick={() => tapKey("escape")}>Esc</KeyBtn>
        <KeyBtn onClick={() => tapKey("tab")}>Tab</KeyBtn>
        <KeyBtn onClick={() => tapKey("enter")}>
          <CornerDownLeft className="h-4 w-4" />
        </KeyBtn>
        <KeyBtn onClick={() => tapKey("backspace")}>
          <Delete className="h-4 w-4" />
        </KeyBtn>
        <Divider />
        <KeyBtn onClick={() => tapKey("left")}>
          <ArrowLeft className="h-4 w-4" />
        </KeyBtn>
        <KeyBtn onClick={() => tapKey("up")}>
          <ArrowUp className="h-4 w-4" />
        </KeyBtn>
        <KeyBtn onClick={() => tapKey("down")}>
          <ArrowDown className="h-4 w-4" />
        </KeyBtn>
        <KeyBtn onClick={() => tapKey("right")}>
          <ArrowRight className="h-4 w-4" />
        </KeyBtn>
      </div>

      {/* Hidden input for the system keyboard (always mounted). */}
      <input
        ref={kbdRef}
        className="fixed left-1/2 top-2 h-8 w-40 -translate-x-1/2 rounded bg-bg-800/70 px-2 text-center text-sm text-ink"
        style={{ opacity: typing ? 0.15 : 0, pointerEvents: typing ? "auto" : "none" }}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-label="Remote keyboard input"
        onInput={() => diff.flush(kbdRef.current)}
        onBlur={() => setTyping(false)}
        onKeyDown={(e) => {
          // Hardware keyboards paired to the Quest can emit navigation keys.
          const nav: Record<string, string> = {
            Enter: "enter",
            Tab: "tab",
            Escape: "escape",
            ArrowUp: "up",
            ArrowDown: "down",
            ArrowLeft: "left",
            ArrowRight: "right",
          };
          const name = nav[e.key];
          if (name) {
            e.preventDefault();
            tapKey(name);
          }
        }}
      />

      {typing && (
        <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t border-white/10 bg-bg-900/95 px-4 py-3 backdrop-blur">
          <Keyboard className="h-5 w-5 text-accent-3" />
          <span className="text-sm text-ink-dim">Typing to PC — the headset keyboard is open.</span>
          <button className="btn btn-subtle ml-auto h-10 gap-1.5 px-3" onClick={() => tapKey("enter")}>
            <Send className="h-4 w-4" /> Enter
          </button>
          <button className="btn btn-ghost h-10 px-3" onClick={stopTyping}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function KeyBtn({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`h-10 min-w-10 shrink-0 rounded-xl border px-3 text-sm font-600 transition active:scale-95 ${
        active ? "border-accent-3/60 bg-accent-3/20 text-accent-3" : "border-white/10 bg-white/[0.04] text-ink hover:bg-white/[0.08]"
      }`}
    >
      {children}
    </button>
  );
}
function ModKey({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <KeyBtn onClick={onClick} active={active}>
      {label}
    </KeyBtn>
  );
}
function Divider() {
  return <span className="mx-0.5 h-6 w-px shrink-0 bg-white/10" />;
}
function QualityControl<T extends number>({
  label,
  value,
  options,
  fmt,
  onChange,
}: {
  label: string;
  value: T;
  options: T[];
  fmt: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-ink-dim">{label}</span>
      <div className="flex overflow-hidden rounded-lg border border-white/10">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`px-2.5 py-1 text-xs font-600 ${value === o ? "bg-accent-3/25 text-accent-3" : "text-ink-dim hover:bg-white/[0.06]"}`}
          >
            {fmt(o)}
          </button>
        ))}
      </div>
    </div>
  );
}
