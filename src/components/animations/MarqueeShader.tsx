import { useEffect, useRef } from "react";
import { useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

/* A self-contained WebGL plasma overlay used by the "shader" marquee variant —
   a flowing aurora of the accent palette, blended over the art wall. Falls back
   to nothing when WebGL is unavailable or reduced-motion is on. */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 uv = vUv;
  float t = uTime * 0.25;
  float a = sin(uv.x * 6.0 + t) + sin(uv.y * 5.0 - t * 1.2) + sin((uv.x + uv.y) * 4.0 + t * 0.7);
  float b = cos(uv.y * 8.0 + t * 1.3) + sin(uv.x * 3.0 - t);
  float m = (a + b) * 0.18 + 0.5;
  vec3 violet = vec3(0.49, 0.33, 1.0);
  vec3 cyan = vec3(0.13, 0.83, 0.96);
  vec3 green = vec3(0.20, 0.86, 0.60);
  vec3 col = mix(violet, cyan, smoothstep(0.0, 0.6, m));
  col = mix(col, green, smoothstep(0.6, 1.0, m) * 0.5);
  float vignette = 1.0 - smoothstep(0.4, 1.2, distance(uv, vec2(0.5)));
  gl_FragColor = vec4(col, (0.10 + 0.12 * m) * vignette);
}`;

export function MarqueeShader({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const enabled = useMotionEnabled();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !enabled) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uTime = gl.getUniformLocation(prog, "uTime");

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 1 || h < 1) return;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(uTime, (now - t0) / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
    };
  }, [enabled]);

  return <canvas ref={ref} className={cn("pointer-events-none absolute inset-0 h-full w-full mix-blend-screen", className)} aria-hidden />;
}
