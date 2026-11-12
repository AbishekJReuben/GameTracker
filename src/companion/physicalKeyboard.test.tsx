import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlMsg } from "./links";
import { isEditable, isPhysicalKey, legacyKeyName, PhysicalKeyForwarder, toLegacy, usePhysicalKeyboard, PC_KEYS_PREF } from "./physicalKeyboard";

const key = (type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const e = new KeyboardEvent(type, { code, key: init.key ?? code, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
};
function mount(active = true, takeGhost = false) {
  const sent: ControlMsg[] = [];
  const ghost = document.createElement("input");
  document.body.appendChild(ghost);
  const send = vi.fn((m: ControlMsg) => (sent.push(m), true));
  const hook = renderHook((p: { active: boolean }) => usePhysicalKeyboard({ active: p.active, send, ghost: () => ghost, takeGhost: () => takeGhost }), {
    initialProps: { active },
  });
  return { sent, ghost, hook, send };
}
beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("physical keyboard forwarding", () => {
  it("sends every key by position, including shortcuts and repeats, and blocks the local action", () => {
    const { sent } = mount();
    const ctrl = key("keydown", "ControlLeft", { ctrlKey: true, key: "Control" });
    key("keydown", "KeyS", { ctrlKey: true, key: "s" });
    key("keydown", "KeyS", { ctrlKey: true, key: "s", repeat: true });
    key("keyup", "KeyS", { ctrlKey: true, key: "s" });
    key("keyup", "ControlLeft", { key: "Control" });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(sent).toEqual([
      { type: "pkeydown", code: "ControlLeft" },
      { type: "pkeydown", code: "KeyS" },
      { type: "pkeydown", code: "KeyS" },
      { type: "pkeyup", code: "KeyS" },
      { type: "pkeyup", code: "ControlLeft" },
    ]);
  });

  it("toggles with Ctrl+Alt+Shift+Z without sending the Z, and releases what is held", () => {
    const { sent, hook } = mount();
    key("keydown", "ControlLeft", { ctrlKey: true });
    key("keydown", "AltLeft", { ctrlKey: true, altKey: true });
    key("keydown", "ShiftLeft", { ctrlKey: true, altKey: true, shiftKey: true });
    const z = key("keydown", "KeyZ", { ctrlKey: true, altKey: true, shiftKey: true });
    expect(z.defaultPrevented).toBe(true);
    expect(hook.result.current.on).toBe(false);
    expect(localStorage.getItem(PC_KEYS_PREF)).toBe("0");
    expect(sent[sent.length - 1]).toEqual({ type: "seq", events: [{ type: "pkeyup", code: "ControlLeft" }, { type: "pkeyup", code: "AltLeft" }, { type: "pkeyup", code: "ShiftLeft" }] });
    expect(sent.some((m) => m.type === "pkeydown" && m.code === "KeyZ")).toBe(false);
    const n = sent.length;
    const local = key("keydown", "KeyA");
    expect(local.defaultPrevented).toBe(false);
    expect(sent.length).toBe(n);
    key("keydown", "KeyZ", { ctrlKey: true, altKey: true, shiftKey: true });
    expect(hook.result.current.on).toBe(true);
  });

  it("leaves other text fields and soft-keyboard events alone", () => {
    const { sent, ghost } = mount();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    expect(key("keydown", "KeyA", {}, field).defaultPrevented).toBe(false);
    expect(key("keydown", "KeyA", {}, ghost).defaultPrevented).toBe(false);
    key("keydown", "", { key: "Unidentified", keyCode: 229 });
    expect(sent).toEqual([]);
  });

  it("takes the hidden typing field only when told to", () => {
    const { sent, ghost } = mount(true, true);
    expect(key("keydown", "KeyA", {}, ghost).defaultPrevented).toBe(true);
    expect(sent).toEqual([{ type: "pkeydown", code: "KeyA" }]);
  });

  it("releases held keys on blur, on hide and when it stops being active", () => {
    const { sent, hook } = mount();
    key("keydown", "KeyW");
    window.dispatchEvent(new Event("blur"));
    expect(sent[sent.length - 1]).toEqual({ type: "pkeyup", code: "KeyW" });
    key("keydown", "KeyD");
    hook.rerender({ active: false });
    expect(sent[sent.length - 1]).toEqual({ type: "pkeyup", code: "KeyD" });
    const n = sent.length;
    key("keydown", "KeyD");
    expect(sent.length).toBe(n);
  });

  it("sends PrintScreen as a press when only its release is reported", () => {
    const { sent } = mount();
    key("keyup", "PrintScreen");
    expect(sent).toEqual([{ type: "seq", events: [{ type: "pkeydown", code: "PrintScreen" }, { type: "pkeyup", code: "PrintScreen" }] }]);
  });

  it("asks for keyboard lock after fullscreen for full control", async () => {
    const lock = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "keyboard", { value: { lock, unlock: vi.fn() }, configurable: true });
    let fs: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { get: () => fs, configurable: true });
    document.documentElement.requestFullscreen = vi.fn(async () => {
      fs = document.documentElement;
    });
    const { hook } = mount();
    expect(hook.result.current.lockSupported).toBe(true);
    await act(() => hook.result.current.enterFullControl());
    expect(lock).toHaveBeenCalled();
    expect(hook.result.current.fullControl).toBe(true);
    fs = null;
    act(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(hook.result.current.fullControl).toBe(false);
  });
});

describe("helpers", () => {
  it("recognises editable targets and soft-keyboard events", () => {
    const range = document.createElement("input");
    range.type = "range";
    expect(isEditable(range)).toBe(false);
    expect(isEditable(document.createElement("input"))).toBe(true);
    expect(isEditable(document.body)).toBe(false);
    expect(isPhysicalKey({ code: "KeyA", key: "a", keyCode: 65, isComposing: false })).toBe(true);
    expect(isPhysicalKey({ code: "KeyA", key: "Process", keyCode: 229, isComposing: true })).toBe(false);
  });

  it("maps physical keys to named keys for older PCs and drops what has no name", () => {
    expect(legacyKeyName("KeyQ")).toBe("q");
    expect(legacyKeyName("Digit7")).toBe("7");
    expect(legacyKeyName("MetaLeft")).toBe("win");
    expect(legacyKeyName("F12")).toBe("f12");
    expect(legacyKeyName("F13")).toBeNull();
    expect(toLegacy({ type: "pkeydown", code: "ControlRight" })).toEqual({ type: "keydown", name: "ctrl" });
    expect(toLegacy({ type: "pkeyup", code: "IntlRo" })).toBeNull();
    expect(toLegacy({ type: "seq", events: [{ type: "pkeyup", code: "IntlRo" }, { type: "pkeyup", code: "KeyA" }] })).toEqual({ type: "seq", events: [{ type: "keyup", name: "a" }] });
    expect(toLegacy({ type: "click" })).toEqual({ type: "click" });
  });

  it("does not remember a press the transport rejected", () => {
    const f = new PhysicalKeyForwarder(() => false);
    f.down("KeyA");
    expect(f.held.size).toBe(0);
  });
});
