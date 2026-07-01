import { useCallback, useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { remoteWsUrl } from "@/lib/remoteClient";

type ControlMsg =
  | { type: "move"; x: number; y: number }
  | { type: "down"; button?: string }
  | { type: "up"; button?: string }
  | { type: "scroll"; dy: number }
  | { type: "text"; value: string }
  | { type: "key"; name: string };

export function ControlScreen() {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const screenWs = useRef<WebSocket | null>(null);
  const controlWs = useRef<WebSocket | null>(null);
  const lastUrl = useRef<string | null>(null);
  const dragging = useRef(false);
  const lastMove = useRef(0);
  const kbdRef = useRef<HTMLInputElement | null>(null);

  const [connected, setConnected] = useState(false);
  const [button, setButton] = useState<"left" | "right">("left");
  const [kbdOpen, setKbdOpen] = useState(false);

  const send = useCallback((msg: ControlMsg) => {
    const ws = controlWs.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Screen stream: render incoming JPEG frames into the <img>.
  useEffect(() => {
    let alive = true;
    let retry: number | undefined;

    const connectScreen = () => {
      if (!alive) return;
      const ws = new WebSocket(remoteWsUrl("/screen"));
      ws.binaryType = "arraybuffer";
      screenWs.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer) || !imgRef.current) return;
        const url = URL.createObjectURL(new Blob([ev.data], { type: "image/jpeg" }));
        imgRef.current.src = url;
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = url;
      };
      ws.onclose = () => {
        setConnected(false);
        if (alive) retry = window.setTimeout(connectScreen, 1500);
      };
      ws.onerror = () => ws.close();
    };

    const connectControl = () => {
      if (!alive) return;
      const ws = new WebSocket(remoteWsUrl("/control"));
      controlWs.current = ws;
      ws.onclose = () => {
        if (alive) window.setTimeout(connectControl, 1500);
      };
      ws.onerror = () => ws.close();
    };

    connectScreen();
    connectControl();
    return () => {
      alive = false;
      if (retry) window.clearTimeout(retry);
      screenWs.current?.close();
      controlWs.current?.close();
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    };
  }, []);

  // Map a pointer event to normalized 0..1 coords inside the letterboxed image.
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

  const onPointerDown = (e: React.PointerEvent) => {
    const n = normFromEvent(e.clientX, e.clientY);
    if (!n) return;
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    send({ type: "move", x: n.x, y: n.y });
    send({ type: "down", button });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const t = performance.now();
    if (t - lastMove.current < 25) return;
    lastMove.current = t;
    const n = normFromEvent(e.clientX, e.clientY);
    if (n) send({ type: "move", x: n.x, y: n.y });
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    send({ type: "up", button });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const k = e.key;
    if (k.length === 1) {
      send({ type: "text", value: k });
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
      if (name) send({ type: "key", name });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          {connected ? (
            <span className="flex items-center gap-1.5 text-green">
              <span className="h-2 w-2 rounded-full bg-green" style={{ boxShadow: "0 0 8px #34d399" }} /> Live
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-ink-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…
            </span>
          )}
        </div>
        <button
          onClick={() => setButton((b) => (b === "left" ? "right" : "left"))}
          className="btn btn-ghost h-8"
        >
          {button === "left" ? <MousePointer2 className="h-4 w-4" /> : <MousePointerClick className="h-4 w-4" />}
          {button === "left" ? "Left" : "Right"} button
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden bg-black">
        <img
          ref={imgRef}
          alt="Remote screen"
          className="h-full w-full touch-none select-none object-contain"
          draggable={false}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => send({ type: "scroll", dy: e.deltaY > 0 ? 3 : -3 })}
        />
        {/* Scroll controls */}
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 flex-col gap-2">
          <IconBtn onClick={() => send({ type: "scroll", dy: -3 })}><ChevronUp className="h-5 w-5" /></IconBtn>
          <IconBtn onClick={() => send({ type: "scroll", dy: 3 })}><ChevronDown className="h-5 w-5" /></IconBtn>
        </div>
      </div>

      {/* Keyboard toolbar */}
      <div className="border-t border-line bg-bg-900/70 p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <IconBtn onClick={() => { setKbdOpen(true); kbdRef.current?.focus(); }}><Keyboard className="h-4 w-4" /></IconBtn>
          <KeyBtn onClick={() => send({ type: "key", name: "escape" })}>Esc</KeyBtn>
          <KeyBtn onClick={() => send({ type: "key", name: "tab" })}>Tab</KeyBtn>
          <IconBtn onClick={() => send({ type: "key", name: "enter" })}><CornerDownLeft className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => send({ type: "key", name: "backspace" })}><Delete className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => send({ type: "key", name: "left" })}><ArrowLeft className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => send({ type: "key", name: "up" })}><ArrowUp className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => send({ type: "key", name: "down" })}><ArrowDown className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => send({ type: "key", name: "right" })}><ArrowRight className="h-4 w-4" /></IconBtn>
        </div>
        {/* Hidden input to capture hardware/soft keyboard typing */}
        <input
          ref={kbdRef}
          value=""
          onChange={() => {}}
          onKeyDown={onKeyDown}
          onBlur={() => setKbdOpen(false)}
          className={`mt-2 w-full rounded-lg border border-line bg-white/[0.03] px-3 py-2 text-sm outline-none ${kbdOpen ? "" : "hidden"}`}
          placeholder="Type here — keys are sent to your PC"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
    </div>
  );
}

function IconBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-white/[0.04] text-ink-soft active:bg-white/[0.1]"
    >
      {children}
    </button>
  );
}
function KeyBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="h-9 rounded-lg border border-line bg-white/[0.04] px-3 text-sm font-700 text-ink-soft active:bg-white/[0.1]"
    >
      {children}
    </button>
  );
}
