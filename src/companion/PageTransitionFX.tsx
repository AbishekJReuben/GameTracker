import { useEffect, useRef, useState } from "react";
import { useMotionEnabled, useReduceEffects } from "@/store/app";

/**
 * Companion port of the desktop `PageTransitionFX` — the WebGL "energy tear"
 * glitch sweep that masks a screen swap. Fires whenever `triggerKey` changes
 * (the active tab), since the phone app has no router.
 *
 * MOBILE SAFETY: unlike the desktop version (which keeps one persistent WebGL
 * context alive the whole session), the phone WebView has a tiny live-context
 * budget and blanks the entire webview when it's exhausted. So the canvas — and
 * its GL context — is mounted ONLY for the ~0.72s of an active sweep and torn
 * down immediately after, leaving zero persistent contexts between transitions.
 * The overlay is `pointer-events:none`, self-clears, and bails on context loss.
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

const DURATION = 720;

/** One transition: mounts a canvas, runs the GL sweep once, then the parent
 *  unmounts it (freeing the context). Never throws — WebGL failures just no-op. */
function Sweep({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      onDone();
      return;
    }

    let lost = false;
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
    };
    canvas.addEventListener("webglcontextlost", onLost as EventListener, false);

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false, failIfMajorPerformanceCaveat: false });
    } catch {
      gl = null;
    }
    if (!gl) {
      canvas.removeEventListener("webglcontextlost", onLost as EventListener);
      onDone();
      return;
    }

    let raf = 0;
    let prog: WebGLProgram | null = null;
    let buf: WebGLBuffer | null = null;
    let doneCalled = false;
    const finish = () => {
      if (doneCalled) return;
      doneCalled = true;
      onDone();
    };

    try {
      // Cap at DPR 1 on the phone — the sweep is brief and full-screen, so extra
      // pixels buy nothing and cost GPU memory (part of what tipped the webview over).
      const dpr = 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 1 || h < 1) {
        finish();
        return;
      }
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);

      const compile = (type: number, src: string) => {
        const s = gl!.createShader(type)!;
        gl!.shaderSource(s, src);
        gl!.compileShader(s);
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog!, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog!, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog!);
      gl.useProgram(prog!);

      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog!, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      const uProgress = gl.getUniformLocation(prog!, "uProgress");
      const uTime = gl.getUniformLocation(prog!, "uTime");
      const uDir = gl.getUniformLocation(prog!, "uDir");
      const uSeed = gl.getUniformLocation(prog!, "uSeed");

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      const dir = Math.random() > 0.5 ? 1 : -1;
      const seed = Math.random() * 100;
      const start = performance.now();

      const tick = (now: number) => {
        if (lost || !gl) {
          finish();
          return;
        }
        const p = Math.min(1, (now - start) / DURATION);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uProgress, p);
        gl.uniform1f(uTime, (now - start) / 1000);
        gl.uniform1f(uDir, dir);
        gl.uniform1f(uSeed, seed);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (p < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          finish();
        }
      };
      raf = requestAnimationFrame(tick);
    } catch {
      finish();
    }

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", onLost as EventListener);
      try {
        if (gl) {
          if (prog) gl.deleteProgram(prog);
          if (buf) gl.deleteBuffer(buf);
          // Proactively drop the GPU context so it isn't held until GC.
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        }
      } catch {
        /* ignore teardown races */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 z-40 h-full w-full mix-blend-screen" />;
}

export function PageTransitionFX({ triggerKey }: { triggerKey: string }) {
  const reduce = useReduceEffects();
  const enabled = useMotionEnabled() && !reduce;
  const firstRef = useRef(true);
  // A monotonically-increasing id identifies the current sweep; null = idle (no
  // canvas / no GL context mounted). Bumped on each tab change after the first.
  const [sweepId, setSweepId] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      firstRef.current = true;
      return;
    }
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    setSweepId((n) => (n ?? 0) + 1);
  }, [triggerKey, enabled]);

  if (!enabled || sweepId == null) return null;
  return <Sweep key={sweepId} onDone={() => setSweepId(null)} />;
}
