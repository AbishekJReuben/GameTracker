import { useEffect, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MarqueeShader } from "./MarqueeShader";
import { useMotionEnabled } from "@/store/app";
import { cn } from "@/lib/cn";
import { useDocumentVisible, useInView } from "@/lib/useVisible";

/**
 * A premium showcase that cross-dissolves through a set of game images using
 * real GPU transition shaders — dissolve, displacement warp, diagonal light
 * sweep, and a 3D push/zoom — with a glowing accent edge at the transition
 * front. Because the Tauri asset protocol can taint WebGL textures (and WebGL
 * is not always present), it transparently falls back to an equally-pretty DOM
 * crossfade with a procedural light-shader overlay, so it never breaks.
 */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
uniform float uTime;
uniform int uMode;
uniform vec2 uRes;
uniform vec2 uFromRes;
uniform vec2 uToRes;
varying vec2 vUv;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  float a = hash(i), b = hash(i+vec2(1.0,0.0)), c = hash(i+vec2(0.0,1.0)), d = hash(i+vec2(1.0,1.0));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}
// Map canvas uv to a texture uv with object-fit:cover (no distortion).
vec2 coverUV(vec2 uv, vec2 res, vec2 img){
  float scale = max(res.x/img.x, res.y/img.y);
  vec2 size = img*scale;
  vec2 offset = (res - size)*0.5;
  return (uv*res - offset)/size;
}

void main(){
  vec2 uv = vUv;
  vec2 uvF = coverUV(uv, uRes, uFromRes);
  vec2 uvT = coverUV(uv, uRes, uToRes);
  float p = uProgress;
  vec3 col; float edge = 0.0;

  if(uMode == 0){
    // Dissolve: a noise field crosses the threshold p, with a glowing front.
    float n = noise(uv * vec2(uRes.x/uRes.y, 1.0) * 9.0 + 7.0);
    float reveal = 1.0 - smoothstep(p - 0.07, p + 0.07, n);
    col = mix(texture2D(uFrom, uvF).rgb, texture2D(uTo, uvT).rgb, reveal);
    edge = exp(-pow((n - p) * 9.0, 2.0)) * sin(p * 3.14159);
  } else if(uMode == 1){
    // Displacement warp: the two frames push through a turbulent field.
    float d = noise(uv * 5.0 + uTime * 0.12);
    vec2 disp = (vec2(d) - 0.5) * 0.28 * sin(p * 3.14159);
    vec3 a = texture2D(uFrom, uvF + disp * p).rgb;
    vec3 b = texture2D(uTo, uvT - disp * (1.0 - p)).rgb;
    col = mix(a, b, smoothstep(0.3, 0.7, p));
  } else if(uMode == 2){
    // Diagonal light-sweep wipe with a bright accent edge.
    float wipe = (uv.x + (1.0 - uv.y)) * 0.5;
    float m = smoothstep(p - 0.04, p + 0.04, wipe);
    col = mix(texture2D(uTo, uvT).rgb, texture2D(uFrom, uvF).rgb, m);
    edge = exp(-pow((wipe - p) * 16.0, 2.0));
  } else {
    // 3D push/zoom: outgoing frame zooms out, incoming zooms in.
    vec2 cf = (uvF - 0.5) * (1.0 + 0.32 * p) + 0.5;
    vec2 ct = (uvT - 0.5) * (1.32 - 0.32 * p) + 0.5;
    vec3 a = texture2D(uFrom, cf).rgb;
    vec3 b = texture2D(uTo, ct).rgb;
    col = mix(a, b, smoothstep(0.2, 0.8, p));
  }

  col += vec3(0.49, 0.33, 1.0) * clamp(edge, 0.0, 1.0) * 0.7;
  gl_FragColor = vec4(col, 1.0);
}`;

const HOLD_MS = 4200;
const TRANS_MS = 1400;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The GPU path. Returns `false` via `onDegrade` if it can't run. */
function useGlTransition(canvasRef: RefObject<HTMLCanvasElement | null>, urls: string[], active: boolean, onDegrade: () => void) {
  const enabled = useMotionEnabled();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active || !enabled) return;
    const gl = canvas.getContext("webgl", { alpha: false, premultipliedAlpha: false });
    if (!gl) {
      onDegrade();
      return;
    }

    let disposed = false;
    let raf = 0;
    const cleanupFns: Array<() => void> = [];

    (async () => {
      const first = await loadImage(urls[0]);
      if (disposed) return;
      if (!first || urls.length < 2) {
        onDegrade();
        return;
      }
      // Keep only the current image and its next transition target decoded.
      // Previously every showcase eagerly retained every full-size screenshot.
      const imgs = new Map<number, HTMLImageElement>([[0, first]]);
      const preload = async (index: number) => {
        const img = await loadImage(urls[index]);
        if (disposed) return;
        if (img) imgs.set(index, img);
        else onDegrade();
      };
      void preload(1);

      const compile = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      const prog = gl.createProgram()!;
      const vs = compile(gl.VERTEX_SHADER, VERT);
      const fs = compile(gl.FRAGMENT_SHADER, FRAG);
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

      const U = {
        from: gl.getUniformLocation(prog, "uFrom"),
        to: gl.getUniformLocation(prog, "uTo"),
        progress: gl.getUniformLocation(prog, "uProgress"),
        time: gl.getUniformLocation(prog, "uTime"),
        mode: gl.getUniformLocation(prog, "uMode"),
        res: gl.getUniformLocation(prog, "uRes"),
        fromRes: gl.getUniformLocation(prog, "uFromRes"),
        toRes: gl.getUniformLocation(prog, "uToRes"),
      };

      const mkTex = (unit: number) => {
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return tex;
      };
      const texFrom = mkTex(0);
      const texTo = mkTex(1);
      // Register cleanup before the first upload: tainted local image sources
      // can fail there and must not leak shaders/textures during repeated shows.
      cleanupFns.push(() => {
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.deleteBuffer(buf);
        gl.deleteTexture(texFrom);
        gl.deleteTexture(texTo);
        imgs.clear();
      });
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.uniform1i(U.from, 0);
      gl.uniform1i(U.to, 1);

      // Upload an image into a texture unit; throws (caught) if the source taints.
      let tainted = false;
      const upload = (unit: number, tex: WebGLTexture | null, img: HTMLImageElement) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        } catch {
          tainted = true;
        }
      };

      let cur = 0;
      const setFrom = (i: number) => {
        upload(0, texFrom, imgs.get(i)!);
        gl.uniform2f(U.fromRes, imgs.get(i)!.naturalWidth, imgs.get(i)!.naturalHeight);
      };
      const setTo = (i: number) => {
        upload(1, texTo, imgs.get(i)!);
        gl.uniform2f(U.toRes, imgs.get(i)!.naturalWidth, imgs.get(i)!.naturalHeight);
      };
      setFrom(0);
      setTo(0);
      if (tainted) {
        onDegrade();
        return;
      }

      const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (w < 1 || h < 1) return;
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        gl.viewport(0, 0, canvas.width, canvas.height);
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(canvas);
      cleanupFns.push(() => ro.disconnect());

      const t0 = performance.now();
      let phaseStart = t0;
      let phase: "hold" | "trans" = "hold";
      let mode = 0;

      const draw = (now: number) => {
        const elapsed = now - phaseStart;
        let p = 0;
        if (phase === "hold") {
          if (imgs.has((cur + 1) % urls.length) && elapsed > HOLD_MS) {
            // Begin a transition to the next image with the next shader mode.
            const next = (cur + 1) % urls.length;
            setFrom(cur);
            setTo(next);
            mode = (mode + 1) % 4;
            phase = "trans";
            phaseStart = now;
          }
          p = 0;
        } else {
          p = elapsed / TRANS_MS;
          if (p >= 1) {
            const previous = cur;
            cur = (cur + 1) % urls.length;
            phase = "hold";
            phaseStart = now;
            p = 0;
            setFrom(cur);
            setTo(cur);
            imgs.delete(previous);
            void preload((cur + 1) % urls.length);
          }
        }
        gl.uniform2f(U.res, canvas.width, canvas.height);
        gl.uniform1f(U.time, (now - t0) / 1000);
        gl.uniform1f(U.progress, p);
        gl.uniform1i(U.mode, mode);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (tainted) {
          onDegrade();
          return;
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanupFns.forEach((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls.join("|"), active, enabled]);
}

/** Reliable DOM fallback: ken-burns crossfade + sweeping light + shader overlay. */
function DomCrossfade({ images, labels, active }: { images: string[]; labels?: string[]; active: boolean }) {
  const enabled = useMotionEnabled();
  const [i, setI] = useState(0);
  const index = images.length ? i % images.length : 0;
  useEffect(() => {
    if (images.length <= 1 || !active) return;
    const id = window.setInterval(() => setI((v) => (v + 1) % images.length), HOLD_MS + TRANS_MS);
    return () => window.clearInterval(id);
  }, [images.length, active]);

  return (
    <>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={images[index]}
          className="absolute inset-0"
          initial={enabled ? { opacity: 0, scale: 1.1, filter: "blur(6px)" } : false}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={enabled ? { opacity: 0, scale: 1.04, filter: "blur(4px)" } : undefined}
          transition={{ duration: TRANS_MS / 1000, ease: [0.22, 1, 0.36, 1] }}
        >
          <motion.img
            src={images[index]}
            alt=""
            draggable={false}
            decoding="async"
            loading="lazy"
            className="h-full w-full object-cover"
            animate={enabled && active ? { scale: [1, 1.08] } : undefined}
            transition={{ duration: (HOLD_MS + TRANS_MS) / 1000, ease: "linear" }}
          />
        </motion.div>
      </AnimatePresence>
      {enabled && active && (
        <motion.div
          className="pointer-events-none absolute inset-y-0 w-1/3 -skew-x-12 bg-gradient-to-r from-transparent via-white/15 to-transparent"
          animate={{ x: ["-60%", "360%"] }}
          transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <MarqueeShader />
      {labels?.[index] && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
          <motion.p
            key={labels[index]}
            className="truncate font-display text-sm font-800 text-ink drop-shadow"
            initial={enabled ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
          >
            {labels[index]}
          </motion.p>
        </div>
      )}
    </>
  );
}

export function ShaderImageTransition({
  images,
  labels,
  className,
}: {
  images: string[];
  labels?: string[];
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [degraded, setDegraded] = useState(false);
  const enabled = useMotionEnabled();
  const { ref, inView } = useInView<HTMLDivElement>("120px", false);
  const visible = useDocumentVisible();
  const active = inView && visible;

  // Run the GPU path unless we've degraded or motion is off.
  useGlTransition(canvasRef, images, !degraded && enabled && active, () => setDegraded(true));

  if (images.length === 0) return null;

  return (
    <div
      ref={ref}
      className={cn("relative overflow-hidden rounded-2xl border border-line/60 bg-bg-900/80 shadow-card", className)}
      aria-label="Game showcase"
    >
      {!degraded && enabled ? (
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      ) : (
        <DomCrossfade images={images} labels={labels} active={active} />
      )}

      {/* Shared scrims so any foreground label/UI stays readable. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg-base/80 via-transparent to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 left-0 w-20 bg-gradient-to-r from-bg-base to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 right-0 ml-auto w-20 bg-gradient-to-l from-bg-base to-transparent" />
    </div>
  );
}
