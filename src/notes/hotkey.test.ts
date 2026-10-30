import { expect, it } from "vitest";
import { comboOf } from "./hotkey";

const press = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

it("reads the default shortcut", () => {
  expect(comboOf(press("Space", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Space");
});

it("names letters, digits and punctuation the way the orb reads them", () => {
  expect(comboOf(press("KeyN", { altKey: true }))).toBe("Alt+N");
  expect(comboOf(press("Digit5", { ctrlKey: true }))).toBe("Ctrl+5");
  expect(comboOf(press("Comma", { metaKey: true }))).toBe("Win+,");
  expect(comboOf(press("ArrowUp", { ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+Up");
});

it("lets function keys stand alone", () => {
  expect(comboOf(press("F9"))).toBe("F9");
  expect(comboOf(press("F9", { shiftKey: true }))).toBe("Shift+F9");
});

it("waits for a real key and refuses ones that would break typing", () => {
  expect(comboOf(press("ControlLeft", { ctrlKey: true }))).toBeNull();
  expect(comboOf(press("KeyA"))).toBeNull();
  expect(comboOf(press("KeyA", { shiftKey: true }))).toBeNull();
});
