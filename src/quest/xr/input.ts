/**
 * Meta Quest Touch Plus controller mapping for immersive WebXR.
 *
 * In an immersive session each controller is an `XRInputSource` with an
 * `xr-standard` gamepad. Verified indices (immersive-web webxr-input-profiles,
 * `meta-quest-touch-plus`):
 *   buttons[0] = trigger (analog)      buttons[1] = squeeze/grip (analog)
 *   buttons[3] = thumbstick press      buttons[4] = A (right) / X (left)
 *   buttons[5] = B (right) / Y (left)  axes[2],[3] = thumbstick x,y
 * Left controller also exposes a menu button (index 7) on this profile.
 *
 * These indices power both the pointer mapping (in session.ts) and the gamepad
 * passthrough below, which packs both controllers into one XInput bitmask +
 * axes matching src-tauri/src/remote/gamepad.rs (the virtual Xbox 360 pad).
 */

// XInput button bits — must match `vigem_client::XButtons` / companion/gamepad.ts.
export const XB = {
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

// xr-standard button indices.
export const XR_TRIGGER = 0;
export const XR_SQUEEZE = 1;
export const XR_STICK_PRESS = 3;
export const XR_BTN_A_X = 4; // A on right hand, X on left
export const XR_BTN_B_Y = 5; // B on right hand, Y on left
export const XR_MENU = 7; // left controller only
export const XR_AXIS_X = 2;
export const XR_AXIS_Y = 3;

export type PadState = {
  buttons: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lt: number;
  rt: number;
};

const DEAD = 0.06;
const dz = (v: number) => (Math.abs(v) < DEAD ? 0 : v);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function pressed(gp: Gamepad | null | undefined, i: number): boolean {
  return !!gp?.buttons?.[i]?.pressed;
}
function value(gp: Gamepad | null | undefined, i: number): number {
  return gp?.buttons?.[i]?.value ?? 0;
}
function axis(gp: Gamepad | null | undefined, i: number): number {
  return gp?.axes?.[i] ?? 0;
}

/**
 * Fold both controllers into a single XInput pad snapshot. Trigger → analog
 * trigger, squeeze → bumper, thumbstick press → thumb-click, face buttons →
 * A/B/X/Y, left menu → Start. XR stick axes are already up-negative like the web
 * Gamepad API, so flip Y to XInput's up-positive convention.
 */
export function buildPadState(left: Gamepad | null, right: Gamepad | null): PadState {
  let buttons = 0;
  if (pressed(right, XR_BTN_A_X)) buttons |= XB.A;
  if (pressed(right, XR_BTN_B_Y)) buttons |= XB.B;
  if (pressed(left, XR_BTN_A_X)) buttons |= XB.X;
  if (pressed(left, XR_BTN_B_Y)) buttons |= XB.Y;
  if (pressed(left, XR_SQUEEZE)) buttons |= XB.LB;
  if (pressed(right, XR_SQUEEZE)) buttons |= XB.RB;
  if (pressed(left, XR_STICK_PRESS)) buttons |= XB.LTHUMB;
  if (pressed(right, XR_STICK_PRESS)) buttons |= XB.RTHUMB;
  if (pressed(left, XR_MENU)) buttons |= XB.START;
  return {
    buttons,
    lx: r3(dz(axis(left, XR_AXIS_X))),
    ly: r3(-dz(axis(left, XR_AXIS_Y))),
    rx: r3(dz(axis(right, XR_AXIS_X))),
    ry: r3(-dz(axis(right, XR_AXIS_Y))),
    lt: r3(value(left, XR_TRIGGER)),
    rt: r3(value(right, XR_TRIGGER)),
  };
}
