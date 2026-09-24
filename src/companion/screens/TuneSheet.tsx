/**
 * Stream tuning sheet — opened from the stats HUD's "Tune" button.
 *
 * Every knob is declared once in {@link TUNE_GROUPS}: its group, control, hint,
 * the StreamTune keys it owns, and a {@link Gate} saying when it cannot apply.
 * The groups are tabs by what the knob DOES (picture, bitrate, PC encoder,
 * connection, phone, sound), so a change never means scrolling a 30-row list.
 *
 * Gates wire related knobs together:
 *  - hard: the knob can't act at all (e.g. Early congestion detection without
 *    Smart bitrate). The control locks, says why, and offers the one change that
 *    fixes it as a button.
 *  - soft: the knob only matters on a path that isn't live right now (the RTC
 *    jitter buffer while DIRECT is on). It stays adjustable — the fallback path
 *    still uses it — but says it isn't in use.
 *
 * Sized for fingers: 44 px tabs and segments, a 56×32 switch, sliders with a
 * 28 px thumb plus −/+ steppers, one scroll area (no nested scrolling), and
 * vertical swipes over a slider scroll the sheet instead of moving the slider.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Cpu, Gauge, Info, Lock, Minus, Monitor, Plus, RotateCcw, Smartphone, Volume2, Wifi, X } from "lucide-react";
import {
  PIP_MAX_FPS,
  PIP_MAX_W,
  STREAM_TUNE_DEFAULTS,
  streamTuneIsCustom,
  type StreamTune,
} from "../streamTune";

/** Which leg of the pipeline a knob acts on. */
export type TuneScope = "host" | "direct" | "rtc" | "both";

const SCOPE_STYLE: Record<TuneScope, string> = {
  host: "bg-white/[0.08] text-ink-dim",
  direct: "bg-green/20 text-green",
  rtc: "bg-accent-3/20 text-accent-3",
  both: "bg-amber/20 text-amber",
};
const SCOPE_TITLE: Record<TuneScope, string> = {
  host: "Acts on the PC",
  direct: "Acts on the DIRECT path (H.264 decoded by this device)",
  rtc: "Acts on the RTC path (the browser's video/audio pipeline)",
  both: "Acts on both paths",
};

/** What this device can do — some knobs only exist on the Android app. */
export type TuneEnv = { nativePossible: boolean };

/** Why a knob can't apply right now, and optionally the one change that fixes it. */
export type Gate = { reason: string; soft?: boolean; fix?: Partial<StreamTune>; fixLabel?: string } | null;
type GateFn = (t: StreamTune, env: TuneEnv) => Gate;

type Base = {
  id: string;
  label: string;
  scope: TuneScope;
  hint: ReactNode;
  /** StreamTune keys this knob owns (per-group reset and the "changed" mark). */
  keys: (keyof StreamTune)[];
  gate?: GateFn;
};
export type TuneItem =
  | (Base & {
      kind: "slider";
      min: number;
      max: number;
      step: number;
      get: (t: StreamTune) => number;
      set: (v: number, t: StreamTune) => Partial<StreamTune>;
      fmt: (v: number) => string;
    })
  | (Base & { kind: "toggle"; get: (t: StreamTune) => boolean; set: (on: boolean) => Partial<StreamTune> })
  | (Base & {
      kind: "choice";
      options: readonly { value: string | number; label: string }[];
      get: (t: StreamTune) => string | number;
      set: (v: string | number) => Partial<StreamTune>;
    });
export type TuneGroup = {
  id: string;
  title: string;
  icon: typeof Monitor;
  blurb: string;
  items: TuneItem[];
};

// ---- gates ------------------------------------------------------------------

const needDirect: GateFn = (t) =>
  t.preferDirect
    ? null
    : { reason: "Needs Direct (WebCodecs), in the Connection tab.", fix: { preferDirect: true }, fixLabel: "Turn on Direct" };
const needNvenc: GateFn = (t) =>
  t.hostNvenc
    ? null
    : { reason: "Needs the PC encoder (NVENC).", fix: { hostNvenc: true }, fixLabel: "Turn on NVENC" };
const needSmart: GateFn = (t) =>
  t.abrV2 ? null : { reason: "Needs Smart bitrate.", fix: { abrV2: true }, fixLabel: "Turn on Smart bitrate" };
const needH264: GateFn = (t) =>
  t.codec === "hevc"
    ? { reason: "Only applies to H.264 — Codec is forced to HEVC.", fix: { codec: "auto" }, fixLabel: "Codec → Auto" }
    : null;
const needDirectAudio: GateFn = (t) =>
  t.preferDirectAudio
    ? null
    : { reason: "Needs PC sound (DIRECT).", fix: { preferDirectAudio: true }, fixLabel: "Turn on DIRECT sound" };
const rtcVideoOnly: GateFn = (t) =>
  t.preferDirect
    ? { soft: true, reason: "Not in use while Direct is on — only when the stream falls back to the RTC path." }
    : null;
const rtcAudioOnly: GateFn = (t) =>
  t.preferDirectAudio ? { soft: true, reason: "Not in use while PC sound (DIRECT) is on." } : null;
const jpegOnly: GateFn = (t) =>
  t.preferDirect && t.hostNvenc
    ? { soft: true, reason: "Not in use while NVENC carries DIRECT — only on the JPEG / RTC fallback." }
    : null;
const nativeOnly: GateFn = (_t, env) =>
  env.nativePossible ? null : { reason: "Android app only — web and Quest always decode with WebCodecs." };
const needMediaCodec: GateFn = (t) =>
  t.preferNativeDecode
    ? null
    : { reason: "Needs the hardware decoder (MediaCodec).", fix: { preferNativeDecode: true }, fixLabel: "Turn on MediaCodec" };
/** First gate that applies. */
const all =
  (...gates: GateFn[]): GateFn =>
  (t, env) => {
    for (const g of gates) {
      const r = g(t, env);
      if (r) return r;
    }
    return null;
  };

const onOff = (key: keyof StreamTune) => ({
  get: (t: StreamTune) => t[key] as boolean,
  set: (on: boolean) => ({ [key]: on }) as Partial<StreamTune>,
});

// ---- the knobs, grouped by what they do -----------------------------------

export const TUNE_GROUPS: TuneGroup[] = [
  {
    id: "picture",
    title: "Picture",
    icon: Monitor,
    blurb: "What the PC captures: size, frame rate, and how it trades detail against motion.",
    items: [
      {
        id: "res", kind: "slider", label: "Resolution", scope: "host", keys: ["maxW"],
        min: 480, max: 3840, step: 80, get: (t) => t.maxW, set: (v) => ({ maxW: v }), fmt: (v) => `${v} px`,
        hint: "Capture width before encoding — the biggest cost lever, since everything downstream scales with pixel count. Right = sharper and heavier.",
      },
      {
        id: "fps", kind: "slider", label: "Frame rate", scope: "host", keys: ["fps"],
        min: 10, max: 60, step: 1, get: (t) => t.fps, set: (v) => ({ fps: v }), fmt: (v) => `${v} fps`,
        hint: "Capture target. The PC only sends frames when the screen changes, so a still desktop reads far below this in the stats — that's normal.",
      },
      {
        id: "content", kind: "choice", label: "Content", scope: "both", keys: ["contentMode"],
        options: [
          { value: "text", label: "Text" },
          { value: "auto", label: "Auto" },
          { value: "video", label: "Video" },
        ],
        get: (t) => t.contentMode, set: (v) => ({ contentMode: v as StreamTune["contentMode"] }),
        hint: (
          <>
            What the picture mostly is. <b>Text</b> keeps glyph edges crisp and gives up frame rate under pressure;{" "}
            <b>Video</b> keeps motion smooth and lets detail go soft; <b>Auto</b> sits between.
          </>
        ),
      },
      {
        id: "adaptiveFps", kind: "toggle", label: "Adaptive frame rate", scope: "host", keys: ["adaptiveFps"],
        ...onOff("adaptiveFps"),
        hint: "Shares network pressure between frame rate and per-frame detail, so motion eases before the picture turns blocky.",
      },
      {
        id: "pipLite", kind: "toggle", label: "Lighter picture-in-picture", scope: "both", keys: ["pipLite"],
        ...onOff("pipLite"),
        hint: `While the stream is in picture-in-picture the PC sends at most ${PIP_MAX_W} px at ${PIP_MAX_FPS} fps — still sharp in a mini window, for a fraction of the decode, radio and PC work. The full stream returns when PiP closes (one keyframe each way).`,
      },
    ],
  },
  {
    id: "bitrate",
    title: "Bitrate",
    icon: Gauge,
    blurb: "How many bits the stream may use, and how the PC reacts when the network can't carry them.",
    items: [
      {
        id: "bitrate", kind: "slider", label: "Bitrate", scope: "both", keys: ["bitrateKbps"],
        min: 1000, max: 40000, step: 500, get: (t) => t.bitrateKbps, set: (v) => ({ bitrateKbps: v }),
        fmt: (v) => `${(v / 1000).toFixed(1)} Mb/s`,
        hint: "Target for the encoder. Smart bitrate climbs back to it whenever the network allows.",
      },
      {
        id: "abrV2", kind: "toggle", label: "Smart bitrate", scope: "direct", keys: ["abrV2"], gate: needDirect,
        ...onOff("abrV2"),
        hint: (
          <>
            <b>On</b>: this device tells the PC what it is actually receiving and how much delay the link is adding,
            and the PC sets the bitrate from that — so it climbs back to your setting as soon as the network can take it.{" "}
            <b>Off</b>: the older controller, which guesses from its own send queue. The <b>ABR</b> stat shows which is live.
          </>
        ),
      },
      {
        id: "abrGradient", kind: "toggle", label: "Early congestion detection", scope: "direct", keys: ["abrGradient"],
        gate: all(needDirect, needSmart), ...onOff("abrGradient"),
        hint: (
          <>
            Also watches whether the delay is <i>growing</i>, not just how big it is, so the PC backs off in about a
            quarter to half a second instead of about a second when the network starts to choke. A big frame on a good
            network doesn't count. The <b>Gradient</b> stat shows what it sees.
          </>
        ),
      },
      {
        id: "minBitrate", kind: "slider", label: "Minimum bitrate", scope: "rtc", keys: ["minBitrateKbps"],
        gate: rtcVideoOnly, min: 500, max: 8000, step: 100, get: (t) => t.minBitrateKbps,
        set: (v) => ({ minBitrateKbps: v }), fmt: (v) => `${v} kb/s`,
        hint: "Floor for the RTC bandwidth estimate, so the stream can't collapse to a blurry ~200 kb/s and stay there.",
      },
      {
        id: "startBitrate", kind: "slider", label: "Starting bitrate", scope: "rtc", keys: ["startBitrateKbps"],
        gate: rtcVideoOnly, min: 1000, max: 20000, step: 500, get: (t) => t.startBitrateKbps,
        set: (v) => ({ startBitrateKbps: v }), fmt: (v) => `${(v / 1000).toFixed(1)} Mb/s`,
        hint: "Opening bandwidth guess so the first seconds aren't a blurry ramp-up. Applies from the next connection.",
      },
      {
        id: "headroom", kind: "slider", label: "Keyframe headroom", scope: "rtc", keys: ["bitrateHeadroom"],
        gate: rtcVideoOnly, min: 100, max: 250, step: 5, get: (t) => Math.round(t.bitrateHeadroom * 100),
        set: (v) => ({ bitrateHeadroom: v / 100 }), fmt: (v) => `${(v / 100).toFixed(2)}×`,
        hint: "RTC sender cap = bitrate × this, so keyframe spikes clear the pacer instead of queueing a ~1 s hitch. Below ~1.2× that hitch comes back.",
      },
    ],
  },
  {
    id: "encoder",
    title: "PC encoder",
    icon: Cpu,
    blurb: "How the PC turns the screen into video. NVENC encodes on the GPU in about a millisecond.",
    items: [
      {
        id: "nvenc", kind: "toggle", label: "PC encoder (NVENC)", scope: "host", keys: ["hostNvenc"],
        ...onOff("hostNvenc"),
        hint: (
          <>
            <b>On</b>: the PC encodes the screen on its GPU (~1 ms a frame) and sends finished video. <b>Off</b>: the
            older path — JPEGs re-encoded by the browser (~35 ms a frame). Turn off only if the picture goes choppy or
            patches stop refreshing. No effect without an NVIDIA GPU; the header shows <b>NVENC</b> when it's live.
          </>
        ),
      },
      {
        id: "codec", kind: "choice", label: "Codec", scope: "direct", keys: ["codec"],
        gate: all(needNvenc, needDirect),
        options: [
          { value: "auto", label: "Auto" },
          { value: "h264", label: "H.264" },
          { value: "hevc", label: "HEVC" },
        ],
        get: (t) => t.codec, set: (v) => ({ codec: v as StreamTune["codec"] }),
        hint: (
          <>
            HEVC needs a third to a half fewer bits for the same picture but takes a few ms longer to decode.{" "}
            <b>Auto</b> stays on H.264 and switches to HEVC only while the connection holds the stream under ~8 Mb/s,
            then back above ~12 Mb/s (one keyframe per switch). HEVC needs a hardware decoder here and falls back by
            itself if it won't decode. The header shows <b>HEVC</b> when it's live.
          </>
        ),
      },
      {
        id: "high", kind: "toggle", label: "H.264 High profile", scope: "direct", keys: ["h264High"],
        gate: all(needNvenc, needDirect, needH264), ...onOff("h264High"),
        hint: (
          <>
            Constrained High (CABAC + 8×8) when this device's decoder supports it — 12–24 % fewer bits for the same
            picture at the same latency. Drops back to Baseline by itself if it won't decode. The header shows{" "}
            <b>High</b> when it's live.
          </>
        ),
      },
      {
        id: "rfi", kind: "choice", label: "Drop recovery", scope: "direct", keys: ["rfi"],
        gate: all(needNvenc, needDirect, needH264),
        options: [
          { value: "auto", label: "Auto" },
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ],
        get: (t) => t.rfi, set: (v) => ({ rfi: v as StreamTune["rfi"] }),
        hint: (
          <>
            When the PC must drop a frame to a backed-up link, it tells the encoder to skip it instead of sending a
            keyframe — the picture stays sharp and keeps moving. Needs a 4-frame reference buffer here. <b>Auto</b>{" "}
            uses it on decoders known to handle that at full speed (Qualcomm, like Moonlight). The <b>RFI</b> stat
            counts it.
          </>
        ),
      },
      {
        id: "preset", kind: "choice", label: "Encoder preset", scope: "host", keys: ["encPreset"], gate: needNvenc,
        options: [1, 2, 3, 4].map((p) => ({ value: p, label: `P${p}` })),
        get: (t) => t.encPreset, set: (v) => ({ encPreset: Number(v) }),
        hint: (
          <>
            NVENC quality vs speed. <b>P2</b> (default) is as fast as P1 with a visibly cleaner picture at the same
            bitrate; <b>P3/P4</b> spend ~0.6–0.8 ms more per frame for a little more. Changing it restarts the encoder
            (one keyframe).
          </>
        ),
      },
      {
        id: "passes", kind: "choice", label: "Encoder passes", scope: "host", keys: ["encMultipass"], gate: needNvenc,
        options: [
          { value: 0, label: "1" },
          { value: 1, label: "2 · ¼" },
          { value: 2, label: "2" },
        ],
        get: (t) => t.encMultipass, set: (v) => ({ encMultipass: Number(v) }),
        hint: "One pass (default), or two-pass rate control at quarter / full resolution: steadier frame sizes on a tight link, but a softer picture in testing. Try it only if bursts cause hitches.",
      },
      {
        id: "nvencFast", kind: "toggle", label: "Fast delivery (experimental)", scope: "host", keys: ["nvencFast"],
        gate: all(needNvenc, needDirect), ...onOff("nvencFast"),
        hint: "Limits queued video on the PC and sends smaller chunks so input and sound get more frequent turns. Same picture. Off restores classic delivery immediately.",
      },
      {
        id: "jpeg", kind: "slider", label: "JPEG quality", scope: "host", keys: ["jpeg"], gate: jpegOnly,
        min: 20, max: 95, step: 1, get: (t) => t.jpeg, set: (v) => ({ jpeg: v }), fmt: (v) => `${v}`,
        hint: "Quality of the intermediate JPEG on the non-NVENC path (it's re-encoded to H.264 after). Raising it burns PC CPU for a win H.264 mostly discards.",
      },
      {
        id: "jpegCap", kind: "slider", label: "JPEG quality cap", scope: "host", keys: ["jpegCap"], gate: jpegOnly,
        min: 40, max: 95, step: 1, get: (t) => t.jpegCap, set: (v) => ({ jpegCap: v }), fmt: (v) => `${v}`,
        hint: "Hard ceiling on JPEG quality, applied even if the slider above is higher — ~400 KB frames were burning PC IPC for no visible gain.",
      },
    ],
  },
  {
    id: "connection",
    title: "Connection",
    icon: Wifi,
    blurb: "How video travels from the PC to this device.",
    items: [
      {
        id: "direct", kind: "toggle", label: "Direct (WebCodecs)", scope: "direct", keys: ["preferDirect"],
        ...onOff("preferDirect"),
        hint: "Decode the video straight off the connection instead of the browser's video pipeline — skips the jitter buffer, the biggest single chunk of lag. Leave on; turn off only to compare against the RTC path.",
      },
      {
        id: "transport", kind: "choice", label: "Video transport", scope: "direct", keys: ["videoTransport"],
        gate: needDirect,
        options: [
          { value: "auto", label: "Auto" },
          { value: "sctp", label: "Data" },
          { value: "rtp", label: "RTP" },
        ],
        get: (t) => t.videoTransport, set: (v) => ({ videoTransport: v as StreamTune["videoTransport"] }),
        hint: (
          <>
            <b>Auto</b>: the data channel while the connection is clean (a few ms faster), the RTP carrier as soon as
            it loses packets — where the data channel would stall for hundreds of ms. <b>Data</b> / <b>RTP</b> force
            one. The header shows <b>RTP</b> while the carrier is in use.
          </>
        ),
      },
      {
        id: "refresh", kind: "slider", label: "Refresh every", scope: "direct", keys: ["wcKeyMs"], gate: needDirect,
        min: 1000, max: 30000, step: 1000, get: (t) => t.wcKeyMs, set: (v) => ({ wcKeyMs: v }),
        fmt: (v) => `${(v / 1000).toFixed(0)} s`,
        hint: "Safety-net cadence: an intra-refresh wave with NVENC (no blurry keyframe on a still screen), a keyframe otherwise. Real breaks ask for their own keyframe, so long is good; short costs bandwidth.",
      },
      {
        id: "bufCap", kind: "slider", label: "Send buffer cap", scope: "direct", keys: ["wcBufKB"], gate: needDirect,
        min: 64, max: 1024, step: 32, get: (t) => t.wcBufKB, set: (v) => ({ wcBufKB: v }), fmt: (v) => `${v} KB`,
        hint: "Byte ceiling for unsent video. Standing delay is already capped at ~50 ms of the live bitrate — this only matters above that on fast links. Low = skip stale frames sooner; high = more headroom.",
      },
      {
        id: "queueCap", kind: "slider", label: "Encoder queue cap", scope: "direct", keys: ["wcQueueMax"],
        gate: needDirect, min: 1, max: 6, step: 1, get: (t) => t.wcQueueMax, set: (v) => ({ wcQueueMax: v }),
        fmt: (v) => `${v}`,
        hint: "Frames allowed inside the PC's encoder before it starts skipping. The same trade as above, one stage earlier.",
      },
      {
        id: "retry", kind: "slider", label: "Direct retry", scope: "direct", keys: ["directRetrySec"],
        gate: needDirect, min: 5, max: 120, step: 5, get: (t) => t.directRetrySec,
        set: (v) => ({ directRetrySec: v }), fmt: (v) => `${v} s`,
        hint: "How soon to try Direct again after it falls back to RTC. Doubles on repeat failures up to 2 min; a clean spell resets it.",
      },
    ],
  },
  {
    id: "phone",
    title: "Phone",
    icon: Smartphone,
    blurb: "How this device decodes and buffers the video.",
    items: [
      {
        id: "mediacodec", kind: "toggle", label: "Hardware decoder (MediaCodec)", scope: "direct",
        keys: ["preferNativeDecode"], gate: all(nativeOnly, needDirect), ...onOff("preferNativeDecode"),
        hint: (
          <>
            Feeds the video to Android's hardware decoder and paints it under the app — the lowest decode time. Off
            forces WebCodecs. The header shows <b>MediaCodec</b> when it's live.
          </>
        ),
      },
      {
        id: "videoLayer", kind: "choice", label: "Video layer (experimental)", scope: "direct", keys: ["videoLayer"],
        gate: all(nativeOnly, needDirect, needMediaCodec),
        options: [
          { value: "texture", label: "Texture" },
          { value: "surface", label: "Surface" },
        ],
        get: (t) => t.videoLayer, set: (v) => ({ videoLayer: v as StreamTune["videoLayer"] }),
        hint: (
          <>
            Where the hardware decoder paints. <b>Texture</b> (default) composites the video inside the app — the fix
            for Android 16's smeared-overlay bug. <b>Surface</b> hands frames straight to the display (can skip a GPU
            pass, about one frame sooner) but brings back the see-through window that bug came from. Switching rebuilds
            the decoder (one keyframe); keep Surface only if overlays look clean here.
          </>
        ),
      },
      {
        id: "jbBase", kind: "slider", label: "Jitter buffer", scope: "rtc", keys: ["jbBase", "jbMin"], gate: rtcVideoOnly,
        min: 20, max: 200, step: 5, get: (t) => t.jbBase, set: (v, t) => ({ jbBase: v, jbMin: Math.min(t.jbMin, v) }),
        fmt: (v) => `${v} ms`,
        hint: "Resting playout delay this device asks for on the RTC path. It's a minimum — the browser pads above it on its own. This is the delay Direct exists to skip.",
      },
      {
        id: "jbMin", kind: "slider", label: "Jitter buffer floor", scope: "rtc", keys: ["jbMin"], gate: rtcVideoOnly,
        min: 20, max: 200, step: 5, get: (t) => t.jbMin, set: (v, t) => ({ jbMin: Math.min(v, t.jbBase) }),
        fmt: (v) => `${v} ms`,
        hint: "Floor the buffer eases back to on a clean link (never above the resting delay). Never 0 — that trades delay for stutter.",
      },
      {
        id: "jbMax", kind: "slider", label: "Jitter buffer ceiling", scope: "rtc", keys: ["jbMax"], gate: rtcVideoOnly,
        min: 40, max: 400, step: 10, get: (t) => t.jbMax, set: (v, t) => ({ jbMax: Math.max(v, t.jbBase) }),
        fmt: (v) => `${v} ms`,
        hint: "How far the buffer may grow when frames genuinely arrive late.",
      },
      {
        id: "jbGrow", kind: "slider", label: "Grow buffer at", scope: "rtc", keys: ["jbGrowAt"], gate: rtcVideoOnly,
        min: 5, max: 40, step: 1, get: (t) => t.jbGrowAt, set: (v) => ({ jbGrowAt: v }), fmt: (v) => `${v}% drops`,
        hint: "Dropped-frame share that makes the buffer grow. Low = react early and add delay; high = tolerate drops to stay responsive.",
      },
    ],
  },
  {
    id: "sound",
    title: "Sound",
    icon: Volume2,
    blurb: "How the PC's sound reaches this device.",
    items: [
      {
        id: "directAudio", kind: "toggle", label: "PC sound (DIRECT)", scope: "direct", keys: ["preferDirectAudio"],
        ...onOff("preferDirectAudio"),
        hint: (
          <>
            <b>On</b>: Opus over a high-priority, time-bounded channel into an adaptive player (~65 ms) with smooth gap
            repair. <b>Off</b>: the classic WebRTC audio track. Turn off only if DIRECT sound still crackles on a flaky
            link. The header shows <b>AUD·DIRECT</b> / <b>AUD·RTC</b>.
          </>
        ),
      },
      {
        id: "studio", kind: "toggle", label: "Studio sound", scope: "direct", keys: ["audioStudio"], gate: needDirectAudio,
        ...onOff("audioStudio"),
        hint: (
          <>
            Smaller packets, Opus low-delay mode, and every packet sent twice on a channel that never waits — a lost
            packet is repaired instead of concealed, which is what the metallic edge was. Costs ~260 kb/s. The header
            shows <b>AUD·STUDIO</b>.
          </>
        ),
      },
      {
        id: "audJb", kind: "slider", label: "RTC sound delay", scope: "rtc", keys: ["audioJbMs"], gate: rtcAudioOnly,
        min: 0, max: 400, step: 10, get: (t) => t.audioJbMs, set: (v) => ({ audioJbMs: v }),
        fmt: (v) => (v === 0 ? "auto" : `${v} ms`),
        hint: "Playout delay asked of the browser's audio buffer on the RTC path (0 = browser auto, ~150–250 ms). A minimum — too low and it pays with choppy concealment.",
      },
      {
        id: "audHost", kind: "slider", label: "PC sound buffer", scope: "host", keys: ["audioHostMs"], gate: rtcAudioOnly,
        min: 20, max: 200, step: 5, get: (t) => t.audioHostMs, set: (v) => ({ audioHostMs: v }),
        fmt: (v) => `${v} ms`,
        hint: "The PC's own sound buffer before encoding the RTC track. 90 ms absorbs game-load jitter; 55 ms crackled. Lower trims lag.",
      },
    ],
  },
];

/** A knob's value differs from the shipped default. */
export function itemChanged(item: TuneItem, t: StreamTune): boolean {
  return item.keys.some((k) => t[k] !== STREAM_TUNE_DEFAULTS[k]);
}

/** Shipped defaults for every key a group owns (per-group reset). */
export function groupDefaults(group: TuneGroup): Partial<StreamTune> {
  const out: Partial<StreamTune> = {};
  for (const item of group.items) {
    for (const k of item.keys) (out as Record<string, unknown>)[k] = STREAM_TUNE_DEFAULTS[k];
  }
  return out;
}

const TAB_KEY = "gt.remote.tuneTab";

function readTab(): string {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (v && TUNE_GROUPS.some((g) => g.id === v)) return v;
  } catch {
    /* storage unavailable */
  }
  return TUNE_GROUPS[0].id;
}

export function TuneSheet({
  open,
  tune,
  patch,
  onReset,
  onClose,
  hints,
  onHints,
  env,
}: {
  open: boolean;
  tune: StreamTune;
  patch: (p: Partial<StreamTune>) => void;
  onReset: () => void;
  onClose: () => void;
  hints: boolean;
  onHints: (on: boolean) => void;
  env: TuneEnv;
}) {
  const [tab, setTab] = useState(readTab);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const group = TUNE_GROUPS.find((g) => g.id === tab) ?? TUNE_GROUPS[0];

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage unavailable */
    }
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [tab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  const groupCustom = group.items.some((i) => itemChanged(i, tune));

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Stream tuning"
        className="flex h-[min(92dvh,56rem)] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-[#0c0f16] text-ink-soft shadow-float sm:rounded-3xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <header className="flex items-center gap-2 px-4 pb-2 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-800 text-white">
              Stream tuning
              {streamTuneIsCustom(tune) && (
                <span className="rounded-full bg-amber/20 px-2 py-0.5 text-xs font-700 text-amber">custom</span>
              )}
            </h2>
            <p className="text-xs text-ink-faint">Changes apply live.</p>
          </div>
          <button
            type="button"
            aria-pressed={hints}
            onClick={() => onHints(!hints)}
            className={`flex h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-700 ${
              hints ? "bg-accent-3/20 text-accent-3" : "bg-white/[0.08] text-ink-dim"
            }`}
          >
            <Info className="h-4 w-4" /> {hints ? "Hide help" : "Help"}
          </button>
          <button
            type="button"
            aria-label="Close tuning"
            onClick={onClose}
            className="grid h-11 w-11 place-items-center rounded-xl bg-white/[0.08] text-white active:bg-white/[0.16]"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <nav
          role="tablist"
          aria-label="Setting groups"
          className="flex gap-2 overflow-x-auto px-4 pb-3 pt-1"
          style={{ scrollbarWidth: "none" }}
        >
          {TUNE_GROUPS.map((g) => {
            const Icon = g.icon;
            const active = g.id === group.id;
            const changed = g.items.some((i) => itemChanged(i, tune));
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(g.id)}
                className={`relative flex h-11 shrink-0 items-center gap-2 rounded-xl px-3.5 text-sm font-700 transition-colors ${
                  active ? "bg-accent-3 text-black" : "bg-white/[0.07] text-ink-soft active:bg-white/[0.14]"
                }`}
              >
                <Icon className="h-4 w-4" />
                {g.title}
                {changed && (
                  <span
                    aria-label="changed"
                    className={`h-2 w-2 rounded-full ${active ? "bg-black/70" : "bg-amber"}`}
                  />
                )}
              </button>
            );
          })}
        </nav>

        <div
          ref={scrollRef}
          role="tabpanel"
          className="flex-1 overflow-y-auto overscroll-contain border-t border-white/[0.08] px-4 py-4"
          style={{ touchAction: "pan-y" }}
        >
          <p className="mb-4 text-sm leading-relaxed text-ink-faint">{group.blurb}</p>
          <div className="space-y-3">
            {group.items.map((item) => (
              <TuneCard key={item.id} item={item} tune={tune} env={env} patch={patch} hints={hints} />
            ))}
          </div>
          <p className="mt-5 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
            Tags:
            {(Object.keys(SCOPE_STYLE) as TuneScope[]).map((s) => (
              <span key={s} className="flex items-center gap-1">
                <ScopeTag scope={s} /> {SCOPE_TITLE[s].replace("Acts on ", "")}
              </span>
            ))}
          </p>
        </div>

        <footer className="flex gap-2 border-t border-white/[0.08] px-4 py-3">
          <button
            type="button"
            disabled={!groupCustom}
            onClick={() => patch(groupDefaults(group))}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-white/[0.07] text-sm font-800 text-white active:bg-white/[0.14] disabled:opacity-40"
          >
            <RotateCcw className="h-4 w-4" /> Reset {group.title}
          </button>
          <button
            type="button"
            disabled={!streamTuneIsCustom(tune)}
            onClick={onReset}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-white/15 text-sm font-800 text-white active:bg-white/[0.1] disabled:opacity-40"
          >
            <RotateCcw className="h-4 w-4" /> Reset all
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function ScopeTag({ scope }: { scope: TuneScope }) {
  return (
    <span
      title={SCOPE_TITLE[scope]}
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-800 uppercase leading-none ${SCOPE_STYLE[scope]}`}
    >
      {scope}
    </span>
  );
}

function TuneCard({
  item,
  tune,
  env,
  patch,
  hints,
}: {
  item: TuneItem;
  tune: StreamTune;
  env: TuneEnv;
  patch: (p: Partial<StreamTune>) => void;
  hints: boolean;
}) {
  const gate = item.gate?.(tune, env) ?? null;
  const locked = !!gate && !gate.soft;
  const changed = itemChanged(item, tune);
  return (
    <section
      aria-label={item.label}
      className={`rounded-2xl border p-3.5 ${changed ? "border-amber/30" : "border-white/[0.07]"} ${
        gate?.soft ? "bg-white/[0.02]" : "bg-white/[0.04]"
      }`}
    >
      <div className="flex min-h-11 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className={`text-[15px] font-700 leading-tight ${locked ? "text-ink-dim" : "text-white"}`}>
            {item.label}
          </span>
          <ScopeTag scope={item.scope} />
          {changed && <span className="text-[11px] font-700 text-amber">changed</span>}
        </div>
        {item.kind === "toggle" && (
          <Switch
            label={item.label}
            on={item.get(tune)}
            disabled={locked}
            onChange={(on) => patch(item.set(on))}
          />
        )}
        {item.kind === "slider" && (
          <span className={`shrink-0 text-[15px] font-800 tabular-nums ${locked ? "text-ink-dim" : "text-white"}`}>
            {item.fmt(item.get(tune))}
          </span>
        )}
      </div>
      {gate && <GateNote gate={gate} patch={patch} />}
      {item.kind === "slider" && (
        <Slider item={item} tune={tune} disabled={locked} onChange={(v) => patch(item.set(v, tune))} />
      )}
      {item.kind === "choice" && (
        <div
          role="radiogroup"
          aria-label={item.label}
          className="mt-2.5 grid gap-1.5 rounded-xl bg-white/[0.05] p-1"
          style={{ gridTemplateColumns: `repeat(${item.options.length}, minmax(0, 1fr))` }}
        >
          {item.options.map((o) => {
            const selected = item.get(tune) === o.value;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={locked}
                onClick={() => patch(item.set(o.value))}
                className={`h-11 rounded-lg text-sm font-800 transition-colors disabled:opacity-40 ${
                  selected ? "bg-green/25 text-green ring-1 ring-green/40" : "text-ink-dim active:bg-white/[0.1]"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
      {hints && (
        <div className="mt-2.5 text-[13px] leading-relaxed text-ink-faint [&_b]:font-700 [&_b]:text-ink-soft">
          {item.hint}
        </div>
      )}
    </section>
  );
}

function GateNote({ gate, patch }: { gate: NonNullable<Gate>; patch: (p: Partial<StreamTune>) => void }) {
  return (
    <div
      className={`mt-2.5 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-[13px] leading-snug ${
        gate.soft ? "bg-white/[0.05] text-ink-dim" : "bg-amber/10 text-amber"
      }`}
    >
      {gate.soft ? <Info className="h-4 w-4 shrink-0" /> : <Lock className="h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1">{gate.reason}</span>
      {gate.fix && (
        <button
          type="button"
          onClick={() => patch(gate.fix!)}
          className="h-10 rounded-lg bg-amber/20 px-3 text-sm font-800 text-amber active:bg-amber/30"
        >
          {gate.fixLabel ?? "Fix"}
        </button>
      )}
    </div>
  );
}

function Switch({
  label,
  on,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        on ? "bg-green/70" : "bg-white/[0.16]"
      }`}
    >
      <span
        className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-[left] ${on ? "left-7" : "left-1"}`}
      />
    </button>
  );
}

function Slider({
  item,
  tune,
  disabled,
  onChange,
}: {
  item: Extract<TuneItem, { kind: "slider" }>;
  tune: StreamTune;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const { min, max, step } = item;
  const v = item.get(tune);
  const snap = (x: number) => Math.min(max, Math.max(min, Number((Math.round((x - min) / step) * step + min).toFixed(6))));
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  const stepBtn =
    "grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/[0.08] text-white active:bg-white/[0.16] disabled:opacity-35";
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Decrease ${item.label}`}
          disabled={disabled || v <= min}
          onClick={() => onChange(snap(v - step))}
          className={stepBtn}
        >
          <Minus className="h-5 w-5" />
        </button>
        <input
          type="range"
          aria-label={item.label}
          min={min}
          max={max}
          step={step}
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(snap(Number(e.target.value)))}
          className="tune-range min-w-0 flex-1"
          style={{ "--fill": `${pct}%` } as CSSProperties}
        />
        <button
          type="button"
          aria-label={`Increase ${item.label}`}
          disabled={disabled || v >= max}
          onClick={() => onChange(snap(v + step))}
          className={stepBtn}
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>
      <div className="mt-0.5 flex justify-between px-[3.25rem] text-[11px] tabular-nums text-ink-faint">
        <span>{item.fmt(min)}</span>
        <span>{item.fmt(max)}</span>
      </div>
    </div>
  );
}
