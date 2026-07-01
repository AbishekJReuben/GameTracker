import { useEffect, useRef, useState } from "react";
import {
  MousePointer2,
  MousePointerClick,
  ChevronUp,
  ChevronDown,
  CornerDownLeft,
  Delete,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Keyboard,
  Loader2,
  Sliders,
  X,
  RefreshCw,
  LogOut,
} from "lucide-react";
import type { RemoteLink } from "../links";

export function ControlScreen({
  link,
  onNavigate,
  onDisconnect,
}: {
  link: RemoteLink;
  onNavigate?: (tab: "stats" | "music" | "control") => void;
  onDisconnect?: () => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const lastUrl = useRef<string | null>(null);
  const kbdRef = useRef<HTMLInputElement | null>(null);

  // Gesture refs
  const activePointers = useRef<Map<number, { clientX: number; clientY: number; startX: number; startY: number }>>(new Map());
  const pinchStartDist = useRef<number>(0);
  const pinchStartScale = useRef<number>(1);
  const pinchStartMid = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pinchStartPan = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const touchStartTime = useRef<number>(0);
  const touchStartCount = useRef<number>(0);
  const isPinching = useRef<boolean>(false);
  const maxMovement = useRef<number>(0);

  // Connection & base UI states
  const [connected, setConnected] = useState(false);
  const [button, setButton] = useState<"left" | "right">("left");
  const [kbdOpen, setKbdOpen] = useState(false);

  // Overhaul states
  const [inputMode, setInputMode] = useState<"touch" | "mouse">("mouse");
  const [controlsOpen, setControlsOpen] = useState(true);
  const [dragLocked, setDragLocked] = useState(false);
  const [sensitivity, setSensitivity] = useState(1.2);
  const [zoomScale, setZoomScale] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);

  // Frame and connection lifecycle
  useEffect(() => {
    link.onStatus(setConnected);
    link.onFrame((blob) => {
      if (!imgRef.current) return;
      const url = URL.createObjectURL(blob);
      imgRef.current.src = url;
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
      lastUrl.current = url;
    });
    return () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
  }, [link]);

  // Coordinate mapping for Touch (absolute) Mode
  const normFromEvent = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return null;
    const rect = img.getBoundingClientRect();
    const natRatio = img.naturalWidth / img.naturalHeight;
    const boxRatio = rect.width / rect.height;
    let dispW = rect.width;
    let dispH = rect.height;
    let offX = 0;
    let offY = 0;
    if (natRatio > boxRatio) {
      dispH = rect.width / natRatio;
      offY = (rect.height - dispH) / 2;
    } else {
      dispW = rect.height * natRatio;
      offX = (rect.width - dispW) / 2;
    }
    const x = (clientX - rect.left - offX) / dispW;
    const y = (clientY - rect.top - offY) / dispH;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  // Pointer Event Handlers for Custom Gestures
  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);

    const now = performance.now();
    const info = {
      clientX: e.clientX,
      clientY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
    };
    activePointers.current.set(e.pointerId, info);

    if (activePointers.current.size === 1) {
      touchStartTime.current = now;
      touchStartCount.current = 1;
      maxMovement.current = 0;

      if (inputMode === "mouse") {
        if (dragLocked) {
          link.send({ type: "down", button: "left" });
        }
      } else {
        // Touch mode absolute click/drag start
        const n = normFromEvent(e.clientX, e.clientY);
        if (n) {
          link.send({ type: "move", x: n.x, y: n.y });
          link.send({ type: "down", button });
        }
      }
    } else if (activePointers.current.size === 2) {
      touchStartCount.current = 2;
      isPinching.current = true;

      const pts = Array.from(activePointers.current.values());
      const p1 = pts[0];
      const p2 = pts[1];

      pinchStartDist.current = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
      pinchStartScale.current = zoomScale;
      pinchStartMid.current = {
        x: (p1.clientX + p2.clientX) / 2,
        y: (p1.clientY + p2.clientY) / 2,
      };
      pinchStartPan.current = { x: panX, y: panY };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const pId = e.pointerId;
    const curr = activePointers.current.get(pId);
    if (!curr) return;

    const prevX = curr.clientX;
    const prevY = curr.clientY;

    curr.clientX = e.clientX;
    curr.clientY = e.clientY;

    const movement = Math.hypot(e.clientX - curr.startX, e.clientY - curr.startY);
    if (movement > maxMovement.current) {
      maxMovement.current = movement;
    }

    if (isPinching.current && activePointers.current.size >= 2) {
      // Pinch to zoom and pan
      const pts = Array.from(activePointers.current.values());
      const p1 = pts[0];
      const p2 = pts[1];

      const dist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
      const midX = (p1.clientX + p2.clientX) / 2;
      const midY = (p1.clientY + p2.clientY) / 2;

      let newScale = pinchStartScale.current;
      if (pinchStartDist.current > 0) {
        newScale = pinchStartScale.current * (dist / pinchStartDist.current);
        newScale = Math.min(5, Math.max(1, newScale));
      }

      const dx = midX - pinchStartMid.current.x;
      const dy = midY - pinchStartMid.current.y;

      setZoomScale(newScale);
      setPanX(pinchStartPan.current.x + dx);
      setPanY(pinchStartPan.current.y + dy);
    } else if (activePointers.current.size === 1 && !isPinching.current) {
      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;

      if (inputMode === "mouse") {
        if (dx !== 0 || dy !== 0) {
          link.send({
            type: "moverel",
            dx: Math.round((dx * sensitivity) / zoomScale),
            dy: Math.round((dy * sensitivity) / zoomScale),
          });
        }
      } else {
        const n = normFromEvent(e.clientX, e.clientY);
        if (n) {
          link.send({ type: "move", x: n.x, y: n.y });
        }
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const pId = e.pointerId;
    const curr = activePointers.current.get(pId);
    activePointers.current.delete(pId);

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(pId);
    } catch (_) {}

    const now = performance.now();

    if (activePointers.current.size === 0) {
      const wasPinch = isPinching.current;
      isPinching.current = false;

      if (!wasPinch) {
        if (inputMode === "mouse") {
          const duration = now - touchStartTime.current;
          if (duration < 250 && maxMovement.current < 8) {
            // Tap gesture
            if (touchStartCount.current === 1) {
              link.send({ type: "click", button });
            } else if (touchStartCount.current === 2) {
              // Two-finger tap -> Right click
              link.send({ type: "click", button: "right" });
            }
          } else {
            // Drag release (if not drag-locked)
            if (!dragLocked) {
              link.send({ type: "up", button });
            }
          }
        } else {
          // Touch mode release
          link.send({ type: "up", button });
        }
      } else {
        // Zoom snap-back if very close to 1
        if (zoomScale < 1.05) {
          setZoomScale(1);
          setPanX(0);
          setPanY(0);
        }
      }
    } else if (activePointers.current.size === 1) {
      // Re-anchor last coordinates to prevent cursor jump on finger lift
      const remaining = Array.from(activePointers.current.values())[0];
      remaining.clientX = e.clientX;
      remaining.clientY = e.clientY;
      isPinching.current = true;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const k = e.key;
    if (k.length === 1) {
      link.send({ type: "text", value: k });
    } else {
      const map: Record<string, string> = {
        Enter: "enter",
        Backspace: "backspace",
        Escape: "escape",
        Tab: "tab",
        Delete: "delete",
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
        Home: "home",
        End: "end",
        PageUp: "pageup",
        PageDown: "pagedown",
        " ": "space",
      };
      const name = map[k];
      if (name) link.send({ type: "key", name });
    }
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-black select-none">
      {/* Full-screen Remote Screen Viewport */}
      <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
        <img
          ref={imgRef}
          alt="Remote screen"
          className="max-h-full max-w-full touch-none select-none object-contain transition-transform duration-75"
          style={{
            transform: `translate(${panX}px, ${panY}px) scale(${zoomScale})`,
            transformOrigin: "center",
          }}
          draggable={false}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>

      {/* Floating Action Button (FAB) to Toggle Controls */}
      <button
        onClick={() => setControlsOpen(!controlsOpen)}
        className="absolute bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-accent-3 text-white shadow-glow active:scale-95 transition-transform"
        style={{ transform: kbdOpen ? "translateY(-280px)" : "none" }}
      >
        {controlsOpen ? <X className="h-6 w-6" /> : <Sliders className="h-6 w-6" />}
      </button>

      {/* Floating Top Panel */}
      <div
        className={`absolute top-4 left-4 right-4 z-40 rounded-2xl glass p-3 border border-white/[0.08] shadow-float transition-all duration-300 ${
          controlsOpen ? "translate-y-0 opacity-100" : "-translate-y-24 opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {onNavigate && (
              <button
                onClick={() => onNavigate("stats")}
                className="btn btn-ghost h-8 w-8 p-0 rounded-lg text-ink-soft active:bg-white/[0.08]"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <div className="flex items-center gap-2">
              {connected ? (
                <span className="flex items-center gap-1.5 text-green text-xs font-700">
                  <span className="h-2 w-2 rounded-full bg-green animate-pulse" style={{ boxShadow: "0 0 8px #34d399" }} />
                  Live
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-ink-dim text-xs font-700">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Connecting...
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {(zoomScale !== 1 || panX !== 0 || panY !== 0) && (
              <button
                onClick={() => {
                  setZoomScale(1);
                  setPanX(0);
                  setPanY(0);
                }}
                className="btn btn-subtle h-8 px-2.5 text-xs flex items-center gap-1 bg-white/[0.08] text-white"
              >
                <RefreshCw className="h-3 w-3" />
                Reset Zoom ({zoomScale.toFixed(1)}x)
              </button>
            )}
          </div>
        </div>

        {/* Input Mode Selector */}
        <div className="mt-2.5 flex bg-white/[0.03] p-1 rounded-xl border border-white/[0.05] w-full text-xs">
          <button
            onClick={() => setInputMode("mouse")}
            className={`flex-1 py-1.5 rounded-lg font-700 transition ${
              inputMode === "mouse" ? "bg-white/[0.08] text-white shadow-sm" : "text-ink-dim"
            }`}
          >
            Mouse (Trackpad)
          </button>
          <button
            onClick={() => setInputMode("touch")}
            className={`flex-1 py-1.5 rounded-lg font-700 transition ${
              inputMode === "touch" ? "bg-white/[0.08] text-white shadow-sm" : "text-ink-dim"
            }`}
          >
            Touch (Direct)
          </button>
        </div>
      </div>

      {/* Floating Scroll Panel (Right Side) */}
      <div
        className={`absolute right-6 top-1/2 -translate-y-1/2 z-40 rounded-2xl glass p-2 border border-white/[0.08] shadow-float flex flex-col gap-2 transition-all duration-300 ${
          controlsOpen && !kbdOpen ? "translate-x-0 opacity-100" : "translate-x-24 opacity-0 pointer-events-none"
        }`}
      >
        <button
          onClick={() => link.send({ type: "scroll", dy: -4 })}
          className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.05] bg-white/[0.03] text-ink-soft active:bg-white/[0.08]"
        >
          <ChevronUp className="h-5 w-5" />
        </button>
        <div className="text-[10px] text-center text-ink-faint font-700">Scroll</div>
        <button
          onClick={() => link.send({ type: "scroll", dy: 4 })}
          className="grid h-10 w-10 place-items-center rounded-xl border border-white/[0.05] bg-white/[0.03] text-ink-soft active:bg-white/[0.08]"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      </div>

      {/* Floating Bottom Panel */}
      <div
        className={`absolute bottom-4 left-4 right-24 z-40 rounded-2xl glass p-3 border border-white/[0.08] shadow-float flex flex-col gap-2.5 transition-all duration-300 ${
          controlsOpen ? "translate-y-0 opacity-100" : "translate-y-48 opacity-0 pointer-events-none"
        }`}
        style={{ transform: kbdOpen ? "translateY(-10px)" : "none" }}
      >
        {/* Top Control Bar */}
        <div className="flex flex-wrap items-center gap-1.5 justify-between">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setButton((b) => (b === "left" ? "right" : "left"))}
              className="btn btn-subtle h-8 px-2.5 text-xs flex items-center gap-1 bg-white/[0.04]"
            >
              {button === "left" ? <MousePointer2 className="h-3.5 w-3.5" /> : <MousePointerClick className="h-3.5 w-3.5" />}
              {button === "left" ? "Left Click" : "Right Click"}
            </button>

            {inputMode === "mouse" && (
              <button
                onClick={() => {
                  if (dragLocked) {
                    link.send({ type: "up", button: "left" });
                    setDragLocked(false);
                  } else {
                    link.send({ type: "down", button: "left" });
                    setDragLocked(true);
                  }
                }}
                className={`btn h-8 px-2.5 text-xs flex items-center gap-1 border transition ${
                  dragLocked
                    ? "bg-accent-1 text-white border-accent-1 shadow-glow"
                    : "bg-white/[0.04] text-ink-soft border-white/[0.05]"
                }`}
              >
                <MousePointerClick className="h-3.5 w-3.5" />
                {dragLocked ? "Drag Lock ON" : "Drag Lock"}
              </button>
            )}
          </div>

          <button
            onClick={() => {
              setKbdOpen(!kbdOpen);
              setTimeout(() => {
                if (!kbdOpen) kbdRef.current?.focus();
              }, 100);
            }}
            className={`btn h-8 px-2.5 text-xs flex items-center gap-1 border transition ${
              kbdOpen
                ? "bg-accent-3 text-white border-accent-3 shadow-glow"
                : "bg-white/[0.04] text-ink-soft border-white/[0.05]"
            }`}
          >
            <Keyboard className="h-3.5 w-3.5" />
            Keyboard
          </button>
        </div>

        {/* Keyboard Input Field (visible when keyboard is open) */}
        <input
          ref={kbdRef}
          value=""
          onChange={() => {}}
          onKeyDown={onKeyDown}
          onBlur={() => setKbdOpen(false)}
          className={`w-full rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white outline-none focus:border-accent-3 transition-all ${
            kbdOpen ? "block" : "hidden"
          }`}
          placeholder="Tap here to bring up your phone keyboard"
          autoCapitalize="none"
          autoCorrect="off"
        />

        {/* Modifiers & Quick Action Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          <KeyBtn onClick={() => link.send({ type: "key", name: "escape" })}>Esc</KeyBtn>
          <KeyBtn onClick={() => link.send({ type: "key", name: "tab" })}>Tab</KeyBtn>
          <IconBtn onClick={() => link.send({ type: "key", name: "enter" })}><CornerDownLeft className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => link.send({ type: "key", name: "backspace" })}><Delete className="h-4 w-4" /></IconBtn>
          <div className="flex-1" />
          <div className="flex items-center gap-1 bg-white/[0.02] p-0.5 rounded-lg border border-white/[0.05]">
            <IconBtn onClick={() => link.send({ type: "key", name: "left" })}><ArrowLeft className="h-4 w-4" /></IconBtn>
            <div className="flex flex-col gap-1">
              <IconBtn onClick={() => link.send({ type: "key", name: "up" })}><ArrowUp className="h-4 w-4" /></IconBtn>
              <IconBtn onClick={() => link.send({ type: "key", name: "down" })}><ArrowDown className="h-4 w-4" /></IconBtn>
            </div>
            <IconBtn onClick={() => link.send({ type: "key", name: "right" })}><ArrowRight className="h-4 w-4" /></IconBtn>
          </div>
        </div>

        {/* Mouse Mode Speed Slider */}
        {inputMode === "mouse" && (
          <div className="flex items-center gap-3 px-1 mt-1 text-[11px] text-ink-dim">
            <span>Mouse Speed:</span>
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.1"
              value={sensitivity}
              onChange={(e) => setSensitivity(parseFloat(e.target.value))}
              className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-white/10 accent-accent-3"
            />
            <span className="w-6 text-right font-700 text-white">{sensitivity.toFixed(1)}x</span>
          </div>
        )}

        {/* Exit Connection Option */}
        {onDisconnect && (
          <button
            onClick={onDisconnect}
            className="btn btn-ghost text-red bg-red/5 hover:bg-red/10 h-7 text-[10px] w-full mt-0.5 border border-red/10 hover:border-red/20 rounded-lg flex items-center justify-center gap-1 transition"
          >
            <LogOut className="h-3 w-3" />
            Disconnect Companion Connection
          </button>
        )}
      </div>
    </div>
  );
}

function IconBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-lg border border-white/[0.05] bg-white/[0.02] text-ink-soft active:bg-white/[0.08] active:text-white transition"
    >
      {children}
    </button>
  );
}

function KeyBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="h-8 rounded-lg border border-white/[0.05] bg-white/[0.02] px-3.5 text-xs font-700 text-ink-soft active:bg-white/[0.08] active:text-white transition"
    >
      {children}
    </button>
  );
}
