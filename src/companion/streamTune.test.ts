import { describe, expect, it } from "vitest";
import { normalizeStreamTune, STREAM_TUNE_DEFAULTS } from "./streamTune";

describe("normalizeStreamTune", () => {
  it("defaults hostNvenc ON for a tune saved before the knob existed", () => {
    // Phones that used 3.9.27 have a persisted tune with no `hostNvenc` key at all.
    // Absent must mean "default", not "off" — otherwise upgrading would silently
    // strand every existing phone on the JPEG path.
    const { hostNvenc } = normalizeStreamTune({ maxW: 1920, fps: 40 });
    expect(hostNvenc).toBe(true);
  });

  it("honours an explicit hostNvenc=false and round-trips true", () => {
    expect(normalizeStreamTune({ hostNvenc: false }).hostNvenc).toBe(false);
    expect(normalizeStreamTune({ hostNvenc: true }).hostNvenc).toBe(true);
  });

  it("falls back to defaults for null/garbage input", () => {
    expect(normalizeStreamTune(null).hostNvenc).toBe(STREAM_TUNE_DEFAULTS.hostNvenc);
    // `hostNvenc` uses the `!== false` shape, so only a real false disables it —
    // a truthy-but-wrong value must not read as "off".
    expect(normalizeStreamTune({ hostNvenc: "no" as unknown as boolean }).hostNvenc).toBe(true);
  });

  it("defaults preferNativeDecode ON when the key is absent", () => {
    expect(normalizeStreamTune({ maxW: 1280 }).preferNativeDecode).toBe(true);
  });

  it("honours preferNativeDecode=false", () => {
    expect(normalizeStreamTune({ preferNativeDecode: false }).preferNativeDecode).toBe(false);
  });
});
