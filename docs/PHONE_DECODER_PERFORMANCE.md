# Phone decoder and receive path

This pass optimizes the APK's MediaCodec path and the WebCodecs path shared by
phone browsers and flat Quest. It preserves NVENC's image quality and encoder
settings, the optional NVENC FAST mode, RTC fallback, PiP, and immersive Quest's
RTC video path. No screenshots or visual tests were used.

## Findings and changes

- **Per-frame Base64:** the APK previously converted every encoded access unit
  into a JS binary string, Base64 string, Java string, then a decoded byte array.
  Current WebViews now receive a binary ArrayBuffer through AndroidX WebKit. A
  20-byte header carries timestamp/flags/length/session; delta payloads copy straight from
  the Java message array into MediaCodec's input buffer. Only keyframes need the
  existing SPS/PPS extraction and stripping. Origins are restricted to the packaged
  Tauri page, with a main-frame check. Older WebViews retain the Base64 route, using
  `Uint8Array.toBase64` when available. A stalled or broken binary bridge retires
  its pending messages before falling back. Session tokens reject messages and
  acknowledgements that arrive after a reconnect or decoder restart.
- **Bound IPC as well as decoder input:** at most four binary messages may await
  native acknowledgement. A single coalesced Handler task drains the inbox, rather
  than posting an unbounded task per incoming frame. There are at most six waiting
  native access units, 16 MB total, a 150 ms waiting-age limit, and six submitted
  codec inputs. Overload invalidates dependent frames until an IDR arrives. The
  inbox never drops one P-frame and then decodes its dependants.
- **Native races:** new frames previously bypassed the backlog when an input slot
  became free; the callback and JS bridge could also drain concurrently. All codec
  operations now run on one display-priority HandlerThread. Creation, configuration,
  stop, release, input and callbacks share that thread. SurfaceTexture destruction
  defers resource release until the codec stops, without blocking the UI thread.
  Callbacks from retired codecs and superseded configurations cannot touch the
  current session. Resolution changes compare against the actual configured size.
- **Browser decoder backlog:** `decodeQueueSize` does not account for all work
  already inside the platform codec. Both queued requests and inputs awaiting
  output are bounded: four pending requests, six in-flight frames, or a 150 ms
  oldest input trigger decoder replacement and IDR recovery. Late old-decoder
  callbacks are ignored and their frames closed. Native async init/polls have
  generation guards; native lifecycle commands are serialized across JNI.
- **Receive copies and partial frames:** one-fragment access units retain their
  incoming buffer, fragmented units allocate once, and WebCodecs can adopt the
  completed buffer through `EncodedVideoChunkInit.transfer` (older engines ignore
  this optional member). Oversized/invalid messages are rejected. A fresh header
  abandons a partial frame; sequence gaps request a recovery keyframe. Wire format
  remains compatible with existing hosts.
- **Presentation:** decoded bursts within one output task collapse to the newest
  frame in a microtask, without an extra animation-frame wait. If pacing timers are
  late, only the newest due picture is drawn. Reconfiguration/teardown closes queued
  pictures without painting them. Background clients skip even keyframes; PiP still
  counts as visible.
- **Telemetry:** the native 250 ms poll used to count at most eight frames, falsely
  limiting its reported rate to 32 fps; it also reported queue zero unconditionally.
  Now it uses actual counter deltas/time and actual queue depth, with only one stats
  request in flight. The native watchdog handles mid-session stalls as well as
  startup, without mistaking an idle desktop for a stalled decoder.

## Validation

Commands (no APK/installer build required):

```text
npx tsc --noEmit
npm test
node scripts/test-decoder.mjs
node scripts/benchmark-decoder.mjs
node scripts/patch-android.mjs
```

The pure Java inbox is compiled from the shipping template and tested with
100,000 concurrent inputs plus FIFO, startup, byte/age limits and keyframe recovery
checks. The full bridge is separately compile-checked against Android SDK 36 and
AndroidX WebKit 1.14.0. The patcher is checked for idempotence. CI runs the targeted
TypeScript and JVM regression guards before building the APK.

Representative local **CPU preparation only** benchmark, Node 22.23.1 / Windows
x64, median of seven batches; these are not phone or hardware-decoder timings:

| Encoded AU | Previous Base64 preparation | Binary packet preparation | Bridge payload |
| --- | ---: | ---: | --- |
| 32 KiB | 0.9601 ms | 0.0109 ms | 43,692 characters → 32,788 bytes |
| 64 KiB | 1.8920 ms | 0.0247 ms | 87,384 characters → 65,556 bytes |
| 512 KiB | 15.4258 ms | 0.1219 ms | 699,052 characters → 524,308 bytes |

This does not measure WebView transfer, MediaCodec, radio/network, rendering or
glass-to-glass delay. The binary bridge has acknowledgements and platform copies;
it is not an end-to-end zero-copy claim. No phone was visible to `adb devices -l`
during this pass, so Moto G57 hardware performance and on-device lifecycle behavior
remain unverified. No universal maximum speed or glitch-free guarantee is possible
from these checks. The existing Phone decoder toggle still selects WebCodecs as
an alternative to native MediaCodec.

## Primary sources checked

- [Android binary JS bridge guidance](https://developer.android.com/develop/ui/views/layout/webapps/native-api-access-jsbridge)
  and [WebViewCompat](https://developer.android.com/reference/androidx/webkit/WebViewCompat):
  feature-detected ArrayBuffer messaging, origin restrictions and callbacks.
- [MediaCodec](https://developer.android.com/reference/android/media/MediaCodec):
  asynchronous buffer ownership, invalid callbacks after flush, timely release,
  codec-specific data. Full replacement avoids reusing invalid flush-era indices.
- [MediaFormat low latency](https://developer.android.com/reference/android/media/MediaFormat#KEY_LOW_LATENCY):
  preserve the existing feature/vendor ladder and low-latency configuration.
- [WebCodecs specification](https://www.w3.org/TR/webcodecs/), Working Draft
  September 14, 2026: keyframe dependencies, queue semantics, transferred chunk
  storage, prompt release of VideoFrame resources.
- [Chrome 120 ArrayBuffer transfer support](https://developer.chrome.com/blog/chrome-120-beta#allow_transferring_arraybuffer_into_videoframe_audiodata_encodedvideochunk_encodedaudiochunk_imagedecoder_constructors)
  and [WebCodecs guidance](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs).
