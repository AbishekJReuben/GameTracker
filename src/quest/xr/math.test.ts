import { describe, it, expect } from "vitest";
import { quadAxes, rayQuad, rayFromMatrix, mat4Multiply, type Vec3 } from "./math";
import { buildPadState, XB } from "./input";

// The screen the immersive renderer places by default.
const CENTER: Vec3 = [0, 1.5, -2.3];
const YAW = 0;
const W = 3.2;
const H = 1.8;

describe("quadAxes", () => {
  it("faces +Z (toward a user at the origin) at yaw 0", () => {
    const { right, up, normal } = quadAxes(0);
    expect(right).toEqual([1, 0, -0]);
    expect(up).toEqual([0, 1, 0]);
    expect(normal[0]).toBeCloseTo(0);
    expect(normal[2]).toBeCloseTo(1);
  });
});

describe("rayQuad", () => {
  it("hits dead-center from straight ahead", () => {
    const hit = rayQuad([0, 1.5, 0], [0, 0, -1], CENTER, YAW, W, H);
    expect(hit).not.toBeNull();
    expect(hit!.u).toBeCloseTo(0.5, 5);
    expect(hit!.v).toBeCloseTo(0.5, 5);
    expect(hit!.distance).toBeCloseTo(2.3, 5);
  });

  it("maps a rightward aim to u>0.5 and an upward aim to v>0.5", () => {
    // Aim from the origin toward a point right & up of center, on the z=-2.3 plane.
    const target: Vec3 = [0.8, 1.5 + 0.45, -2.3];
    const dir: Vec3 = [target[0], target[1] - 1.5, target[2]];
    const hit = rayQuad([0, 1.5, 0], dir, CENTER, YAW, W, H);
    expect(hit).not.toBeNull();
    // 0.8 of half-width 1.6 → +0.5 from center → u = 0.75.
    expect(hit!.u).toBeCloseTo(0.5 + 0.8 / W, 4);
    // +0.45 of half-height 0.9 → +0.5 → v = 0.75 (v is up-positive here).
    expect(hit!.v).toBeCloseTo(0.5 + 0.45 / H, 4);
  });

  it("misses when the ray points away from the screen", () => {
    expect(rayQuad([0, 1.5, 0], [0, 0, 1], CENTER, YAW, W, H)).toBeNull();
  });

  it("misses when the aim falls outside the panel", () => {
    // Far to the right of the 1.6m half-width.
    const dir: Vec3 = [5, 0, -2.3];
    expect(rayQuad([0, 1.5, 0], dir, CENTER, YAW, W, H)).toBeNull();
  });

  it("respects a yawed screen (rotated 90° to the user's right)", () => {
    // Screen centered to the right (+X), rotated to face -X back at the user.
    const c: Vec3 = [2.3, 1.5, 0];
    const hit = rayQuad([0, 1.5, 0], [1, 0, 0], c, Math.PI / 2, W, H);
    expect(hit).not.toBeNull();
    expect(hit!.u).toBeCloseTo(0.5, 5);
    expect(hit!.v).toBeCloseTo(0.5, 5);
  });
});

describe("rayFromMatrix", () => {
  it("reads origin from translation and forward from -Z of the transform", () => {
    // Identity transform sits at the origin looking down -Z.
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const { origin, dir } = rayFromMatrix(identity);
    expect(origin).toEqual([0, 0, 0]);
    expect(dir[0]).toBeCloseTo(0);
    expect(dir[1]).toBeCloseTo(0);
    expect(dir[2]).toBeCloseTo(-1);
  });
});

describe("mat4Multiply", () => {
  it("multiplying by identity is a no-op", () => {
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const a = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
    const out = mat4Multiply(new Float32Array(16), a, identity);
    expect(Array.from(out)).toEqual(Array.from(a));
  });
});

// A minimal fake of the xr-standard gamepad for the pad-mapping test.
function fakePad(pressed: number[], axes: number[] = [0, 0, 0, 0], values: Record<number, number> = {}): Gamepad {
  const buttons = Array.from({ length: 8 }, (_, i) => ({
    pressed: pressed.includes(i),
    touched: false,
    value: values[i] ?? (pressed.includes(i) ? 1 : 0),
  }));
  return { axes, buttons, connected: true, id: "fake", index: 0, mapping: "xr-standard", timestamp: 0, hapticActuators: [], vibrationActuator: null } as unknown as Gamepad;
}

describe("buildPadState (Touch Plus → XInput)", () => {
  it("maps right A/B and left X/Y to the right XInput bits", () => {
    const right = fakePad([4, 5]); // A + B
    const left = fakePad([4, 5]); // X + Y
    const s = buildPadState(left, right);
    expect(s.buttons & XB.A).toBeTruthy();
    expect(s.buttons & XB.B).toBeTruthy();
    expect(s.buttons & XB.X).toBeTruthy();
    expect(s.buttons & XB.Y).toBeTruthy();
  });

  it("maps grips to bumpers, stick clicks to thumb buttons, triggers to analog", () => {
    const left = fakePad([1, 3], [0, 0, 0, 0], { 0: 0.5 }); // squeeze + stick-press, trigger 0.5
    const right = fakePad([1, 3], [0, 0, 0, 0], { 0: 1 });
    const s = buildPadState(left, right);
    expect(s.buttons & XB.LB).toBeTruthy();
    expect(s.buttons & XB.RB).toBeTruthy();
    expect(s.buttons & XB.LTHUMB).toBeTruthy();
    expect(s.buttons & XB.RTHUMB).toBeTruthy();
    expect(s.lt).toBeCloseTo(0.5);
    expect(s.rt).toBeCloseTo(1);
  });

  it("flips stick Y to XInput up-positive and applies a deadzone", () => {
    // xr-standard thumbstick lives at axes[2],[3].
    const left = fakePad([], [0, 0, 0.9, -0.8]); // push up (web -Y) → XInput +Y
    const right = fakePad([], [0, 0, 0.02, 0.02]); // inside deadzone → 0
    const s = buildPadState(left, right);
    expect(s.lx).toBeCloseTo(0.9);
    expect(s.ly).toBeCloseTo(0.8);
    expect(s.rx).toBeCloseTo(0);
    expect(s.ry).toBeCloseTo(0);
  });
});
