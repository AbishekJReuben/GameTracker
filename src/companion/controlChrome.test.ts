import { describe, expect, it } from "vitest";
import {
  normalizeControlChrome,
  SCROLL_PAD_DEFAULTS,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
} from "./controlChrome";

describe("normalizeControlChrome — scroll strip + speed", () => {
  it("gives a chrome saved before these knobs existed the defaults", () => {
    // Every phone already on disk has a chrome doc with neither key. Absent must
    // mean "default" — and specifically the strip must stay OFF, or upgrading
    // would drop a floating panel over everyone's stream unasked.
    const c = normalizeControlChrome({ pinned: ["k:w"] });
    expect(c.scrollPad).toEqual(SCROLL_PAD_DEFAULTS);
    expect(c.scrollPad.on).toBe(false);
    expect(c.scrollSpeed).toBe(1);
  });

  it("round-trips a placed, resized strip", () => {
    const c = normalizeControlChrome({
      scrollPad: { on: true, x: 12, y: 70, w: 20, h: 50, opacity: 0.9, horizontal: true },
    });
    expect(c.scrollPad).toEqual({ on: true, x: 12, y: 70, w: 20, h: 50, opacity: 0.9, horizontal: true });
  });

  it("clamps geometry so a corrupt doc can't park the strip off-screen", () => {
    const c = normalizeControlChrome({
      scrollPad: { on: true, x: -500, y: 900, w: 999, h: 999, opacity: 5 },
    });
    expect(c.scrollPad.x).toBe(4);
    expect(c.scrollPad.y).toBe(94);
    expect(c.scrollPad.w).toBe(60);
    expect(c.scrollPad.h).toBe(90);
    expect(c.scrollPad.opacity).toBe(1);
  });

  it("clamps scroll speed and survives garbage", () => {
    expect(normalizeControlChrome({ scrollSpeed: 0.05 }).scrollSpeed).toBe(SCROLL_SPEED_MIN);
    expect(normalizeControlChrome({ scrollSpeed: 99 }).scrollSpeed).toBe(SCROLL_SPEED_MAX);
    expect(normalizeControlChrome({ scrollSpeed: 2.5 }).scrollSpeed).toBe(2.5);
    expect(normalizeControlChrome({ scrollSpeed: "fast" as unknown as number }).scrollSpeed).toBe(1);
  });

  it("treats only a real `true` as on", () => {
    expect(normalizeControlChrome({ scrollPad: { on: 1 as unknown as boolean } }).scrollPad.on).toBe(false);
    expect(normalizeControlChrome({ scrollPad: null as never }).scrollPad.on).toBe(false);
  });
});
