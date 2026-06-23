import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { HeroSlide } from "@/lib/heroSlides";
import { useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

void main() {
  vec2 uv = vUv;
  float t = uTime * 0.35;
  float n = noise(uv * 5.0 + vec2(t * 0.4, -t * 0.25));
  float wave = sin(uv.x * 9.0 + t) * 0.025 + sin(uv.y * 7.0 - t * 1.1) * 0.02;
  vec3 violet = vec3(0.48, 0.32, 1.0);
  vec3 cyan = vec3(0.18, 0.78, 0.95);
  vec3 col = mix(violet, cyan, smoothstep(0.1, 0.95, uv.y + wave + n * 0.12));
  float scan = sin((uv.y + t * 0.5) * 120.0) * 0.015;
  float vignette = 1.0 - smoothstep(0.35, 1.1, distance(uv, vec2(0.5)));
  float alpha = (0.22 + n * 0.12 + scan) * vignette;
  gl_FragColor = vec4(col, alpha);
}`;

function useShaderOverlay(active: boolean) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const enabled = useMotionEnabled();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active || !enabled) return;

    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
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

    const uTime = gl.getUniformLocation(prog, "uTime");
    const uRes = gl.getUniformLocation(prog, "uResolution");

    let raf = 0;
    const t0 = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(uTime, t);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, [active, enabled]);

  return canvasRef;
}

const INTERVAL_MS = 5500;

export function ShaderSlideshow({
  slides,
  className,
  dimmed = false,
}: {
  slides: HeroSlide[];
  className?: string;
  dimmed?: boolean;
}) {
  const enabled = useMotionEnabled();
  const [index, setIndex] = useState(0);
  const canvasRef = useShaderOverlay(slides.length > 0);

  const slideKey = slides.map((s) => s.id).join("|");

  useEffect(() => {
    if (slides.length <= 1) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % slides.length), INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [slides.length]);

  useEffect(() => {
    setIndex(0);
  }, [slideKey]);

  if (slides.length === 0) return null;

  const current = slides[index]!;

  return (
    <div
      className={cn(
        "relative min-h-[140px] overflow-hidden rounded-2xl border border-line/50 bg-bg-900/80 shadow-card transition-opacity",
        dimmed && "opacity-40",
        className
      )}
      aria-label="Game showcase slideshow"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={current.id + index}
          className="absolute inset-0"
          initial={enabled ? { opacity: 0, scale: 1.08 } : false}
          animate={{ opacity: 1, scale: 1 }}
          exit={enabled ? { opacity: 0, scale: 1.02 } : undefined}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.img
            src={current.imageUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
            animate={enabled ? { scale: [1, 1.07] } : undefined}
            transition={{ duration: INTERVAL_MS / 1000, ease: "linear" }}
          />
        </motion.div>
      </AnimatePresence>

      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full mix-blend-screen" />

      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg-base via-bg-base/20 to-transparent" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-bg-base/50 via-transparent to-transparent" />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
        <motion.p
          key={current.name}
          className="truncate font-display text-sm font-800 text-ink"
          initial={enabled ? { opacity: 0, y: 6 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
        >
          {current.name}
        </motion.p>
        {slides.length > 1 && (
          <div className="mt-2 flex gap-1">
            {slides.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  "h-1 rounded-full transition-all",
                  i === index ? "w-4 bg-accent-sheen" : "w-1.5 bg-white/25"
                )}
              />
            ))}
          </div>
        )}
      </div>

      {enabled && (
        <motion.div
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-white/[0.03] to-transparent"
          animate={{ y: ["-100%", "200%"] }}
          transition={{ duration: 4.5, repeat: Infinity, ease: "linear" }}
        />
      )}
    </div>
  );
}
