import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { STREAM_TUNE_DEFAULTS, type StreamTune } from "../streamTune";
import { TUNE_GROUPS, TuneSheet, groupDefaults, itemChanged, type TuneItem } from "./TuneSheet";

const item = (id: string): TuneItem => {
  for (const g of TUNE_GROUPS) {
    const it = g.items.find((i) => i.id === id);
    if (it) return it;
  }
  throw new Error(`no item ${id}`);
};
const env = { nativePossible: true };
const t = (p: Partial<StreamTune> = {}): StreamTune => ({ ...STREAM_TUNE_DEFAULTS, ...p });

function renderSheet(tune: StreamTune, e = env) {
  const patch = vi.fn();
  const onReset = vi.fn();
  const onClose = vi.fn();
  render(
    <TuneSheet open tune={tune} patch={patch} onReset={onReset} onClose={onClose} hints onHints={() => {}} env={e} />,
  );
  return { patch, onReset, onClose };
}

describe("Tune groups", () => {
  it("every knob the old panel had is in exactly one group, and owns real keys", () => {
    const owned = TUNE_GROUPS.flatMap((g) => g.items.flatMap((i) => i.keys));
    const panel: (keyof StreamTune)[] = [
      "maxW", "jpeg", "jpegCap", "fps", "bitrateKbps", "bitrateHeadroom", "minBitrateKbps", "startBitrateKbps",
      "wcKeyMs", "wcBufKB", "wcQueueMax", "directRetrySec", "jbBase", "jbMin", "jbMax", "jbGrowAt",
      "audioJbMs", "audioHostMs", "contentMode", "adaptiveFps", "abrV2", "abrGradient", "encPreset",
      "encMultipass", "videoTransport", "preferDirect", "hostNvenc", "nvencFast", "preferNativeDecode",
      "h264High", "codec", "rfi", "pipLite", "preferDirectAudio", "audioStudio", "videoLayer",
    ];
    for (const k of panel) expect(owned).toContain(k);
    for (const k of owned) expect(k in STREAM_TUNE_DEFAULTS).toBe(true);
    const ids = TUNE_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults put every hard-gated knob in reach (nothing locked out of the box)", () => {
    for (const g of TUNE_GROUPS) {
      for (const i of g.items) {
        const gate = i.gate?.(t(), env) ?? null;
        expect(gate === null || gate.soft === true, `${i.id}: ${gate?.reason}`).toBe(true);
      }
    }
  });

  it("wires dependencies, each with the one change that unlocks it", () => {
    expect(item("abrGradient").gate!(t({ abrV2: false }), env)).toMatchObject({ fix: { abrV2: true } });
    expect(item("abrGradient").gate!(t({ preferDirect: false }), env)).toMatchObject({ fix: { preferDirect: true } });
    expect(item("high").gate!(t({ codec: "hevc" }), env)).toMatchObject({ fix: { codec: "auto" } });
    expect(item("rfi").gate!(t({ hostNvenc: false }), env)).toMatchObject({ fix: { hostNvenc: true } });
    expect(item("studio").gate!(t({ preferDirectAudio: false }), env)).toMatchObject({ fix: { preferDirectAudio: true } });
    // Fallback-path knobs stay adjustable but say they aren't in use.
    expect(item("jbBase").gate!(t(), env)).toMatchObject({ soft: true });
    expect(item("jbBase").gate!(t({ preferDirect: false }), env)).toBeNull();
    expect(item("audJb").gate!(t({ preferDirectAudio: false }), env)).toBeNull();
    expect(item("videoLayer").gate!(t({ preferNativeDecode: false }), env)).toMatchObject({
      fix: { preferNativeDecode: true },
    });
    // Android-only, with nothing to fix elsewhere.
    const g = item("mediacodec").gate!(t(), { nativePossible: false });
    expect(g?.soft).toBeFalsy();
    expect(g?.fix).toBeUndefined();
  });

  it("paired sliders keep their invariants", () => {
    const base = item("jbBase") as Extract<TuneItem, { kind: "slider" }>;
    expect(base.set(30, t({ jbMin: 60 }))).toEqual({ jbBase: 30, jbMin: 30 });
    const min = item("jbMin") as Extract<TuneItem, { kind: "slider" }>;
    expect(min.set(150, t({ jbBase: 40 }))).toEqual({ jbMin: 40 });
  });

  it("group reset restores every key the group owns, and nothing else", () => {
    const sound = TUNE_GROUPS.find((g) => g.id === "sound")!;
    expect(groupDefaults(sound)).toEqual({
      preferDirectAudio: STREAM_TUNE_DEFAULTS.preferDirectAudio,
      audioStudio: STREAM_TUNE_DEFAULTS.audioStudio,
      audioJbMs: STREAM_TUNE_DEFAULTS.audioJbMs,
      audioHostMs: STREAM_TUNE_DEFAULTS.audioHostMs,
    });
    expect(itemChanged(item("fps"), t({ fps: 24 }))).toBe(true);
    expect(itemChanged(item("fps"), t())).toBe(false);
  });
});

describe("TuneSheet", () => {
  it("switches tabs and shows only that group's knobs", () => {
    renderSheet(t());
    fireEvent.click(screen.getByRole("tab", { name: /Sound/ }));
    expect(screen.getByRole("region", { name: "Studio sound" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Resolution" })).toBeNull();
  });

  it("a locked knob can't be flipped, and its fix button applies the prerequisite", () => {
    const { patch } = renderSheet(t({ abrV2: false }));
    fireEvent.click(screen.getByRole("tab", { name: /Bitrate/ }));
    const card = screen.getByRole("region", { name: "Early congestion detection" });
    const sw = within(card).getByRole("switch");
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: "Turn on Smart bitrate" }));
    expect(patch).toHaveBeenCalledWith({ abrV2: true });
  });

  it("switches, segments and steppers patch the right keys", () => {
    const { patch } = renderSheet(t({ fps: 30 }));
    fireEvent.click(screen.getByRole("tab", { name: /Picture/ }));
    fireEvent.click(within(screen.getByRole("region", { name: "Adaptive frame rate" })).getByRole("switch"));
    expect(patch).toHaveBeenLastCalledWith({ adaptiveFps: !STREAM_TUNE_DEFAULTS.adaptiveFps });
    fireEvent.click(screen.getByRole("radio", { name: "Video" }));
    expect(patch).toHaveBeenLastCalledWith({ contentMode: "video" });
    fireEvent.click(screen.getByRole("button", { name: "Increase Frame rate" }));
    expect(patch).toHaveBeenLastCalledWith({ fps: 31 });
    fireEvent.click(screen.getByRole("button", { name: "Decrease Frame rate" }));
    expect(patch).toHaveBeenLastCalledWith({ fps: 29 });
  });

  it("resets one group or everything; closes on the backdrop and Escape", () => {
    const { patch, onReset, onClose } = renderSheet(t({ fps: 24, audioStudio: !STREAM_TUNE_DEFAULTS.audioStudio }));
    fireEvent.click(screen.getByRole("tab", { name: /Picture/ }));
    fireEvent.click(screen.getByRole("button", { name: /Reset Picture/ }));
    expect(patch).toHaveBeenLastCalledWith(expect.objectContaining({ fps: STREAM_TUNE_DEFAULTS.fps }));
    expect(patch.mock.lastCall![0]).not.toHaveProperty("audioStudio");
    fireEvent.click(screen.getByRole("button", { name: /Reset all/ }));
    expect(onReset).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
