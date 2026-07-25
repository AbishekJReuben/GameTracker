import { describe, expect, it } from "vitest";
import { normalizeStreamTune, streamTuneIsCustom, STREAM_TUNE_DEFAULTS } from "./streamTune";

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

  it("defaults preferDirectAudio ON when the key is absent", () => {
    expect(normalizeStreamTune({ maxW: 1280 }).preferDirectAudio).toBe(true);
  });

  it("honours preferDirectAudio=false", () => {
    expect(normalizeStreamTune({ preferDirectAudio: false }).preferDirectAudio).toBe(false);
  });

  describe("streaming pass 3 knobs", () => {
    it("defaults abrV2 and audioStudio ON for a tune saved before they existed", () => {
      // Same `!== false` shape as every other opt-out: a phone upgrading from
      // 3.9.x has a persisted tune with neither key, and absent must mean
      // "default" or the upgrade silently strands it on the old paths.
      const t = normalizeStreamTune({ maxW: 1920, fps: 60 });
      expect(t.abrV2).toBe(true);
      expect(t.audioStudio).toBe(true);
    });

    it("honours an explicit false and round-trips true", () => {
      expect(normalizeStreamTune({ abrV2: false }).abrV2).toBe(false);
      expect(normalizeStreamTune({ abrV2: true }).abrV2).toBe(true);
      expect(normalizeStreamTune({ audioStudio: false }).audioStudio).toBe(false);
      expect(normalizeStreamTune({ audioStudio: true }).audioStudio).toBe(true);
    });

    it("counts as custom when either is turned off", () => {
      expect(streamTuneIsCustom(normalizeStreamTune({ abrV2: false }))).toBe(true);
      expect(streamTuneIsCustom(normalizeStreamTune({ audioStudio: false }))).toBe(true);
      expect(streamTuneIsCustom(normalizeStreamTune({}))).toBe(false);
    });
  });

  describe("RTC audio knobs", () => {
    it("migrates a tune saved before the current audio and fps defaults", () => {
      const t = normalizeStreamTune({ maxW: 1920, fps: 40 });
      expect(t.fps).toBe(60);
      expect(t.audioJbMs).toBe(STREAM_TUNE_DEFAULTS.audioJbMs);
      expect(t.audioHostMs).toBe(STREAM_TUNE_DEFAULTS.audioHostMs);
    });

    it("keeps an explicit 0 for audioJbMs instead of falling back to the default", () => {
      // 0 IS the default here, but it's also a meaningful user choice ("auto"),
      // so the `||` idiom used by the other numeric fields would be wrong.
      expect(normalizeStreamTune({ audioJbMs: 0 }).audioJbMs).toBe(0);
      expect(normalizeStreamTune({ audioJbMs: 120 }).audioJbMs).toBe(120);
    });

    it("clamps both to sane ranges", () => {
      expect(normalizeStreamTune({ audioJbMs: -50 }).audioJbMs).toBe(0);
      expect(normalizeStreamTune({ audioJbMs: 9999 }).audioJbMs).toBe(400);
      expect(normalizeStreamTune({ audioHostMs: 1 }).audioHostMs).toBe(20);
      expect(normalizeStreamTune({ audioHostMs: 9999 }).audioHostMs).toBe(200);
    });

    it("counts toward the custom badge", () => {
      expect(streamTuneIsCustom(STREAM_TUNE_DEFAULTS)).toBe(false);
      expect(streamTuneIsCustom({ ...STREAM_TUNE_DEFAULTS, audioJbMs: 80 })).toBe(true);
      expect(streamTuneIsCustom({ ...STREAM_TUNE_DEFAULTS, audioHostMs: 40 })).toBe(true);
    });
  });
});
