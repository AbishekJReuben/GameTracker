import { useEffect, useRef } from "react";
import { useMotionEnabled, useReduceEffects } from "@/store/app";

/**
 * Companion port of the desktop `components/animations/PageTransitionFX` — the
 * WebGL "energy tear" glitch sweep that masks a screen swap. The desktop version
 * fires on react-router `useLocation()` changes; the phone app has no router, so
 * this variant fires whenever the `triggerKey` prop changes (i.e. the active tab).
 *
 * Same safety contract: a purely additive, `pointer-events:none` overlay that
 * self-clears to fully transparent at the end of every ~0.7s sweep, so it can
 * never obscure content and costs nothing while idle. Disabled under reduced motion.
 */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
uniform float uProgress;
uniform float uTime;
uniform float uDir;
uniform float uSeed;
varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float hash11(float x) { return fract(sin(x * 127.1 + uSeed) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 uv = vUv;
  float ax = uDir > 0.0 ? uv.y : 1.0 - uv.y;
  ax = ax * 0.82 + uv.x * 0.18;

  float prog = clamp(uProgress, 0.0, 1.0);
  float env = sin(prog * 3.14159265);

  float edge = mix(-0.2, 1.2, prog);
  float dist = ax - edge;

  float row = floor(uv.y * 46.0);
  float t = floor(uTime * 36.0);
  float jitter = hash11(row + t) - 0.5;
  float glitchOn = step(0.72, hash21(vec2(row, t)));

  float line = smoothstep(0.06, 0.0, abs(dist));
  float body = smoothstep(0.0, -0.32, dist);

  vec3 violet = vec3(0.52, 0.32, 1.0);
  vec3 cyan = vec3(0.20, 0.86, 1.0);
  vec3 col = mix(violet, cyan, clamp(uv.y + jitter * glitchOn * 0.24, 0.0, 1.0));
  col += line * vec3(0.6, 0.85, 1.0);

  float grain = vnoise(uv * vec2(50.0, 90.0) + vec2(0.0, uTime * 2.0));
  float alpha = env * (body * 0.30 + line * 0.72 + glitchOn * abs(jitter) * 0.38);
  alpha += env * grain * body * 0.08;
  alpha *= 0.85 + 0.15 * sin((uv.y + uTime) * 140.0);
  alpha = clamp(alpha, 0.0, 0.7);

  gl_FragColor = vec4(col, alpha);
}`;

interface GLState {
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  uProgress: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uDir: WebGLUniformLocation | null;
  uSeed: WebGLUniformLocation | null;
}

const DURATION = 720;

export function PageTransitionFX({ triggerKey }: { triggerKey: string }) {
  const reduce = useReduceEffects();
  const enabled = useMotionEnabled() && !reduce;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GLState | null>(null);
  const rafRef = useRef(0);
  const firstRef = useRef(true);

  // One-time WebGL setup. Re-runs only when motion is toggled.
  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    stateRef.current = {
      gl,
      prog,
      uProgress: gl.getUniformLocation(prog, "uProgress"),
      uTime: gl.getUniformLocation(prog, "uTime"),
      uDir: gl.getUniformLocation(prog, "uDir"),
      uSeed: gl.getUniformLocation(prog, "uSeed"),
    };

    return () => {
      cancelAnimationFrame(rafRef.current);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      stateRef.current = null;
    };
  }, [enabled]);

  // Fire a sweep on every trigger change (but never on the first render).
  useEffect(() => {
    if (!enabled) {
      firstRef.current = true;
      return;
    }
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const st = stateRef.current;
    const canvas = canvasRef.current;
    if (!st || !canvas) return;

    cancelAnimationFrame(rafRef.current);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 1 || h < 1) return;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);

    const { gl, prog } = st;
    const dir = Math.random() > 0.5 ? 1 : -1;
    const seed = Math.random() * 100;
    const start = performance.now();

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniform1f(st.uProgress, p);
      gl.uniform1f(st.uTime, (now - start) / 1000);
      gl.uniform1f(st.uDir, dir);
      gl.uniform1f(st.uSeed, seed);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [triggerKey, enabled]);

  if (!enabled) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-40 h-full w-full mix-blend-screen"
    />
  );
}
