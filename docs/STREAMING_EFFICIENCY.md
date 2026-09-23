# Streaming efficiency pass (3.9.101)

Scope: the remote-control stream end to end (PC capture → encode → transport → phone
receive → decode → present), plus the always-on desktop costs that compete with it.
Everything below was measured on the dev PC (RTX 4070 Ti, 3840×2160 desktop) or covered
by an automated test. No phone or headset was attached, so on-device gains are argued
from mechanism, and each one ships with a HUD counter that shows it working.

## Results

### Picture quality at the same bitrate

| Change | Evidence |
|---|---|
| NVENC default preset **P1 → P2** | 1080p encode median: P1 1.22–1.45 ms, P2 1.21–1.29 ms (`preset_latency_1080p`, 2 runs). 720p @ 2.5 Mbps desktop-like content: **25.45 → 28.12 dB** PSNR (`encoder_tuning_matrix` + ffmpeg). P3/P4: +0.6–0.8 ms for ~+0.2 dB (Tune knob). |
| **Colour labelled correctly** (BT.601 matrix in the VUI) | `colour_matrix_probe`: NVENC ARGB input is converted with BT.601 (red → Y81 U90 V240) but the stream was unlabelled, so decoders assumed BT.709 for HD — green decoded ≈(0,216,0), red orange-shifted. Labelled stream decodes to (253,0,0) / (0,254,0) / (0,0,254). |
| **Area downscale filter** (compositor) | vs trilinear, PSNR against a Lanczos3 reference (`area_filter_beats_trilinear`): 1.33× **+5.47 dB**, 1.5× **+5.06**, 1.79× **+3.78**, 2.0× ±0 (4K→1080p unchanged), 2.13× +0.03, 2.18× +0.21, 2.4× +1.39, 2.81× +2.29, 3.0× +1.59. |
| Surround endpoints fold down to stereo | Centre (dialogue) was dropped; now ITU/Web-Audio fold-down with a soft limiter (unit tests). |

### Latency, jitter and CPU/GPU on the PC

| Change | Evidence |
|---|---|
| **Loopback media pipe**: frames, audio and input bypass Tauri's UI-thread IPC | Tauri 2.11 `Channel`: payload ≥ 1 KB ⇒ `eval` + `ipc://` fetch, both serviced on the WebView2 UI thread; `invoke` also lands there and is unordered. The pipe is tokio → 127.0.0.1 WebSocket (`tcp_nodelay`) → page. Ordered, token-gated, bounded (48 MB). End-to-end socket test: 200 KB + 49 small frames byte-exact and in order; bad token refused. |
| Zero-copy capture skips redundant GPU work | Cursor-only updates reuse the captured frame (no 33 MB 4K copy); mips only at ≥ 2× downscale; cursor image decoded once per shape. |
| GPU scheduling priority while streaming | `SetGPUThreadPriority(7)` + process class HIGH, ref-counted; so capture/NVENC stop queueing behind a GPU-bound game's frames. |
| Tracker process scan two-stage | ~480 processes: **18.3 → 8.9 ms** per 2 s tick (`refresh_cost`, release build). |
| Sensor sidecar sampled on demand | 2 s while system stats are viewed, 10 s otherwise; `interval <ms>` on stdin takes effect immediately (verified: next sample at +0.1 s instead of +4 s). |
| One poll call instead of three per 250 ms; RTP stats every 2 s on DIRECT | Fewer UI-thread IPC round trips while streaming. |
| No codec re-announce at DIRECT start | The webview encoder's probed codec could differ from NVENC's Baseline and forced a decoder rebuild + IDR wait. |

### Phone / low-end devices

| Change | Evidence |
|---|---|
| Cursor moves don't re-render the Control screen | It was a full re-render of a ~4,800-line component per animation frame while driving the trackpad. HUD: **UI renders/s** (should sit near 0–2 while moving the cursor). |
| Native surface geometry sent only on change | Previously an IPC → JNI → Android layout pass per frame on cursor moves; Java now also skips unchanged layouts. Tests: dedupe + resend after decoder re-init. |
| Highest display refresh while streaming (APK) | TextureView presents on the app's vsync: 120 Hz halves the average wait (≈8.3 → 4.2 ms). Released when hidden. |
| Monotonic clock for clock sync / ABR | A wall-clock step used to look like a standing queue and cut bitrate. Quicker initial sync (5 pings in 1 s). |
| DIRECT skips RTC-track work | No jitter-buffer re-assert 4×/s, no watchdog `getStats`; HUD RTT/path poll every 3 s. |
| Main-thread visibility | HUD **Long tasks** (count · worst ms, 10 s) and **Path** (host / srflx / relay, protocol, network). |
| Quest: upload video only when a new frame decoded | Was a 1080p texture upload per XR frame (72–120 Hz) regardless. |
| Code splitting + on-demand dev mock | Startup JS: desktop **2.0 MB → 1,097 KB**, phone APK **1.33 MB → 638 KB**, web **631 KB**, Quest **656 KB**. Screens preload when idle; the ~360 KB dev-only mock backend is no longer parsed at startup. |
| ICE candidate pool 4 → 1 | Fewer public-TURN allocations per connection. |

### Removed

The LAN `/screen` (GDI capture → JPEG tiles) and `/control` (input injection) WebSockets
on `0.0.0.0:47800`, the base64 grab commands and the phone's unused LAN link — the
companion has been WebRTC-only; `/control` was an unused input-injection endpoint.

## Reproduce

```powershell
npm test
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --lib
# GPU / NVENC (need an NVIDIA GPU; write fixtures under src-tauri/target/perf-validation):
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored --nocapture remote::gpu remote::nvenc remote::native::tests::preset_latency_1080p remote::native::tests::encoder_tuning_matrix
cargo test --release --manifest-path src-tauri/Cargo.toml --lib -- --ignored --nocapture tracking::tracker::tests::refresh_cost
# PSNR for the tuning matrix (from src-tauri/target/perf-validation):
ffmpeg -f rawvideo -pix_fmt bgra -s 1280x720 -r 60 -i tuning-src.bgra -i tuning-p2-mp0.h264 -lavfi "[1:v]format=yuv420p[d];[0:v]scale=out_color_matrix=bt601:out_range=tv,format=yuv420p[s];[d][s]psnr" -f null -
node scripts/test-decoder.mjs
```

## Not done here (and why)

These are real opportunities but each is a multi-day change that needs on-device
validation this pass could not do:

- **HEVC / AV1** negotiation (~30–40 % fewer bits). The SPS fixups and Android decoder
  workarounds are H.264-specific and need per-device testing.
- **WebRTC in Rust** (str0m / webrtc-rs) to remove the host WebView from the media path and
  allow FEC / unreliable video for lossy Wi-Fi. The loopback pipe captures most of the
  UI-thread win without replacing the transport.
- **Quest WebXR media layer** (`XRMediaBinding`) and DIRECT inside VR — needs a headset.
- **libopus in the phone's AudioWorklet** (real PLC/FEC, no main-thread decode) — audio
  path change needing listening tests.
- **SurfaceView vs TextureView A/B** on the APK — TextureView was chosen for an Android 16
  WebView artefact and must be re-validated per device before changing.
- **Shader RGB→NV12** conversion — the colour problem it would have solved is fixed by the
  VUI label; the remaining chroma-filter gain is small.
