/**
 * Physical-controller bridge for remote play.
 *
 * Reads a controller physically attached to the phone (USB/Bluetooth) through the
 * web **Gamepad API** and streams its state to the PC, where it drives a virtual
 * Xbox 360 controller (see `src-tauri/src/remote/gamepad.rs`). The standard Gamepad
 * mapping is translated here into an XInput-style button bitmask + normalized
 * axes/triggers so the Rust side stays dumb.
 *
 * States are sent only when they change, plus a low-rate heartbeat so the host's
 * idle watchdog keeps the pad plugged in while a controller sits genuinely still.
 *
 * Note: browsers only expose a gamepad after the user presses a button on it
 * (privacy gate), so the UI should tell the user to "press a button to connect".
 */
import type { ControlMsg } from "./links";

// XInput button bits — must match `vigem_client::XButtons`.
const XB = {
  UP: 0x0001,
  DOWN: 0x0002,
  LEFT: 0x0004,
  RIGHT: 0x0008,
  START: 0x0010,
  BACK: 0x0020,
  LTHUMB: 0x0040,
  RTHUMB: 0x0080,
  LB: 0x0100,
  RB: 0x0200,
  GUIDE: 0x0400,
  A: 0x1000,
  B: 0x2000,
  X: 0x4000,
  Y: 0x8000,
} as const;

// Standard-mapping button index → XInput bit. Indices 6/7 (triggers) are analog
// and handled as axes, not bits.
const BUTTON_BITS: Record<number, number> = {
  0: XB.A,
  1: XB.B,
  2: XB.X,
  3: XB.Y,
  4: XB.LB,
  5: XB.RB,
  8: XB.BACK,
  9: XB.START,
  10: XB.LTHUMB,
  11: XB.RTHUMB,
  12: XB.UP,
  13: XB.DOWN,
  14: XB.LEFT,
  15: XB.RIGHT,
  16: XB.GUIDE,
};

export interface GamepadBridgeOpts {
  /** Fired when a controller connects/disconnects (name = the pad's `id`). */
  onStatus?(connected: boolean, name: string): void;
}

/**
 * Start streaming the attached controller to `send`. Returns a stop function that
 * tears down the polling loop and listeners (it does NOT send `gamepadstop` —
 * the caller owns that so the virtual pad is released exactly once).
 */
export function startGamepadBridge(
  send: (msg: ControlMsg) => void,
  opts: GamepadBridgeOpts = {},
): () => void {
  let raf = 0;
  let alive = true;
  let lastSig = "";
  let lastSent = 0;
  let padName = "";
  let padConnected = false;

  const nav = navigator as Navigator & { getGamepads?: () => (Gamepad | null)[] };

  const pickPad = (): Gamepad | null => {
    const pads = nav.getGamepads?.() ?? [];
    let fallback: Gamepad | null = null;
    for (const p of pads) {
      if (!p) continue;
      if (p.mapping === "standard") return p; // prefer a standard-layout pad
      if (!fallback) fallback = p;
    }
    return fallback;
  };

  const setStatus = (connected: boolean, name: string) => {
    if (connected === padConnected && name === padName) return;
    padConnected = connected;
    padName = name;
    opts.onStatus?.(connected, name);
  };

  const DEAD = 0.06; // small radial deadzone; the game applies its own on top
  const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : v);
  const r3 = (n: number) => Math.round(n * 1000) / 1000; // trim JSON size

  const tick = () => {
    if (!alive) return;
    const p = pickPad();
    if (!p) {
      setStatus(false, "");
    } else {
      setStatus(true, p.id);
      let buttons = 0;
      for (const idx in BUTTON_BITS) {
        if (p.buttons[+idx]?.pressed) buttons |= BUTTON_BITS[idx];
      }
      const lt = p.buttons[6]?.value ?? 0;
      const rt = p.buttons[7]?.value ?? 0;
      // Web axes: +Y points down; XInput wants +Y up → negate the Y axes.
      const state = {
        buttons,
        lx: r3(dz(p.axes[0] ?? 0)),
        ly: r3(-dz(p.axes[1] ?? 0)),
        rx: r3(dz(p.axes[2] ?? 0)),
        ry: r3(-dz(p.axes[3] ?? 0)),
        lt: r3(lt),
        rt: r3(rt),
      };
      const sig = JSON.stringify(state);
      const now = performance.now();
      // Send on any change, plus a ~500ms heartbeat (host watchdog releases the
      // pad after 1.5s of silence, so a still-but-connected controller must ping).
      if (sig !== lastSig || now - lastSent > 500) {
        lastSig = sig;
        lastSent = now;
        send({ type: "gamepad", ...state });
      }
    }
    raf = requestAnimationFrame(tick);
  };

  const onConnect = (e: Event) => setStatus(true, (e as GamepadEvent).gamepad?.id ?? "");
  const onDisconnect = () => {
    if (!pickPad()) setStatus(false, "");
  };
  window.addEventListener("gamepadconnected", onConnect);
  window.addEventListener("gamepaddisconnected", onDisconnect);
  raf = requestAnimationFrame(tick);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("gamepadconnected", onConnect);
    window.removeEventListener("gamepaddisconnected", onDisconnect);
  };
}
