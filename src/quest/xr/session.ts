/**
 * Immersive-VR "big screen" for the Quest remote client.
 *
 * Renders the WebRTC screen `<video>` onto a large flat quad floating in front of
 * the user, draws each controller's aiming ray + a cursor where it meets the
 * screen, and translates controller input into high-level events the React layer
 * turns into remote-control messages. Raw WebGL (no 3D engine) keeps the bundle
 * small and gives full control over the ray/cursor overlay in a single WebGL
 * projection layer (`XRWebGLLayer`). When the session has the WebXR `layers`
 * feature enabled (Quest Browser grants it when listed in optionalFeatures), the
 * layer MUST be set via `updateRenderState({ layers: [webglLayer] })` — using
 * `baseLayer` throws.
 *
 * Two input modes:
 *   - "pointer": the aiming ray is a mouse. Trigger = left button (press/release,
 *     so drags work), squeeze = right click, thumbstick = scroll wheel, face
 *     buttons = keyboard / Enter / recenter, and both-grips-held exits VR.
 *   - "gamepad": both controllers become a virtual Xbox pad on the PC (for games);
 *     only the both-grips-held exit gesture is intercepted.
 *
 * The system keyboard is DOM-driven (see textDiff.ts + the hidden <input> the
 * React layer owns): calling focus() on it inside the session raises the Quest
 * system keyboard (browser 26.1+). This class only signals *when* to focus/blur.
 */

import {
  buildPadState,
  XR_TRIGGER,
  XR_SQUEEZE,
  XR_STICK_PRESS,
  XR_BTN_A_X,
  XR_BTN_B_Y,
  XR_AXIS_X,
  XR_AXIS_Y,
} from "./input";
import { mat4Multiply, quadModel, rayFromMatrix, rayQuad, type Vec3 } from "./math";

export type PointerAction =
  | "leftdown"
  | "leftup"
  | "rightclick"
  | "middleclick"
  | "enter"
  | "keyboard"
  | "recenter"
  | "exit";

export interface SessionCallbacks {
  /** Active aiming ray hit on the screen (normalized 0..1, v top-down for the PC). */
  onPointer?(u: number, v: number): void;
  /** Pointer left the screen (no ray intersects it). */
  onPointerLost?(): void;
  onAction?(action: PointerAction): void;
  /** Wheel notches accumulated this frame (positive dy = scroll down). */
  onScroll?(dx: number, dy: number): void;
  /** Gamepad-mode: combined XInput pad snapshot (already change-gated upstream). */
  onGamepad?(state: ReturnType<typeof buildPadState>): void;
  onStart?(): void;
  onEnd?(): void;
  onError?(e: unknown): void;
}

type Mode = "pointer" | "gamepad";

const SCREEN_DISTANCE = 2.3; // metres in front of the user
const SCREEN_WIDTH = 3.2; // metres (height derived from video aspect)
const EYE_HEIGHT = 1.5; // fallback when the head pose is unavailable
const RAY_MISS_LEN = 8; // metres to draw the ray when it hits nothing
const CURSOR_SIZE = 0.035; // metres
const SCROLL_DEADZONE = 0.15;
// Thumbstick deflection → wheel notches per frame. This runs at the headset's
// display rate (90Hz+), so even a small number is a lot of notches per second —
// 0.6 sent pages flying past. `ImmersiveScreen` scales it again by the user's
// mouse-panel scroll speed, so this is the 1× baseline.
const SCROLL_GAIN = 0.16;
const EXIT_HOLD_MS = 1100; // both grips held this long → leave VR

const SCREEN_VS = `
attribute vec2 aPos; attribute vec2 aUv;
uniform mat4 uMvp; varying vec2 vUv;
void main() { vUv = aUv; gl_Position = uMvp * vec4(aPos, 0.0, 1.0); }`;
const SCREEN_FS = `
precision mediump float; varying vec2 vUv; uniform sampler2D uTex;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;
const SOLID_VS = `
attribute vec3 aPos; uniform mat4 uVp;
void main() { gl_Position = uVp * vec4(aPos, 1.0); }`;
const SOLID_FS = `
precision mediump float; uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

/** True if the live XRSession has the named feature enabled (e.g. `"layers"`). */
function sessionHasFeature(session: XRSession, name: string): boolean {
  const feats = (session as XRSession & { enabledFeatures?: ReadonlySet<string> | readonly string[] })
    .enabledFeatures;
  if (!feats) return false;
  if (typeof (feats as ReadonlySet<string>).has === "function") {
    return (feats as ReadonlySet<string>).has(name);
  }
  return Array.isArray(feats) && (feats as readonly string[]).includes(name);
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("shader compile failed: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}
function program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program link failed: " + gl.getProgramInfoLog(p));
  }
  return p;
}

type ButtonEdges = { trigger: boolean; squeeze: boolean; stick: boolean; a: boolean; b: boolean };

export class ImmersiveSession {
  private session: XRSession | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private gl: WebGLRenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** Projection layer we draw into — kept explicitly because `renderState.baseLayer`
   *  is null when the session has the WebXR `layers` feature enabled. */
  private xrLayer: XRWebGLLayer | null = null;

  private screenProg!: WebGLProgram;
  private solidProg!: WebGLProgram;
  private quadBuf!: WebGLBuffer;
  private dynBuf!: WebGLBuffer;
  private tex!: WebGLTexture;

  private aPosScreen = 0;
  private aUvScreen = 0;
  private uMvp!: WebGLUniformLocation;
  private uTex!: WebGLUniformLocation;
  private aPosSolid = 0;
  private uVp!: WebGLUniformLocation;
  private uColor!: WebGLUniformLocation;

  // Reusable matrices (avoid per-frame allocation in the render loop).
  private mMvp = new Float32Array(16);
  private mVp = new Float32Array(16);
  private mVm = new Float32Array(16);
  private mModel = new Float32Array(16);

  private center: Vec3 = [0, EYE_HEIGHT, -SCREEN_DISTANCE];
  private yaw = 0;
  private width = SCREEN_WIDTH;
  private height = SCREEN_WIDTH * (9 / 16);
  private aspectSet = false;

  private edges = new Map<string, ButtonEdges>();
  private dragHand: string | null = null;
  private lastUv: { u: number; v: number } | null = null;
  private exitHoldStart = 0;
  private gamepadSig = "";
  private gamepadSentAt = 0;
  private frameHandle = 0;
  private curFrame: XRFrame | null = null;
  /** Host desktop cursor kind (arrow / text / hand / …) — drives the hit marker. */
  private cursorKind = "arrow";

  constructor(
    private video: HTMLVideoElement,
    private getMode: () => Mode,
    private cb: SessionCallbacks,
  ) {}

  /** Mirror the PC's cursor shape on the ray hit marker. */
  setCursorKind(kind: string) {
    this.cursorKind = kind || "arrow";
  }

  static async isSupported(): Promise<boolean> {
    try {
      return (await navigator.xr?.isSessionSupported("immersive-vr")) ?? false;
    } catch {
      return false;
    }
  }

  /** True while an immersive session is live. */
  get active(): boolean {
    return !!this.session;
  }

  /** Whether the running session can raise the Quest system keyboard. */
  get keyboardSupported(): boolean {
    return !!(this.session as unknown as { isSystemKeyboardSupported?: boolean })?.isSystemKeyboardSupported;
  }

  async start(): Promise<void> {
    if (this.session) return;
    if (!navigator.xr) throw new Error("WebXR is not available in this browser.");
    // Ask for the system keyboard as an optional feature so focus() can raise it
    // (Meta Browser 26.1+ / WebXR keyboard docs). Surface Keyboard in flat 2D
    // does not need this — only immersive sessions do.
    const session = await navigator.xr.requestSession("immersive-vr", {
      optionalFeatures: ["local-floor", "bounded-floor", "layers", "keyboard"],
    });
    this.session = session;

    const canvas = document.createElement("canvas");
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { xrCompatible: true, alpha: false, antialias: true }) as WebGLRenderingContext | null;
    if (!gl) throw new Error("Could not create a WebGL context for VR.");
    this.gl = gl;
    await (gl as unknown as { makeXRCompatible?: () => Promise<void> }).makeXRCompatible?.();

    this.initGl(gl);
    // WebXR Layers: if `layers` was granted (Quest Browser does when listed in
    // optionalFeatures), `updateRenderState({ baseLayer })` throws
    // "Can't use baseLayer with layers feature requested". Use the layers[]
    // path instead; XRWebGLLayer is a valid projection entry in that array.
    // When layers wasn't granted, fall back to classic baseLayer.
    const webglLayer = new XRWebGLLayer(session, gl);
    this.xrLayer = webglLayer;
    // Spec: with the `layers` feature enabled, baseLayer is illegal — use layers[].
    // Prefer enabledFeatures when present; otherwise try baseLayer and fall back
    // (Quest has been seen to grant layers without a readable enabledFeatures set).
    if (sessionHasFeature(session, "layers")) {
      session.updateRenderState({ layers: [webglLayer] });
    } else {
      try {
        session.updateRenderState({ baseLayer: webglLayer });
      } catch {
        session.updateRenderState({ layers: [webglLayer] });
      }
    }

    // Prefer a floor-relative space so the screen sits at a comfortable height.
    this.refSpace = await session
      .requestReferenceSpace("local-floor")
      .catch(() => session.requestReferenceSpace("local"));
    // If we only got a local (eye-level) space, the origin is roughly at the head,
    // so drop the screen to eye height 0.
    if (!(await this.hasFloor(session))) this.center = [0, 0, -SCREEN_DISTANCE];

    session.addEventListener("end", () => this.cleanup());
    this.cb.onStart?.();
    this.frameHandle = session.requestAnimationFrame(this.onFrame);
  }

  private async hasFloor(session: XRSession): Promise<boolean> {
    // requestReferenceSpace('local-floor') resolves even when unsupported on some
    // builds; treat success of the first request as authoritative instead.
    return session.requestReferenceSpace("local-floor").then(
      () => true,
      () => false,
    );
  }

  async end(): Promise<void> {
    try {
      await this.session?.end();
    } catch {
      /* already ending */
    }
  }

  /** Re-place the screen directly in front of the current head direction. */
  recenter(frame?: XRFrame): void {
    const f = frame ?? this.curFrame;
    if (!f || !this.refSpace) return;
    const pose = f.getViewerPose(this.refSpace);
    if (!pose) return;
    const m = pose.transform.matrix;
    const headPos: Vec3 = [m[12], m[13], m[14]];
    // Forward is -Z of the head transform; flatten to the floor plane.
    let fx = -m[8];
    let fz = -m[10];
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    this.center = [headPos[0] + fx * SCREEN_DISTANCE, headPos[1] - 0.05, headPos[2] + fz * SCREEN_DISTANCE];
    // Quad normal must point back at the head (= -forward): normal=(sin yaw,0,cos yaw).
    this.yaw = Math.atan2(-fx, -fz);
  }

  private initGl(gl: WebGLRenderingContext) {
    this.screenProg = program(gl, SCREEN_VS, SCREEN_FS);
    this.solidProg = program(gl, SOLID_VS, SOLID_FS);
    this.aPosScreen = gl.getAttribLocation(this.screenProg, "aPos");
    this.aUvScreen = gl.getAttribLocation(this.screenProg, "aUv");
    this.uMvp = gl.getUniformLocation(this.screenProg, "uMvp")!;
    this.uTex = gl.getUniformLocation(this.screenProg, "uTex")!;
    this.aPosSolid = gl.getAttribLocation(this.solidProg, "aPos");
    this.uVp = gl.getUniformLocation(this.solidProg, "uVp")!;
    this.uColor = gl.getUniformLocation(this.solidProg, "uColor")!;

    // Unit quad: interleaved [x, y, u, v]. Bottom row v=0 (paired with FLIP_Y) so
    // the video is upright.
    const verts = new Float32Array([
      -0.5, -0.5, 0, 0, 0.5, -0.5, 1, 0, 0.5, 0.5, 1, 1,
      -0.5, -0.5, 0, 0, 0.5, 0.5, 1, 1, -0.5, 0.5, 0, 1,
    ]);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    this.dynBuf = gl.createBuffer()!; // ray + cursor geometry, rewritten each frame

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // 1x1 placeholder until the first video frame is uploaded.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 12, 20, 255]));
  }

  private uploadVideo(gl: WebGLRenderingContext) {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return;
    if (!this.aspectSet) {
      this.height = this.width * (v.videoHeight / v.videoWidth);
      this.aspectSet = true;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    } catch {
      /* transient: video not yet decodable this frame */
    }
  }

  private onFrame = (_t: number, frame: XRFrame) => {
    const session = this.session;
    const gl = this.gl;
    if (!session || !gl || !this.refSpace) return;
    this.frameHandle = session.requestAnimationFrame(this.onFrame);
    this.curFrame = frame;

    const layer = this.xrLayer ?? session.renderState.baseLayer;
    if (!layer) return;
    const pose = frame.getViewerPose(this.refSpace);

    this.uploadVideo(gl);
    // Read controllers once per frame (not per eye).
    const pointer = this.processInput(frame);

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!pose) return;

    quadModel(this.mModel, this.center, this.yaw, this.width, this.height);

    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      if (!vp) continue;
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      const proj = view.projectionMatrix as unknown as Float32Array;
      const viewMat = view.transform.inverse.matrix as unknown as Float32Array;
      mat4Multiply(this.mVp, proj, viewMat);

      // Screen quad.
      mat4Multiply(this.mVm, viewMat, this.mModel);
      mat4Multiply(this.mMvp, proj, this.mVm);
      this.drawScreen(gl);

      // Ray + cursor for the active pointer (pointer mode only).
      if (pointer) {
        const kind = this.cursorKind;
        const rayCol =
          kind === "hand"
            ? [0.4, 0.9, 0.55, 0.95]
            : kind === "text"
              ? [0.55, 0.75, 1, 0.95]
              : kind === "busy"
                ? [1, 0.7, 0.25, 0.95]
                : kind === "no"
                  ? [1, 0.35, 0.4, 0.9]
                  : pointer.hit
                    ? [0.36, 0.8, 1, 0.9]
                    : [1, 1, 1, 0.28];
        this.drawRay(gl, pointer.origin, pointer.end, rayCol);
        if (pointer.hit && kind !== "hidden") this.drawCursor(gl, pointer.hit, kind);
      }
    }
  };

  private drawScreen(gl: WebGLRenderingContext) {
    gl.useProgram(this.screenProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.aPosScreen);
    gl.vertexAttribPointer(this.aPosScreen, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.aUvScreen);
    gl.vertexAttribPointer(this.aUvScreen, 2, gl.FLOAT, false, 16, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.uTex, 0);
    gl.uniformMatrix4fv(this.uMvp, false, this.mMvp);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawRay(gl: WebGLRenderingContext, a: Vec3, b: Vec3, color: number[]) {
    gl.useProgram(this.solidProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([a[0], a[1], a[2], b[0], b[1], b[2]]), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPosSolid);
    gl.vertexAttribPointer(this.aPosSolid, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(this.uVp, false, this.mVp);
    gl.uniform4fv(this.uColor, color);
    gl.lineWidth(2);
    gl.drawArrays(gl.LINES, 0, 2);
  }

  private drawCursor(gl: WebGLRenderingContext, at: Vec3, kind: string) {
    // Screen-aligned marker at the hit point, nudged toward the viewer so it
    // never z-fights with the video. Shape + colour track the host cursor kind.
    const c = Math.cos(this.yaw);
    const sn = Math.sin(this.yaw);
    const rightU: Vec3 = [c, 0, -sn];
    const upU: Vec3 = [0, 1, 0];
    const n: Vec3 = [sn * 0.01, 0, c * 0.01];
    const p: Vec3 = [at[0] + n[0], at[1] + n[1], at[2] + n[2]];
    const sx = (x: number, y: number): Vec3 => [
      p[0] + rightU[0] * x + upU[0] * y,
      p[1] + rightU[1] * x + upU[1] * y,
      p[2] + rightU[2] * x + upU[2] * y,
    ];
    const quad = (hw: number, hh: number) => {
      const a = sx(-hw, -hh);
      const b = sx(hw, -hh);
      const d = sx(hw, hh);
      const e = sx(-hw, hh);
      return [a, b, d, a, d, e];
    };
    const bar = (x0: number, y0: number, x1: number, y1: number, t: number) => {
      // Thick line as a thin quad between two points in screen plane.
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * t;
      const ny = (dx / len) * t;
      const a = sx(x0 + nx, y0 + ny);
      const b = sx(x1 + nx, y1 + ny);
      const d = sx(x1 - nx, y1 - ny);
      const e = sx(x0 - nx, y0 - ny);
      return [a, b, d, a, d, e];
    };

    let tris: Vec3[] = [];
    let color: number[] = [1, 0.95, 0.4, 0.95];
    const s = CURSOR_SIZE;

    switch (kind) {
      case "text": {
        // I-beam: vertical stem + small top/bottom caps.
        color = [0.7, 0.85, 1, 0.98];
        tris = [
          ...bar(0, -s * 1.1, 0, s * 1.1, s * 0.12),
          ...bar(-s * 0.45, s * 1.1, s * 0.45, s * 1.1, s * 0.1),
          ...bar(-s * 0.45, -s * 1.1, s * 0.45, -s * 1.1, s * 0.1),
        ];
        break;
      }
      case "hand": {
        color = [0.45, 0.95, 0.6, 0.95];
        tris = quad(s * 1.15, s * 1.15);
        break;
      }
      case "busy": {
        color = [1, 0.72, 0.2, 0.95];
        tris = quad(s * 0.9, s * 0.9);
        break;
      }
      case "cross":
      case "move": {
        color = [1, 1, 1, 0.95];
        tris = [...bar(-s, 0, s, 0, s * 0.12), ...bar(0, -s, 0, s, s * 0.12)];
        break;
      }
      case "resize-ns": {
        color = [1, 0.95, 0.55, 0.95];
        tris = [...bar(0, -s, 0, s, s * 0.14), ...quad(s * 0.35, s * 0.18)];
        break;
      }
      case "resize-we": {
        color = [1, 0.95, 0.55, 0.95];
        tris = [...bar(-s, 0, s, 0, s * 0.14), ...quad(s * 0.18, s * 0.35)];
        break;
      }
      case "resize-nwse":
      case "resize-nesw": {
        color = [1, 0.95, 0.55, 0.95];
        const flip = kind === "resize-nesw" ? -1 : 1;
        tris = [...bar(-s * flip, -s, s * flip, s, s * 0.14)];
        break;
      }
      case "no": {
        color = [1, 0.4, 0.45, 0.95];
        tris = [...bar(-s * 0.8, -s * 0.8, s * 0.8, s * 0.8, s * 0.12), ...bar(-s * 0.8, s * 0.8, s * 0.8, -s * 0.8, s * 0.12)];
        break;
      }
      default: {
        // Arrow / help / grab / unknown — bright tip square.
        color = [1, 0.95, 0.4, 0.95];
        tris = quad(s, s);
        break;
      }
    }

    const v = new Float32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
      v[i * 3] = tris[i][0];
      v[i * 3 + 1] = tris[i][1];
      v[i * 3 + 2] = tris[i][2];
    }
    gl.useProgram(this.solidProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPosSolid);
    gl.vertexAttribPointer(this.aPosSolid, 3, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(this.uVp, false, this.mVp);
    gl.uniform4fv(this.uColor, color);
    gl.drawArrays(gl.TRIANGLES, 0, tris.length);
    gl.enable(gl.DEPTH_TEST);
  }

  /** Read controllers, run mode logic, and return the ray to draw (pointer mode). */
  private processInput(frame: XRFrame): { origin: Vec3; end: Vec3; hit: Vec3 | null } | null {
    const session = this.session!;
    const sources = Array.from(session.inputSources).filter((s) => s.targetRayMode === "tracked-pointer");
    const mode = this.getMode();

    // The both-grips-held exit gesture works in every mode.
    const bothSqueeze = sources.length >= 2 && sources.every((s) => s.gamepad?.buttons?.[XR_SQUEEZE]?.pressed);
    if (bothSqueeze) {
      if (this.exitHoldStart === 0) this.exitHoldStart = performance.now();
      else if (performance.now() - this.exitHoldStart > EXIT_HOLD_MS) {
        this.exitHoldStart = 0;
        this.cb.onAction?.("exit");
        void this.end();
        return null;
      }
    } else {
      this.exitHoldStart = 0;
    }

    if (mode === "gamepad") {
      const left = sources.find((s) => s.handedness === "left")?.gamepad ?? null;
      const right = sources.find((s) => s.handedness === "right")?.gamepad ?? null;
      const state = buildPadState(left, right);
      const sig = JSON.stringify(state);
      const now = performance.now();
      if (sig !== this.gamepadSig || now - this.gamepadSentAt > 400) {
        this.gamepadSig = sig;
        this.gamepadSentAt = now;
        this.cb.onGamepad?.(state);
      }
      return null; // no pointer overlay while a game owns the sticks
    }

    // ---- pointer mode ----
    // Compute each source's ray + screen hit; keep the nearest hit, but lock to
    // the hand currently dragging (trigger held) so a drag can't jump hands.
    let best: { src: XRInputSource; origin: Vec3; end: Vec3; hit: Vec3 | null; u: number; v: number; dist: number } | null = null;
    for (const src of sources) {
      const pose = frame.getPose(src.targetRaySpace, this.refSpace!);
      if (!pose) continue;
      const { origin, dir } = rayFromMatrix(pose.transform.matrix as unknown as Float32Array);
      const hit = rayQuad(origin, dir, this.center, this.yaw, this.width, this.height);
      const end: Vec3 = hit ? hit.point : [origin[0] + dir[0] * RAY_MISS_LEN, origin[1] + dir[1] * RAY_MISS_LEN, origin[2] + dir[2] * RAY_MISS_LEN];
      const key = src.handedness || "none";
      const cand = { src, origin, end, hit: hit ? hit.point : null, u: hit?.u ?? 0, v: hit?.v ?? 0, dist: hit?.distance ?? Infinity };
      if (this.dragHand && key === this.dragHand) {
        best = cand; // locked hand wins outright
        break;
      }
      if (!best || cand.dist < best.dist) best = cand;
    }

    // Fire button edges for every source (so either hand's trigger clicks).
    for (const src of sources) this.handleButtons(src, best);

    if (best) {
      if (best.hit) {
        // The PC treats v as top-down; the quad's v is bottom-up → invert.
        const u = best.u;
        const v = 1 - best.v;
        this.lastUv = { u, v };
        this.cb.onPointer?.(u, v);
      } else if (this.lastUv) {
        this.lastUv = null;
        this.cb.onPointerLost?.();
      }
      return { origin: best.origin, end: best.end, hit: best.hit };
    }
    return null;
  }

  private handleButtons(src: XRInputSource, active: { src: XRInputSource } | null) {
    const gp = src.gamepad;
    if (!gp) return;
    const key = src.handedness || "none";
    const prev = this.edges.get(key) ?? { trigger: false, squeeze: false, stick: false, a: false, b: false };
    const now: ButtonEdges = {
      trigger: !!gp.buttons[XR_TRIGGER]?.pressed,
      squeeze: !!gp.buttons[XR_SQUEEZE]?.pressed,
      stick: !!gp.buttons[XR_STICK_PRESS]?.pressed,
      a: !!gp.buttons[XR_BTN_A_X]?.pressed,
      b: !!gp.buttons[XR_BTN_B_Y]?.pressed,
    };
    const isActive = active?.src === src;
    const isRight = src.handedness === "right";
    const isLeft = src.handedness === "left";

    // Trigger = left mouse button, with drag capture on the pressing hand.
    if (now.trigger && !prev.trigger) {
      this.dragHand = key;
      this.cb.onAction?.("leftdown");
    } else if (!now.trigger && prev.trigger) {
      if (this.dragHand === key) this.dragHand = null;
      this.cb.onAction?.("leftup");
    }
    // Squeeze rising edge = right click (unless it's part of the exit gesture).
    if (now.squeeze && !prev.squeeze && this.exitHoldStart === 0) this.cb.onAction?.("rightclick");
    // Thumbstick press = middle click (right) / recenter (left).
    if (now.stick && !prev.stick) {
      if (isLeft) {
        this.recenter();
        this.cb.onAction?.("recenter");
      } else {
        this.cb.onAction?.("middleclick");
      }
    }
    // Face buttons: right A = keyboard, left X = recenter.
    if (now.a && !prev.a) {
      if (isRight) {
        this.cb.onAction?.("keyboard");
      } else {
        this.recenter(); // left X
        this.cb.onAction?.("recenter");
      }
    }
    // B and Y are both right-click. B is the headset's system "back" button, and
    // reaching for a right-click with the thumb is the natural motion — so this
    // is the binding people expect, and squeeze stays as the alternative. Exiting
    // VR is the both-grips hold (Y used to end the session, which made a misfire
    // cost the whole stream).
    if (now.b && !prev.b) this.cb.onAction?.("rightclick");

    // Thumbstick scroll from the actively-pointing hand only.
    if (isActive) {
      const ax = gp.axes[XR_AXIS_X] ?? 0;
      const ay = gp.axes[XR_AXIS_Y] ?? 0;
      // Emit fractional notches; the React layer accumulates them into whole
      // wheel steps so slow stick pushes still scroll.
      const dy = Math.abs(ay) > SCROLL_DEADZONE ? ay * SCROLL_GAIN : 0;
      const dx = Math.abs(ax) > SCROLL_DEADZONE ? ax * SCROLL_GAIN : 0;
      if (dy || dx) this.cb.onScroll?.(dx, dy);
    }

    this.edges.set(key, now);
  }

  private cleanup() {
    if (this.session) {
      try {
        this.session.cancelAnimationFrame?.(this.frameHandle);
      } catch {
        /* ignore */
      }
    }
    this.session = null;
    this.refSpace = null;
    this.gl = null;
    this.canvas = null;
    this.xrLayer = null;
    this.curFrame = null;
    this.dragHand = null;
    this.lastUv = null;
    this.edges.clear();
    this.cb.onEnd?.();
  }
}
