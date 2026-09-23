# Remote streaming research (September 2026)

Deep research + measurements on the DIRECT desktop→phone pipeline (AGENTS.md §13/§15):
DXGI zero-copy → D3D11 composite → NVENC H.264 → loopback pipe → WebView2 → SCTP data
channel → Android MediaCodec / WebCodecs. Measured on the dev PC (RTX 4070 Ti, driver 596.21,
Edge/Chromium 153, ffmpeg 8.1 + libvmaf) and read-only adb queries of the Moto g57 power.

Labels: **VERIFIED-HERE** = measured on this machine · **SOURCED** = docs/source/other projects ·
**SPECULATIVE** = reasoned, not tested. The lab harnesses (transport emulator, NVENC `nvlab`
crate, encoder scripts) lived in the session scratchpad and are not in the repo; the numbers
below are the record.

## Status

| # | Item | Status |
|---|---|---|
| R1 | 4 KB data-channel fragments | **Shipped 3.9.102** (`VIDEO_FRAGMENT_BYTES`) |
| R2 | No periodic IDR on still screens; intra-refresh wave + refinement burst | **Shipped 3.9.102** (re-verified: `still_screen_refinement`) |
| R10 | P-frame min QP 12 | **Shipped 3.9.102** (`MIN_QP_P`) |
| R8 (colour) | NVENC matrix follows the VUI label; probe at 1080p | **Shipped 3.9.102** (docs corrected) |
| R3 | H.264 High + CABAC (Constrained High) for known-good decoders | Next — needs guest capability opt-in + fallback |
| R6 | Loss-aware SCTP ceiling from `audio2` gaps | Next |
| R5 | DIRECT over RTP with a VP8 "append carrier" | Planned — large; needs on-device spike |
| R4 | Reference-frame invalidation instead of recovery IDRs | Planned — pairs with R5 |
| R7 | ABR v2: delay-gradient + overshoot correction | Planned (moot on the R5 path) |
| R8 | HEVC low-bandwidth mode | Planned |
| R9 | SurfaceView vs TextureView A/B | Needs per-device A/B |
| — | Cap this phone's LL decoder at 30 Mb/s | Next (small) |

---

## 1. Top 10 changes

Ranked by (expected gain × confidence) ÷ effort. Transport latency = one-way, `send()` on
the host page → frame complete on the receiver, Chromium 153 ↔ Chromium 153 through a UDP
loss/delay emulator. The phone was not in that loop.

| # | Change | Expected measurable effect | Effort | Label |
|---|---|---|---|---|
| 1 | ≤ 4 KB SCTP messages instead of 60 KB / 16 KB | Zero loss p50 19.7 → **8.5 ms** (6 ms RTT), 22.6 → **15.5 ms** (20 ms RTT); p90 40 → 15 ms | 1 line | VERIFIED-HERE |
| 2 | Stop the 10 s periodic IDR (intra-refresh wave instead); refinement burst after IDRs / when still | Static text time-average PSNR-Y 28.3 → **62.1 dB** (6 Mb/s code page), 39.2 → 63.5 dB (16 Mb/s web page) | small | VERIFIED-HERE |
| 3 | H.264 High + CABAC + 8×8 (Constrained High) for known-good decoders | **−12 % to −24 %** BD-rate on motion content; +1.6–2.6 dB on desktop content at 10–15 % fewer bits; encode time unchanged | small–medium | VERIFIED-HERE, SOURCED |
| 4 | Reference-frame invalidation (DPB 2, `nvEncInvalidateRefFrames`) instead of recovery IDRs | After a lost frame, next frames decode at **56–58 dB** (IDR path 25 dB, slow climb); recovery frame 1.0–1.2× a P-frame vs 1.2–2.5× | medium | VERIFIED-HERE, SOURCED |
| 5 | DIRECT over RTP via a tiny VP8 track + encoded-transform "append carrier" | 0.1 % loss @ 6 ms RTT: SCTP p90 178 ms vs **26 ms**; 2 % loss: SCTP 2.6 Mb/s @ 934 ms vs **15.6 Mb/s @ 25 ms**, 0 frames lost. Zero-loss cost: +5–10 ms | large (3–5 days) | VERIFIED-HERE (Chromium↔Chromium) |
| 6 | Loss-aware SCTP ceiling `B ≤ 0.6·0.85·MSS·8/(RTT·√p)`, `p` from `audio2` gaps | Keeps DIRECT out of the collapse regime (p50 0.3–1.4 s); SCTP goodput fits Mathis at 0.6–0.9× | small | VERIFIED-HERE (fit) |
| 7 | ABR v2: delay-gradient (GCC trendline) + NVENC overshoot correction | Overuse detection ~0.2–0.3 s instead of ~1 s (SPECULATIVE); a 3 Mb/s target actually produced **4.5 Mb/s** (VERIFIED) | small–medium | mixed |
| 8 | HEVC as a low-bandwidth mode (not AV1) | **−27 % to −54 %** BD-rate on motion; encode 1.9–2.0 ms; phone HEVC decode 85 fps vs AVC 132 fps (~+4 ms) | medium–large | VERIFIED-HERE, SOURCED |
| 9 | A/B SurfaceView (HWC overlay) vs TextureView on the APK | ~1 display frame less (≈8 ms @ 120 Hz), no GPU composition pass | medium | SOURCED |
| 10 | P-frame min QP ≈ 10–12 | Still screen keep-alive **3.7 KB → 25 B**; post-IDR refinement −18 % bytes; −2.7 dB on content already at 54 dB | 1 line | VERIFIED-HERE |

**The structural finding (#5):** with the browser's SCTP data channel, *any* packet loss —
even 0.1 % — becomes hundreds of milliseconds of stall regardless of reliability mode.
The browser's RTP stack does not, and can be used without giving up DIRECT's "decode it
ourselves, no jitter buffer" property.

## 2. The phone (Moto g57 power, read-only adb)

| Item | Value |
|---|---|
| SoC | Snapdragon 6s Gen 4 (SM6435 "parrot"): 4× A78 @ 2.4 GHz + 4× A55 @ 1.8 GHz |
| OS / WebView / Chrome | Android 17 (SDK 37) · WebView 151 · Chrome 153 |
| Display | 1080×2400, 120/90/60/30 Hz |
| Wi-Fi | 802.11ac 5 GHz, 433 Mb/s PHY; the app's low-latency lock is being acquired (works) |
| AVC HW | `c2.qti.avc.decoder` (+ `.low_latency`, `.secure`), ≤ 2560×1440, perf points 720p@120 / **1080p@60** / 1440p@30, CTS 1080p **132 fps**. Baseline, CB, Main, **High, Constrained High @ L5**. `.low_latency` declares **1–30 Mb/s** |
| HEVC HW | Main only, CTS 1080p **85 fps** |
| VP9 HW | ≤ 1440p60 |
| AV1 | **software only** (dav1d / libgav1) |
| 4:4:4 | none |

So: 1080p60 is the ceiling; cap this decoder at 30 Mb/s (`bitrateFor()` can ask 40);
no AV1; no 4:4:4 text.

## 3. Details

### R1 — 4 KB fragments (shipped)

Same reliable ordered channel, same bytes; only message size changed. 16 Mb/s real NVENC
frame-size trace, zero loss:

| message | 6 ms RTT p50/p90/p99 (ms) | 20 ms RTT p50/p90/p99 (ms) |
|---|---|---|
| 60 KB | 19.7 / 40.1 / 50.0 | 22.6 / 34.2 / 45.4 |
| 16 KB | 12.7 / 29.1 / 39.1 | 21.6 / 30.4 / 50.4 |
| **4 KB** | **8.5 / 15.2 / 17.3** | **15.6 / 18.8 / 24.7** |
| 1150 B | 8.6 / 14.9 / 17.3 | 15.6 / 18.9 / 27.8 |

Message interleaving (the other fix) is field-trial gated on both peers
(`WebRTC-DataChannelMessageInterleaving`), so the Android WebView guest can't enable it.
Does not help under loss.

### R2 — still-screen blur (shipped)

Cause: the 10 s periodic IDR + 700 ms keep-alive + ULL/CBR/2-frame VBV. An IDR of a detailed
still is squeezed into ~2 frames of budget: 25.0 dB (code page, 6 Mb/s), 25.6 dB (web, 6 Mb/s),
30.9 dB (web, 16 Mb/s), needing 24–42 encodes to converge — 17–29 s at the keep-alive rate,
longer than the IDR period, so it never sharpened. `lowDelayKeyFrameScale` has no effect at
2-frame VBV (bit-identical); a bigger VBV hurts steady quality.

Shipped as: periodic intra-refresh wave (30 s default) + a frame-cadence refinement burst
(see AGENTS.md §16 for the exact stop rule — note the "tiny frames" rule must be gated on QP,
because right after an IDR the rate control emits ~250 B skip frames while the VBV drains).

### R3 — H.264 High + CABAC (next)

The Baseline choice cites Moonlight errata #8, which concerns one device (Intel Nexus Player,
Android < 6) that later needed Constrained High (#9). Sunshine defaults to CABAC.

- ffmpeg BD-rate vs shipped Baseline+CAVLC (payload bits, filler stripped): window drag
  −22.7 %, game pan −23.9 %, fractal −11.7 %, grain −12.1 %; VMAF-based −14 to −39 %.
- Repo-config NVENC harness (web scroll): +1.63 dB @ 6 Mb/s with fewer bits (2.53 vs 2.79 Mb/s);
  encode 1.12–1.40 ms High vs 1.11–1.38 ms Baseline.
- Plan: `apply_h264_guest_friendly` → High profile, CABAC, adaptive 8×8; `sps::rewrite_rbsp`
  sets `constraint_set4|set5` for `profile_idc == 100` (Constrained High); announce
  `avc1.640C2A`. Enable only when the guest reports a capable decoder (`c2.qti.*`,
  `c2.exynos.*`, `c2.mtk.*`, or WebCodecs `isConfigSupported`); fall back on any decode error.
  (The current announce `avc1.42C028` names level 4.0; the SPS already says 4.2.)

### R4 — reference-frame invalidation (planned)

Drop frame 70, decode the rest (web page, 6 Mb/s):

| recovery | recovery frame | PSNR +1…+10 | +20 / +29 |
|---|---|---|---|
| none | 11.2 KB | 14.9 → 15.8 dB | 17.0 / 18.1 |
| IDR (current) | 26.6 KB | 25.0 → 29.4 dB | 34.6 / 41.4 |
| IR wave (10 frames) | 62.6 KB | 15.3 → 41.1 dB | 41.8 / 47.3 |
| **RFI, DPB 2** | **12.8 KB** | **56.3 → 57.8 dB** | 57.8 / 58.8 |

RFI only works if the SPS declares the larger DPB — the current `sps::fixup_into` forces 1 ref,
and a 2-ref stream then decodes as garbage even before the loss. Plan: `maxNumRefFrames=2`,
`numRefL0=1`; `sps.rs` writes `max_num_ref_frames` / `max_dec_frame_buffering` = refs (reorder 0);
add `invalidate(ts)` over the existing FFI slot; host drops call it instead of forcing an IDR.
Moonlight enables AVC RFI for `c2.qti` (excluding low-end SD 200/410/415/430/435/616 above 720p).

### R5 — DIRECT over RTP, VP8 append carrier (planned)

Why SCTP can't be fixed from JS: congestion control is per-association and loss-based (every
loss halves cwnd, RFC 4960 §7.2.3; all channels share it, RFC 8831), and dcSCTP has
`rto_min` 400 ms, delayed-ack 200 ms, `min_rtt_variance` 220 ms. Unordered + FEC collapses the
same way (5.0 Mb/s at 0.5 % loss with 20 % RS); `maxPacketLifeTime` destroys video (93–99.7 %
frames lost — lifetime counts from submission).

Design (all tested in Chromium): host adds a video transceiver fed by a
`MediaStreamTrackGenerator` of 64×64 dummy frames (VP8 + RTX); the sender encoded transform
appends the NVENC AU + a 20-byte trailer `[seq u32][captureMs f64][dummyLen u32]["GTAU"]`.
The guest's receiver transform runs before the jitter buffer, cuts the AU off, feeds the
existing decode path, and re-enqueues the untouched VP8 frame (no PLI storms). VP8 not H.264
as the carrier: libwebrtc's packet buffer head-of-line-blocks H.264 deltas and a starved H.264
decoder PLIs ~3×/s.

| condition | reliable SCTP (60 KB / 16 KB) | RTP VP8 carrier |
|---|---|---|
| 0 %, 20 ms | p50 22.5 / 21.0, p99 45 | p50 25.0, p99 36.8 |
| 0.5 %, 20 ms | 6.4 / 5.5 Mb/s, p50 300 / 386, 60–65 % frames skipped | **15.6 Mb/s, p50 24.7, p99 49, 0 lost** |
| 2 %, 20 ms | 2.6 Mb/s, p50 934 | **15.6 Mb/s, p50 25.1, p99 66, 0 lost** |
| 5 %, 20 ms | 1.8 Mb/s, p50 1332 | 15.6 Mb/s, p50 28.7, p90 193 |
| 2 % bursty, 20 ms | 3.3 / 4.3 Mb/s, p50 457 / 488 | 15.6 Mb/s, p50 24.9, p99 55 |
| 0.1 %, 6 ms (LAN) | 16 KB: p50 24, **p90 178**, p99 298 | **p50 18.3, p90 25.6, p99 30.4** |
| 0.1 %, 40 ms | 6.5 Mb/s, p50 292 | 15.5 Mb/s, p50 35.2 |
| 30 Mb/s, 0.1 %, 20 ms | 11.4 Mb/s, p50 414 | **29.1 Mb/s, p50 26.0** |

Policy: hybrid — 4 KB SCTP while measured loss is 0, RTP carrier otherwise (negotiate both up
front; switching needs no keyframe). Rate control on the RTP path: NVENC bitrate =
`min(0.9 · outbound-rtp.targetBitrate, tune target)` every 250 ms. The answer munge must add
`x-google-start-bitrate` for VP8 too (without it: 1.4 s latency from GCC's 300 kb/s start).
Run `RTCRtpScriptTransform` in a Worker (Chrome 141+; guest WebView is 151). First step: a
one-hour on-device spike confirming WebView delivers receiver-transform frames.

### R6 — loss-aware SCTP ceiling (next)

```
C_sctp ≈ 0.85 · MSS·8 / (RTT · √p)     MSS ≈ 1150 B
B_max  = 0.6 · C_sctp
switch to RTP (R5) when C_sctp < 1.5 · B_desired
```
`p` = raw `audio2` sequence gaps (before RED repair) over 5 s; RTT from the candidate pair;
clamp in `adaptFromReport`; show loss % and `C_sctp` in the HUD.

### R7 — ABR v2 signal (planned)

OWD is taken at frame completion (includes serialization), rise-clamped, EWMA'd twice and acted
on above 110 ms → ~1 s to detect a queue. NVENC ULL over-delivers low targets on complex
content (3 → 4.5 Mb/s; 6 → 7.5 Mb/s at 1-frame VBV). Proposals: first-fragment delay gradient
with GCC's trendline + adaptive threshold; dispersion capacity estimate; command =
target · target / measured_out.

### R8 — HEVC low-bandwidth mode; colour (colour shipped)

BD-rate vs Baseline: HEVC −27 to −54 %, AV1 −44 to −53 % (no AV1 decoder on this phone). HEVC
encode 1.93–2.05 ms. **NVENC picks its RGB→YUV matrix from the VUI label; unlabelled, BT.601 at
256×256 but BT.709 at 1080p** (H.264, HEVC, AV1 alike) — any new codec must label explicitly.
Use HEVC only when link-limited below ~8 Mb/s.

### R9 — SurfaceView A/B (needs devices)

TextureView costs an extra GPU composition pass (≥ 1 frame); SurfaceView can go to a HWC
overlay. TextureView was chosen for an Android 16 WebView artefact, so A/B per device and check
`dumpsys SurfaceFlinger` for DEVICE composition.

### R10 — P-frame min QP (shipped)

| min QP | keep-alive | steady PSNR | post-IDR refinement |
|---|---|---|---|
| none | 3.7 KB | 54.4 dB | 354 KB |
| 12 | 25 B | 51.7 dB | 275 KB |
| 18 | – | 47 dB | 210 KB |

## 4. Not worth doing

| Idea | Why not |
|---|---|
| FEC over unordered data channels | throughput still collapses (shared loss-based cwnd): 5.0 Mb/s @ 0.5 % loss |
| `maxPacketLifeTime` on data channels | messages expire in the send queue: 93–99.7 % frames lost |
| unordered, 0 retransmits, no FEC | 14.6 % frames lost @ 0.5 % loss, plus the collapse |
| VBV ≥ 3 frames | RC under-spends on desktop: 52.5 → 47.4 dB |
| `lowDelayKeyFrameScale` | bit-identical at 2-frame VBV |
| AV1 / 4:4:4 on this phone | no decoder |
| H.264 as the RTP carrier | packet-buffer HOL + PLI storm |
| SCTP interleaving, FlexFEC, SCReAM, L4S | field trials on both peers / ECN networks |
| WGC, D3D12, CUDA interop, NVENC async | encode is already 1.1–1.4 ms zero-copy |
| P3/P4, two-pass | +0.6–0.8 ms for ~0.2 dB (already measured) |
| dirty/move-rect ME hints | scroll already encodes at QP 0–1 for a few KB |
| Kalman clock sync, frame extrapolation | low value for desktop content |

Other notes: ffmpeg's `h264_nvenc` CBR pads with filler NALs (86.7 % of bytes on a still code
page) — strip filler before comparing (our FFI config emits none). The optimal constant playout
delay is `D* = F⁻¹(λ/(λ+c))` for delay distribution F — the "Feel" slider is exactly this.
