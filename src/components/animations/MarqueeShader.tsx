import { useEffect, useMemo, useRef } from "react";
import { useMotionEnabled, useReduceEffects } from "@/store/app";
import { cn } from "@/lib/cn";

/* A self-contained WebGL overlay used by the "shader" marquee variant and other
   decorative surfaces. It ships a *family* of procedural effects (plasma,
   aurora, liquid, caustics) so backdrops feel hand-crafted rather than repeated.
   Purely procedural — it never samples DOM images, so it can't be tainted and
   always renders. Falls back to nothing when WebGL is unavailable or
   reduced-motion is on. */

export type ShaderKind = "plasma" | "aurora" | "liquid" | "caustics";

export const SHADER_KINDS: ShaderKind[] = ["plasma", "aurora", "liquid", "caustics"];

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Shared GLSL noise / fbm helpers prepended to every fragment program.
const HELPERS = `
precision mediump float;
uniform float uTime;
uniform vec2 uRes;
varying vec2 vUv;
const vec3 VIOLET = vec3(0.49, 0.33, 1.0);
const vec3 CYAN   = vec3(0.13, 0.83, 0.96);
const vec3 GREEN  = vec3(0.20, 0.86, 0.60);
const vec3 PINK   = vec3(0.96, 0.45, 0.71);
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  float a = hash(i), b = hash(i + vec2(1.0,0.0)), c = hash(i + vec2(0.0,1.0)), d = hash(i + vec2(1.0,1.0));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<5;i++){ v += a*noise(p); p *= 2.02; a *= 0.5; }
  return v;
}
float vign(vec2 uv){ return 1.0 - smoothstep(0.4, 1.2, distance(uv, vec2(0.5))); }
`;

const FRAGS: Record<ShaderKind, string> = {
  // Flowing aurora of the accent palette (the original look).
  plasma: `${HELPERS}
  void main(){
    vec2 uv = vUv; float t = uTime * 0.25;
    float a = sin(uv.x*6.0+t) + sin(uv.y*5.0-t*1.2) + sin((uv.x+uv.y)*4.0+t*0.7);
    float b = cos(uv.y*8.0+t*1.3) + sin(uv.x*3.0-t);
    float m = (a+b)*0.18 + 0.5;
    vec3 col = mix(VIOLET, CYAN, smoothstep(0.0,0.6,m));
    col = mix(col, GREEN, smoothstep(0.6,1.0,m)*0.5);
    gl_FragColor = vec4(col, (0.10 + 0.12*m) * vign(uv));
  }`,
  // Vertical curtains of light drifting like a real aurora borealis.
  aurora: `${HELPERS}
  void main(){
    vec2 uv = vUv; float t = uTime * 0.12;
    float curtain = 0.0;
    for(int i=0;i<3;i++){
      float fi = float(i);
      float x = uv.x + 0.18*fi + 0.10*sin(uv.y*3.0 + t*2.0 + fi);
      float band = fbm(vec2(x*3.0, uv.y*1.5 - t*1.5 + fi));
      float ribbon = smoothstep(0.55, 0.95, band) * (1.0 - uv.y*0.4);
      curtain += ribbon * (0.6 + 0.4*sin(t + fi));
    }
    vec3 col = mix(GREEN, CYAN, uv.y);
    col = mix(col, VIOLET, smoothstep(0.4, 1.0, curtain));
    float alpha = clamp(curtain*0.5, 0.0, 0.5) * vign(uv);
    gl_FragColor = vec4(col, alpha);
  }`,
  // Domain-warped fbm — slow liquid-metal sheen.
  liquid: `${HELPERS}
  void main(){
    vec2 uv = vUv; float t = uTime * 0.06;
    vec2 q = vec2(fbm(uv*3.0 + t), fbm(uv*3.0 + vec2(5.2,1.3) - t));
    vec2 r = vec2(fbm(uv*3.0 + 4.0*q + vec2(1.7,9.2) + t*0.5),
                  fbm(uv*3.0 + 4.0*q + vec2(8.3,2.8) - t*0.5));
    float f = fbm(uv*3.0 + 4.0*r);
    vec3 col = mix(VIOLET, CYAN, clamp(f*f*2.0, 0.0, 1.0));
    col = mix(col, PINK, clamp(length(r), 0.0, 1.0)*0.4);
    col = mix(col, GREEN, clamp(r.x, 0.0, 1.0)*0.3);
    gl_FragColor = vec4(col, (0.12 + 0.16*f) * vign(uv));
  }`,
  // Rippling light caustics, like sun through water.
  caustics: `${HELPERS}
  void main(){
    vec2 uv = vUv; float t = uTime * 0.4;
    vec2 p = uv * 6.0;
    float c = 0.0;
    for(int i=0;i<4;i++){
      float fi = float(i)+1.0;
      p += vec2(sin(t/fi + p.y), cos(t/fi + p.x));
      c += 1.0 / length(vec2(p.x / (sin(t*0.5+fi)*0.6+1.5), p.y / (cos(t*0.4+fi)*0.6+1.5)));
    }
    c *= 0.18;
    vec3 col = mix(CYAN, VIOLET, smoothstep(0.4, 1.4, c));
    float alpha = clamp(pow(c, 2.0)*0.22, 0.0, 0.5) * vign(uv);
    gl_FragColor = vec4(col, alpha);
  }`,
};

export function MarqueeShader({ className, kind }: { className?: string; kind?: ShaderKind }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const enabled = useMotionEnabled() && !useReduceEffects();
  // Pick a stable effect for this instance if the caller didn't specify one, so
  // different panels get visibly different shaders.
  const seeded = useMemo<ShaderKind>(() => kind ?? SHADER_KINDS[Math.floor(Math.random() * SHADER_KINDS.length)]!, [kind]);

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
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAGS[seeded]));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uTime = gl.getUniformLocation(prog, "uTime");
    const uRes = gl.getUniformLocation(prog, "uRes");

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
      gl.uniform2f(uRes, canvas.width, canvas.height);
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
  }, [enabled, seeded]);

  return <canvas ref={ref} className={cn("pointer-events-none absolute inset-0 h-full w-full mix-blend-screen", className)} aria-hidden />;
}
