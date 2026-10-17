# Android silent decoder recovery — 3.9.116

## Report and verified failure boundaries

The Moto G57 Power report identifies a running Qualcomm AVC low-latency decoder
at 2160×1214 whose output stopped at 3990 while new bridge frames continued.
The supplied journal also contains animated TextureView resizes, including a
1080×1 intermediate size. It does not establish the vendor driver's original
failure trigger. `wanted=false` in the later dump is consistent with fallback
teardown and is not evidence that the stream was intentionally stopped first.
The 48256 bridge submissions are a session total; codec outputs restart from zero
on each decoder replacement, so those counters cannot be subtracted as lost frames.

Two production regressions were reproduced with tests before changing code:

1. A silent, error-free mid-session stall bypassed native recovery and immediately
   abandoned MediaCodec after the watchdog deadline.
2. A failed native transition snapshot prevented retained-picture teardown from
   reaching Java. That can leave the frozen native layer over the fallback canvas.

## Change

- Use actual rendered-frame progress when the bridge provides v2 presentation
  proof, preserving the output-counter compatibility path for older APKs.
- Request an IDR after 750 ms without picture progress under new submitted work.
  If still stalled, restart only the phone decoder after 2 seconds with CSD, or
  8 seconds while waiting for initial CSD. Preserve the connection and view.
- Allow at most two restarts in a rolling minute. Codec/monitor rebuilds and a
  single good picture do not refund that budget. Continued failure falls back
  to WebCodecs. Idle input, Android sleep/poll gaps, and background transitions
  do not accumulate decoder-stall time.
- Rotate the feed identity and retire pending frame mappings on recovery.
  Preserve bounds/selected monitor; require fresh rendered proof before reveal.
- Stop and restart on the existing codec HandlerThread in one guarded task.
  Superseded recovery cannot start after teardown. Retry the next format rung
  after the one actually running; the final plain rung no longer re-enables
  low-latency parameters at runtime.
- Make teardown/recovery continue if snapshot capture fails or throws. Ordinary
  view initialization still requires its retained-picture safety check.
- Report per-stall bridge input counts separately from session and codec totals.

Review against ImplementationPlan.md: preserve capture/view identity, rendered
acknowledgments, input gating, selected display, PiP/background behavior, bounded
FIFO/reference-chain rules and existing RTC/WebCodecs alternatives. No host,
encoder, bitrate, queue-limit, monitor-toolbar or immersive Quest changes.

## Validation

| Check | Result |
| --- | --- |
| Original two regression tests against 3.9.115 | Both fail |
| Targeted decoder/recovery/lifecycle tests | 36 pass |
| Full frontend suite | 50 files, 359 tests pass |
| `npm run build` | TypeScript and desktop/APK frontend bundle pass |
| Isolated discovery web build | Pass |
| `node scripts/test-decoder.mjs` | FIFO, IDR recovery, age/byte bounds and 100000 concurrent inputs pass |
| Rendered proof and transition ownership JVM checks | 23 + 14 assertions pass |
| Remote rotation JVM checks | 54 assertions pass |
| Fresh Android patcher/idempotence fixture | 86 files, zero second-run changes |
| `:app:compileArm64DebugJavaWithJavac` | Java/Kotlin compile succeeds, 28 seconds |

The Java compile uses Android Studio JBR and the local Android SDK through explicit
`JAVA_HOME` / `ANDROID_HOME`; PowerShell Gradle `-P` arguments must be quoted.
It is not a signed APK build or a physical-device test. ADB currently lists no
devices, so the intermittent Qualcomm failure has not been reproduced on the phone
and long-session device validation remains pending. Release packaging runs in CI.

MediaCodec lifecycle and fresh-stream recovery were checked against the official
[Android MediaCodec reference](https://developer.android.com/reference/android/media/MediaCodec).
Static publication uses the existing reviewed deployment helper, retains old hashed
assets and runtime files, and does not restart discovery/notes/voice or Offroader.
