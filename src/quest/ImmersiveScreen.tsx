/**
 * Immersive-VR overlay. Owns an ImmersiveSession (WebGL big screen + controller
 * rays) and translates its high-level events into remote-control messages on the
 * link. Rendered on top of the flat page while a session is live; the flat DOM
 * stays mounted underneath because the Quest system keyboard requires the focused
 * <input> to be a real, on-screen DOM node.
 */

import { useEffect, useRef, useState } from "react";
import type { RemoteLink, ControlMsg } from "@/companion/links";
import { ImmersiveSession, type PointerAction } from "./xr/session";
import { TextDiffSender } from "./textDiff";

const MOVE_THROTTLE_MS = 14; // ~70 Hz cursor updates to the PC

export function ImmersiveScreen({
  link,
  stream,
  mode,
  onExit,
}: {
  link: RemoteLink;
  stream: MediaStream | null;
  mode: "pointer" | "gamepad";
  onExit: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const kbdRef = useRef<HTMLInputElement | null>(null);
  const sessionRef = useRef<ImmersiveSession | null>(null);
  const startedRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const [error, setError] = useState<string | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const diff = useRef(new TextDiffSender((m) => link.send(m)));
  const lastMove = useRef(0);
  const scrollAcc = useRef({ x: 0, y: 0 });

  const send = (m: ControlMsg) => link.send(m);

  const openKeyboard = () => {
    const el = kbdRef.current;
    if (!el) return;
    // Each Quest keyboard session overwrites the whole value, so clear first.
    diff.current.reset(el);
    setKeyboardOpen(true);
    // focus() inside the session raises the system keyboard (browser 26.1+).
    window.setTimeout(() => el.focus(), 20);
  };

  const handleAction = (action: PointerAction) => {
    switch (action) {
      case "leftdown":
        send({ type: "down", button: "left" });
        break;
      case "leftup":
        send({ type: "up", button: "left" });
        break;
      case "rightclick":
        send({ type: "click", button: "right" });
        break;
      case "middleclick":
        send({ type: "click", button: "middle" });
        break;
      case "enter":
        send({ type: "key", name: "enter" });
        break;
      case "keyboard":
        openKeyboard();
        break;
      case "recenter":
        break; // handled inside the session
      case "exit":
        break; // session end fires onExit
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
    if (stream) video.srcObject = stream;
    videoRef.current = video;
    video.play?.().catch(() => {});

    const session = new ImmersiveSession(video, () => modeRef.current, {
      onPointer: (u, v) => {
        const now = performance.now();
        if (now - lastMove.current < MOVE_THROTTLE_MS) return;
        lastMove.current = now;
        send({ type: "move", x: u, y: v });
      },
      onAction: handleAction,
      onScroll: (dx, dy) => {
        const acc = scrollAcc.current;
        acc.x += dx;
        acc.y += dy;
        const ny = Math.trunc(acc.y);
        const nx = Math.trunc(acc.x);
        if (ny !== 0 || nx !== 0) {
          acc.x -= nx;
          acc.y -= ny;
          send({ type: "scroll", dx: nx, dy: ny });
        }
      },
      onGamepad: (state) => send({ type: "gamepad", ...state }),
      onEnd: () => {
        // Release any held virtual pad + mouse button on exit.
        if (modeRef.current === "gamepad") send({ type: "gamepadstop" });
        onExit();
      },
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
    sessionRef.current = session;

    session.start().catch((e) => {
      startedRef.current = false;
      setError(e instanceof Error ? e.message : "Couldn't start VR.");
    });

    return () => {
      void session.end();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the immersive video fed if the stream arrives after mount.
  useEffect(() => {
    const v = videoRef.current;
    if (v && stream && v.srcObject !== stream) {
      v.srcObject = stream;
      v.play?.().catch(() => {});
    }
  }, [stream]);

  // Mirror host cursor kind onto the VR hit marker (text beam, hand, resize…).
  useEffect(() => {
    const unsub = link.onEvent((e) => {
      if (e.event === "cursor") {
        sessionRef.current?.setCursorKind(String((e as { kind?: string }).kind || "arrow"));
      }
    });
    return () => unsub?.();
  }, [link]);

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-bg-base/95 text-ink">
      <div className="max-w-md px-8 text-center">
        <h2 className="font-display text-2xl font-800">You're in VR</h2>
        <p className="mt-2 text-ink-dim">
          Put on your headset. Point at the screen and pull the <b>trigger</b> to click, hold for right-click, and push the{" "}
          <b>thumbstick</b> to scroll.
        </p>
        <ul className="mx-auto mt-4 max-w-xs space-y-1.5 text-left text-sm text-ink-dim">
          <li>
            <b>A</b> — open keyboard · <b>B</b> — Enter
          </li>
          <li>
            <b>X</b> / left stick — recenter screen
          </li>
          <li>
            <b>Y</b> or hold both grips — exit VR
          </li>
          {mode === "gamepad" && <li className="text-accent-3">Gamepad mode: both controllers drive a virtual Xbox pad.</li>}
        </ul>
        {keyboardOpen && <p className="mt-4 text-sm text-accent-3">Keyboard open — type on the headset keyboard.</p>}
        {error && <p className="mt-4 rounded-xl border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">{error}</p>}
        <button className="btn btn-subtle mt-6 h-11 px-5" onClick={() => void sessionRef.current?.end()}>
          Exit VR
        </button>
      </div>

      {/* On-screen DOM input the Quest system keyboard writes into. Must stay in
          the DOM and on-screen (not display:none / off-screen) per Meta's docs. */}
      <input
        ref={kbdRef}
        className="fixed left-1/2 top-3 h-9 w-48 -translate-x-1/2 rounded bg-bg-800/80 px-2 text-center text-ink"
        style={{ opacity: keyboardOpen ? 0.2 : 0.01 }}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-label="VR keyboard input"
        onInput={() => diff.current.flush(kbdRef.current)}
        onBlur={() => setKeyboardOpen(false)}
      />
    </div>
  );
}
