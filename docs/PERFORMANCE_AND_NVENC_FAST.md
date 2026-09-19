# Desktop performance and experimental NVENC fast delivery

Release: **3.9.98**. All validation for this pass was non-visual. No production
database, installed application, or remote device was modified during testing.

## Findings and changes

The expensive work was not just NVENC. Image-heavy desktop components retained
full-size screenshots and ran decorative effects outside the viewport. Backend
events could also refresh mounted-but-hidden UI queries. In the native stream,
SCTP backpressure already existed, but there was no corresponding bound on frames
in transit from Rust to the host WebView.

- Local capture grids now request 640px cached JPEG thumbnails only near the
  viewport. Full-resolution originals remain available in the lightbox and as an
  error fallback; originals are never rewritten. Thumbnail generation runs off
  the UI thread with at most two workers. The disposable cache is pruned on its
  first write and every 32 writes toward 512 files / 128 MiB, so these are soft
  limits between sweeps. Sources must resolve inside the application's media
  directory.
- Image components use memoization, asynchronous decoding, and lazy loading.
  Showcase shaders retain the current and next decoded image rather than loading
  the entire image list. Offscreen shaders and slideshow timers stop; shared
  intersection observers replace one observer per image/card.
- Native tray/minimize visibility now gates UI polling, display clocks, CSS
  decoration, Lottie playback, and shader work. Repeated backend invalidations
  are coalesced while hidden and refreshed on return. Tracking, remote hosting,
  clipboard/Notes sync, media tracking, and database writes are not stopped.
- A paused native encoder now skips capture/compositing work too. Requested IDRs
  still bypass that pause, and resuming acquires the latest desktop frame.

## Using fast delivery

After updating both desktop and remote client, connect with **DIRECT**, leave
**PC encoder (NVENC)** enabled, and open **Stream stats → Tune → Modes → NVENC
fast delivery (experimental)**. The new setting defaults to **OFF**, including
for saved preferences from older releases. It is persisted per client and can be
changed without reconnecting. OFF restores classic delivery.

This subpath applies to the normal DIRECT native-NVENC stream. It does not change
LAN JPEG, RTC video-track fallback, or immersive VR. An older desktop ignores the
new quality field; an older client continues to request classic delivery. Browser
clients must receive the updated web bundle as well as the desktop update.

Fast delivery changes transport scheduling, not the codec or compression quality:

1. Rust reserves a slot **before encoding**. At most two encoded native messages
   may await the host WebView. A full window skips the next encode, not an already
   encoded reference frame. The JS acknowledgement returns credit after the
   existing send/backpressure/recovery logic has handled the frame.
2. The private Rust→WebView header carries generation, sequence, and native
   encode-submission time. Stale acknowledgements cannot release a new session's
   slots, including after toggles and capture restarts. An unsent reservation is
   returned automatically if encode fails. Missing acknowledgements for two
   seconds revert delivery to classic; the HUD reports the fallback.
3. Fast video messages use 16 KiB fragments instead of 60 KiB, additionally
   respecting negotiated SCTP maximum message size. This gives audio/control
   channels more opportunities to be scheduled on implementations without SCTP
   message interleaving. Reliability, ordering, and receiver reassembly stay
   unchanged. Smaller fragments can cost more calls; keep this path optional.
4. Focus/watchdog/rebuild recovery restores the negotiated native delivery mode
   and both pause owners. Obsolete capture callbacks are ignored.

The existing GPU zero-copy path, NVENC ABI, P1/ultra-low-latency tuning,
Constrained Baseline/CAVLC, SPS fixes, two-frame VBV, adaptive bitrate, receiver
decoder/pacing, and audio format are unchanged. There is no new encoded-P-frame
dropping strategy.

HUD additions: **Delivery**, **IPC frames**, **IPC skips**, **Host handoff**.
Host handoff measures encode submission through arrival at the host WebView, not
DXGI capture time or glass-to-glass latency. Fast delivery includes that interval
in its transmitted timing; classic retains the old WebView-arrival timestamp.
Consequently, their E2E HUD readings have different starting points and should
not be treated as a direct numerical A/B benchmark.

## Validation evidence

- Frontend regression suite: 152 tests, including a 300-image gallery that makes
  only 12 thumbnail requests when 12 images become nearby; no eager original
  loads. Native visibility lifecycle, hidden-query catch-up, fragment sizing,
  header compatibility, and explicit opt-in are covered.
- Rust suite: 67 passed, 15 normally ignored network/hardware tests. The hardware
  tests listed below were additionally run explicitly on this machine.
- 1,000 hidden query invalidations: no hidden refetch; one catch-up on return.
- Synthetic slow consumer: 600 capture ticks, drain once per six ticks,
  101 emitted / 499 skipped **before encode**, outstanding window never above two.
- RTX 4070 Ti, driver 596.21: existing zero-copy NVENC smoke median 1.23 ms
  (29 measured frames). This confirmed the encoder itself was already fast.
- New synthetic 1920×1080 changing-image encode/wrap test (CPU upload included):
  classic 120 frames median 3.260 ms / p95 4.409 ms; fast 120 frames median
  3.181 ms / p95 4.303 ms. This small difference is measurement noise, not a
  claimed speedup. Both streams were **byte-identical** after delivery headers
  were removed.
- Pressure variant: 31 encoded frames / 89 pre-encode skips; strict FFmpeg
  decoding succeeded for all 31. Classic and fast 120-frame streams also decoded
  without errors. SHA-256 of both full-rate elementary streams:
  `BE6AA998E413FBC2FF8F42B919034D0A042D841EFDD1ED4C84D2C0D883AE9522`.
- TypeScript checking and the desktop/companion/Quest frontend bundle passed
  before the version-only release bump. Installer/APK packaging is left to CI.

These checks establish bounded work, wire/codec integrity, and regression-test
coverage. They are **not** a measured desktop CPU/GPU before/after comparison or
an end-to-end phone/Quest latency result. No visual testing was performed. An
actual connection A/B is still needed to decide whether the optional transport
is better on the user's network.

Reproduce the headless checks from the repository root:

```powershell
npm test
npx tsc --noEmit
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo test --manifest-path src-tauri/Cargo.toml --lib remote::nvenc::tests::nvenc_smoke -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib remote::native::tests::native_delivery_smoke -- --ignored --nocapture
ffmpeg -v error -xerror -err_detect explode -i src-tauri/target/perf-validation/fast-pressure.h264 -f null -
```

The hardware test writes synthetic H.264 fixtures under the ignored
`src-tauri/target/perf-validation` directory. It does not capture the user's screen.

## Primary references

- [NVIDIA Video Codec SDK programming guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html):
  low/ultra-low latency tuning, CBR and low-delay buffering guidance. The existing
  compatible encoder configuration was retained.
- [RFC 8831, section 6.1](https://www.rfc-editor.org/rfc/rfc8831.html#section-6.1):
  16 KiB message-size guidance to reduce monopolization without message
  interleaving. The smaller-fragment subpath is an application of that guidance,
  not a guarantee about a particular browser's scheduler.
- [React memo reference](https://react.dev/reference/react/memo): skipping
  unchanged component renders; visibility and thumbnail limits address work
  that memoization alone cannot remove.
