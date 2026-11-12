/**
 * A real keyboard on the viewing device, sent to the PC key by key.
 *
 * Each key goes by POSITION (`KeyboardEvent.code`) as `pkeydown`/`pkeyup`; the
 * PC presses that position with a scan code, so its own layout decides the
 * character and shortcuts, games and key holds work as if the keyboard were
 * plugged into it. Typing exact text stays the compose bar's job.
 *
 * Normal keys and most Ctrl shortcuts can be taken from any focused page. Win,
 * Alt+Tab, Ctrl+W/T/N and Esc are the browser's or the OS's unless the page is
 * in fullscreen with the Keyboard Lock API (Chrome/Edge): that's "Full control".
 * Ctrl+Alt+Del and Win+L never reach a page.
 */
import { useEffect, useRef, useState } from "react";
import type { ControlMsg } from "./links";

export const PC_KEYS_PREF = "gt.remote.pcKeyboard";
/** The chord that turns forwarding on/off. Caught here, never sent. */
export const TOGGLE_CHORD_LABEL = "Ctrl+Alt+Shift+Z";

export function readPcKeys(): boolean {
  try {
    return localStorage.getItem(PC_KEYS_PREF) !== "0";
  } catch {
    return true;
  }
}
export function savePcKeys(on: boolean) {
  try {
    localStorage.setItem(PC_KEYS_PREF, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

type KeyLike = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;
export function isToggleChord(e: KeyLike): boolean {
  return e.code === "KeyZ" && e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey;
}

/** Events a soft keyboard / IME produces: no physical key to forward. */
export function isPhysicalKey(e: Pick<KeyboardEvent, "code" | "key" | "keyCode" | "isComposing">): boolean {
  return !!e.code && e.code !== "Unidentified" && !e.isComposing && e.keyCode !== 229 && e.key !== "Process" && e.key !== "Unidentified";
}

export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !["button", "checkbox", "radio", "range", "color", "submit", "reset", "file", "image"].includes(type);
  }
  return el.isContentEditable === true;
}

/** Physical-key names for PCs that predate `physical-keys-v1` (US positions). */
const LEGACY: Record<string, string> = {
  Escape: "escape", Enter: "enter", NumpadEnter: "enter", Backspace: "backspace", Tab: "tab", Space: "space",
  Delete: "delete", Insert: "insert", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", CapsLock: "capslock",
  PrintScreen: "printscreen", ScrollLock: "scrolllock", Pause: "pause", NumLock: "numlock",
  ControlLeft: "ctrl", ControlRight: "ctrl", ShiftLeft: "shift", ShiftRight: "shift", AltLeft: "alt", AltRight: "alt",
  MetaLeft: "win", MetaRight: "win", OSLeft: "win", OSRight: "win",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Backquote: "`", Comma: ",", Period: ".", Slash: "/", NumpadAdd: "+", NumpadSubtract: "-", NumpadMultiply: "*",
  NumpadDivide: "/", NumpadDecimal: ".", AudioVolumeUp: "volumeup", AudioVolumeDown: "volumedown",
  AudioVolumeMute: "volumemute", MediaPlayPause: "playpause", MediaTrackNext: "nexttrack", MediaTrackPrevious: "prevtrack",
};
export function legacyKeyName(code: string): string | null {
  if (LEGACY[code]) return LEGACY[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^F([1-9]|1[0-2])$/.exec(code);
  if (m) return `f${m[1]}`;
  return null;
}
/** Rewrite physical keys as named keys for an older PC; unmappable keys are dropped. */
export function toLegacy(msg: ControlMsg): ControlMsg | null {
  if (msg.type === "pkeydown" || msg.type === "pkeyup") {
    const name = legacyKeyName(msg.code);
    return name ? { type: msg.type === "pkeydown" ? "keydown" : "keyup", name } : null;
  }
  if (msg.type === "seq") {
    const events = msg.events.map(toLegacy).filter((e): e is ControlMsg => !!e);
    return events.length ? { type: "seq", events } : null;
  }
  return msg;
}

/** Tracks what this device holds down on the PC, so nothing is left stuck. */
export class PhysicalKeyForwarder {
  readonly held = new Set<string>();
  constructor(private send: (msg: ControlMsg) => boolean) {}
  down(code: string) {
    if (this.send({ type: "pkeydown", code })) this.held.add(code);
  }
  up(code: string) {
    if (this.held.delete(code)) {
      this.send({ type: "pkeyup", code });
      return;
    }
    // Windows only reports PrintScreen when it's released.
    if (code === "PrintScreen") this.send({ type: "seq", events: [{ type: "pkeydown", code }, { type: "pkeyup", code }] });
  }
  releaseAll() {
    if (!this.held.size) return;
    const events: ControlMsg[] = [...this.held].map((code) => ({ type: "pkeyup", code }));
    this.held.clear();
    this.send(events.length === 1 ? events[0] : { type: "seq", events });
  }
}

type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
const keyboardApi = (): KeyboardLock | undefined => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
export const keyboardLockSupported = () => typeof navigator !== "undefined" && typeof keyboardApi()?.lock === "function";
const fullscreenElement = () =>
  document.fullscreenElement ?? (document as Document & { webkitFullscreenElement?: Element | null }).webkitFullscreenElement ?? null;

export interface PhysicalKeyboardOptions {
  /** Connected, input not locked, Control screen on top. */
  active: boolean;
  send: (msg: ControlMsg) => boolean;
  /** The hidden typing field. Its keys are forwarded only when `takeGhost()` says so. */
  ghost: () => HTMLElement | null;
  takeGhost: () => boolean;
}

export function usePhysicalKeyboard(o: PhysicalKeyboardOptions) {
  const [on, setOnState] = useState(readPcKeys);
  const [fullControl, setFullControl] = useState(false);
  const [seen, setSeen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const opts = useRef(o);
  opts.current = o;
  const onRef = useRef(on);
  const wantLock = useRef(false);
  const fwd = useRef<PhysicalKeyForwarder | null>(null);
  if (!fwd.current) fwd.current = new PhysicalKeyForwarder((msg) => opts.current.send(msg));
  const noticeTimer = useRef<number | undefined>(undefined);
  const say = (text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2200);
  };

  const applyLock = async (lock: boolean) => {
    const kb = keyboardApi();
    if (!lock) {
      kb?.unlock?.();
      return true;
    }
    try {
      await kb?.lock?.();
      return true;
    } catch {
      return false;
    }
  };
  const setOn = (next: boolean, announce = true) => {
    if (onRef.current === next) return;
    onRef.current = next;
    setOnState(next);
    savePcKeys(next);
    if (!next) fwd.current!.releaseAll();
    if (wantLock.current && fullscreenElement()) void applyLock(next);
    if (announce) say(next ? `Keyboard → PC on · ${TOGGLE_CHORD_LABEL} to toggle` : `Keyboard stays here · ${TOGGLE_CHORD_LABEL} to send it to the PC`);
  };

  /** Fullscreen + Keyboard Lock. Call from a click: fullscreen needs a user gesture. */
  const enterFullControl = async () => {
    const root = document.documentElement;
    try {
      if (!fullscreenElement()) await root.requestFullscreen({ navigationUI: "hide" });
    } catch {
      say("The browser didn't allow fullscreen");
      return;
    }
    wantLock.current = true;
    setOn(true, false);
    if (!(await applyLock(true))) {
      say("The browser blocked keyboard lock: Win and Alt+Tab stay on this computer");
      return;
    }
    setFullControl(true);
    say("Full control · hold Esc to leave");
  };
  const exitFullControl = () => {
    wantLock.current = false;
    void applyLock(false);
    setFullControl(false);
    if (fullscreenElement()) void document.exitFullscreen?.().catch(() => {});
  };

  useEffect(() => {
    const onFs = () => {
      if (fullscreenElement()) return;
      wantLock.current = false;
      keyboardApi()?.unlock?.();
      setFullControl(false);
    };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
      window.clearTimeout(noticeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!o.active) {
      fwd.current!.releaseAll();
      return;
    }
    /** Should this key event go to the PC? */
    const ours = (e: KeyboardEvent) => {
      if (!onRef.current || !isPhysicalKey(e)) return false;
      if (!isEditable(e.target)) return true;
      return e.target === opts.current.ghost() && opts.current.takeGhost();
    };
    const onDown = (e: KeyboardEvent) => {
      if (isPhysicalKey(e)) setSeen(true);
      if (isToggleChord(e)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) setOn(!onRef.current);
        return;
      }
      if (!ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
      // Holding Esc is the browser's way out of full control; send one Esc, not a stream.
      if (e.repeat && e.code === "Escape" && wantLock.current) return;
      fwd.current!.down(e.code);
    };
    const onUp = (e: KeyboardEvent) => {
      if (!onRef.current || !e.code) return;
      if (!fwd.current!.held.has(e.code) && !(e.code === "PrintScreen" && ours(e))) return;
      e.preventDefault();
      e.stopPropagation();
      fwd.current!.up(e.code);
    };
    const release = () => fwd.current!.releaseAll();
    const onVis = () => {
      if (document.hidden) release();
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onVis);
      release();
    };
  }, [o.active]);

  return {
    on,
    toggle: () => setOn(!onRef.current),
    fullControl,
    enterFullControl,
    exitFullControl,
    lockSupported: keyboardLockSupported(),
    /** A hardware key has been pressed here (so the device has a real keyboard). */
    seen,
    notice,
  };
}
