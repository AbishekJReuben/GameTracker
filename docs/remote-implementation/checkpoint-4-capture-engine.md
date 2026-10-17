# Combined capture engine sub-checkpoint (G)

The complete saved plan is unchanged. E/F scoped acceptance is in parent-review-3.
This is the native ownership/composition boundary requested for review while H
continues; it does not claim the full All screens product or R2 is complete.

## Shipping implementation

- `capture_broker.rs` shares one output entry/duplication across primary, combined
  and auxiliary consumers. Adapter groups own a common device/context; timeout-zero
  acquisition and consumer-specific seen sequences retain static images. Pacing
  happens outside graphics locks. Last-lease cleanup drops output ownership.
- `capture_surface.rs` owns an immutable layout and an outgoing-sized target,
  keeping Windows positions/gaps. Same-device sources are sampled directly.
  Foreign-device sources are scaled on their own device to a bounded tile, then
  transferred/uploaded through `gpu_transfer.rs`: two asynchronous staging slots,
  nonblocking Map, reused CPU buffers and bounded drops. Foreign SRVs are rejected.
- All adapter locks are acquired in global LUID/device-instance order, including
  overlapping old/new captures with opposite selections (R11). Single outputs
  retain GPU→NVENC without readback; auxiliary JPEG consumers share acquisition.
- DXGI recovery restores the binding's native rotation, changes the cursor-cache
  source generation, clears fallback resources and exposes no valid native image
  before its first acquisition (R10). Rotation is explicit in the GPU shader.
  `system_cursor.rs` supplies cached ordinary cursor shapes for GDI fallback.
- Combined tiles are cursor-free. Exactly one destination pass uses combined
  desktop coordinates for the normal cursor, including CPU/JPEG output (R12).
  Cursor shapes can straddle a seam and never remain baked into a delayed tile.
- Primary/aux capture use this source module and retain the existing encoder,
  delivery credits, native/JPEG fallback, queue and audio plumbing. All-screens
  capability/UI stays unadvertised until H's ordered frame/view/input integration.

## Exact native evidence

`cargo run --manifest-path tools/remote-probes/Cargo.toml --bin remote-combined-probe -- docs/remote-implementation/evidence stage-g-combined-v8`
passed. Source and full results: `src-tauri/examples/remote_combined_probe.rs`,
`evidence/stage-g-combined-v8.log/.json`.

| Gate | Observed result |
|---|---|
| Actual combined moving content | 79 NVENC H.264 frames at 1920×540 from both physical 4K outputs in Windows arrangement. 78 post-warmup samples show distinct red/green owned moving patches; initial initialized DXGI surface is black. |
| Single GPU-native path | 30 NVENC frames at 1920×1080 from one output while combined and auxiliary source leases coexist. |
| Actual decode | `python docs/remote-implementation/verify-combined-decode.py stage-g-combined-v8` → matching decode log/JSON. ffmpeg decodes all 79/30 frames; coded dimensions and owned target colors pass for both streams. |
| Acquisition sharing | Each physical output has one acquisition and two concurrent consumers; adding the single GPU consumer raises its lease count without another acquisition. Single CPU consumers receive 31/77 frames, including the retained-source interval. |
| Static-source scheduling | A test-only frozen retained GPU snapshot keeps one source's sequence fixed while the other remains actual moving DXGI. Combined output continues. This proves the native retained-image/timeout behavior, not a physically static whole desktop or encoder-idle performance. The hook is absent from production. |
| Animated capture exclusion | Thirty animated Expressive overlay iterations over both actual outputs; combined captured samples at edge, identity backing and center match owned underlying colors within 2 channel values. No decoration or black rectangles. No pointer injection. |
| GDI → native recovery | Actual forced shared GDI capture produces a valid combined update. Prepared native recovery has restored rotation, a distinct cursor cache key and `validImage=false`; only its later real acquisition advances the source. Control/background remains intact. |
| Cross-device locks/transfer | Two actual separate D3D devices on this physical adapter, opposite selected outputs, concurrent bounded loops: 73 and 75 frames in ~2s, with 73/74 correct-color frames and bounded transfer bytes. Both finish; output registry is empty after cleanup. Actual different physical GPUs remain untested. |
| GPU fixtures | Exact quadrant pixels pass 0/90/180/270° rotation. Foreign SRV rejected. Full white cursor spans seam; subsequent position leaves no ghost in the retained foreign background. Masked/I-beam XOR semantics span both colors correctly. |
| Transfer bounds/reuse | Two staging slots accept two submissions and drop the third. Twelve subsequent submissions finish; warmed CPU capacity stays 6144 bytes for the 32×16 fixture and bytes remain exact. |

`cargo test --manifest-path tools/remote-probes/Cargo.toml --bin remote-combined-probe`
→ `evidence/stage-g-native-model-tests-v3.log`: 32 pass / 12 hardware-ignored.
`cargo check --manifest-path src-tauri/Cargo.toml`
→ `evidence/stage-g-final-cargo-check.log`: shipping integration compiles.

## Adversarial findings and remaining work

The first probe could not resolve the negative-origin output because the standalone
process was DPI-unaware. Silent first-output substitution was removed. A scoped
physical-DPI context now covers output discovery and capture; both actual outputs
are matched explicitly. Initial failed logs are retained.

Independent review identified recovery/cursor namespaces and opposite lock ordering;
the changes and exact native probes above address R10/R11, pending parent acceptance.
Self-review also found baked per-tile cursors (R12), fixed through the shared final
pass and seam/lag fixtures. No real mouse movement was used to obtain that proof.

H still must bind full layout/session/epoch metadata to actual ordered frames on
DIRECT, carrier and the bounded RTC epoch peer, hold stale input and implement
view/focus/viewport behavior. Current internal layout requests are not yet that
protocol and must not be treated as applied frame evidence. R2 stays open.

Actual multiple physical GPUs, portrait/mixed-DPI topology changes, encoder/decoder
dimension-rejection rollback, live network audio/transport/latency and full static
encoder-work comparisons remain open. The native probe's PNG export and auxiliary
readbacks affect its cadence; its frame count is correctness evidence, not displayed
FPS or a streaming benchmark. Steady composition submission timings are separate
from GPU duration. No app/protected service was restarted or updated.
