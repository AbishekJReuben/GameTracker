/**
 * Minimal column-major mat4 / vec3 helpers for the immersive renderer — enough
 * to place a few quads and intersect controller rays, without pulling in a 3D
 * engine. All matrices are Float32Array(16) in WebGL column-major order,
 * matching what WebXR hands us (XRView.projectionMatrix, XRRigidTransform.matrix).
 */

export type Vec3 = [number, number, number];

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}
export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** out = a * b (column-major 4x4). Safe when out aliases neither input. */
export function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/**
 * Model matrix for an upright quad: translate to `center`, rotate around Y by
 * `yaw`, scale by (w, h, 1). Unit quad vertices are (-0.5..0.5) in XY with
 * normal +Z; after RotY(yaw) the normal points at (sin yaw, 0, cos yaw).
 */
export function quadModel(out: Float32Array, center: Vec3, yaw: number, w: number, h: number): Float32Array {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // column 0: right axis * w
  out[0] = c * w; out[1] = 0; out[2] = -s * w; out[3] = 0;
  // column 1: up axis * h
  out[4] = 0; out[5] = h; out[6] = 0; out[7] = 0;
  // column 2: normal
  out[8] = s; out[9] = 0; out[10] = c; out[11] = 0;
  // column 3: translation
  out[12] = center[0]; out[13] = center[1]; out[14] = center[2]; out[15] = 1;
  return out;
}

/** Basis vectors of a yaw-only quad (see quadModel). */
export function quadAxes(yaw: number): { right: Vec3; up: Vec3; normal: Vec3 } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { right: [c, 0, -s], up: [0, 1, 0], normal: [s, 0, c] };
}

export type QuadHit = { u: number; v: number; point: Vec3; distance: number };

/**
 * Intersect a ray with an upright quad (center/yaw/size as in quadModel).
 * Returns uv in 0..1 (u right, v up) or null when the ray misses the plane,
 * points away, or lands outside the rect (unless `unclamped`).
 */
export function rayQuad(
  origin: Vec3,
  dir: Vec3,
  center: Vec3,
  yaw: number,
  w: number,
  h: number,
  unclamped = false,
): QuadHit | null {
  const { right, up, normal } = quadAxes(yaw);
  const denom = dot(dir, normal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = dot(sub(center, origin), normal) / denom;
  if (t <= 0) return null;
  const point = add(origin, scale(dir, t));
  const local = sub(point, center);
  const u = dot(local, right) / w + 0.5;
  const v = dot(local, up) / h + 0.5;
  if (!unclamped && (u < 0 || u > 1 || v < 0 || v > 1)) return null;
  return { u, v, point, distance: t };
}

/** Ray origin + forward (-Z) direction from an XRRigidTransform matrix. */
export function rayFromMatrix(m: Float32Array): { origin: Vec3; dir: Vec3 } {
  return {
    origin: [m[12], m[13], m[14]],
    dir: normalize([-m[8], -m[9], -m[10]]),
  };
}
