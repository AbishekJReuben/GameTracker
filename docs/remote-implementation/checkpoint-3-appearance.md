# Aurora and appearance checkpoint (E/F)

The unchanged complete plan remains authoritative. G–J are unimplemented. R2 is
still open; this checkpoint does not establish all-screen or live frame epochs.

## Implemented behavior

The separate remote-host render worker owns `overlay/aurora.hlsl`, `aurora.rs`,
`effects.rs`, the Windows HWND/render resources, and bounded effect state. It
renders a thin teal boundary, irregular fine ribbons and a translucent fringe,
using a physical-coordinate field and continuous integrated phase. Edge/cursor
scissors avoid shading the transparent center. The label is native DirectWrite
text and remains visible at zero decorative intensity. Capture/encoder code never
receives decorative pixels or overlay rendering work.

The explicit notice timeline freezes each arrival's dwell, including its native
device/scope reconnect history. Live name/duration/settings changes cannot replay
an already compact/settling arrival. Accepted remote button events read the real
OS cursor after injection and notify a bounded `try_lock` mailbox; optional
decoration drops under contention. The ordinary cursor and encoded cursor remain
unchanged. Static coefficients render until convergence, effective system motion
changes invalidate and clear, and the last expired ripple forces a final clearing
presentation. Failed/busy presentation does not incorrectly mark a surface clean.

All settings from §12 are present in `DesktopAppearanceSettings.tsx`; the saved
schema and complete presets are shared with Rust. Group/full reset and last custom
values are independent of stream settings and authentication. The in-Control
sheet keeps Control/video mounted. The preview is explicitly local, uses the down
event's own coordinates, and integrates every rAF's elapsed time independently of
its paint throttle. Host rendering failure/recovery is exposed per display through
native presence replies and a session-scoped host/client status event.

## Executed evidence

| Command / artifact | Exact scope and result |
|---|---|
| `npm test` → `evidence/stage-ef-frontend-tests-v2.log` | 41 files, 312 tests passed. Includes preferences/presets/reset, authorization, protocol, presence, settings UI and preview time/tap regressions. |
| `npm run build` → `evidence/stage-ef-frontend-build.log` | TypeScript and production build passed. Existing lottie eval and nativeDecoder split warnings retained. |
| `cargo check --manifest-path src-tauri/Cargo.toml` → `evidence/stage-ef-cargo-check.log` | Shipping Rust integration compiles; 29 unused/dead-code warnings, no errors. |
| `cargo test --manifest-path tools/remote-probes/Cargo.toml --bin remote-overlay-lifecycle-probe` → `evidence/stage-e-native-model-tests-v6.log` | 15 tests passed: notice interruption/history/duration, bounded ownership, optional-input contention, parameter convergence/disable and motion-policy invalidation. |
| `cargo run --manifest-path tools/remote-probes/Cargo.toml --bin remote-overlay-lifecycle-probe -- docs/remote-implementation/evidence stage-e-animated-lifecycle-v5` → matching log/JSON | 33 checks passed using shipping modules and actual HWND/GPU resources. Includes a short ripple in a stationary zero-speed Compact scene, final clearing draw then idle; a live zero-intensity/reduced edit draws through convergence then idles; actual invalid window failure stays hidden and reports degraded per-display state; the same ID recovers to available/non-degraded/active in one scene update. |
| `evidence/stage-e-animated-capture-exclusion.log`, `stage-e-animated-overlay-probe.json` | Animated Expressive rendering, halo/ripple and label over both actual 4K outputs. DXGI and xcap/GDI known underlying target pixels remain equal at eight points each; no colored artifacts/black rectangle. Thirty animated frames, zero input injection, warmed USER/GDI 8/4 stable. Per-output foreground tests pass; final repeated-cycle foreground differs during workstation activity, so that whole-run claim is withheld. Earlier probe metadata mislabels flag-disabled input as held keys; source now distinguishes the reasons. |
| `evidence/stage-e-native-visual-probe.log/.json` | Matched 4s disabled/enabled/disabled normal-workstation sample: overlay submission/Present p50 0.4615ms, p95 0.7157ms; capture readback p50 1.78/2.73/3.115ms. Exactly 118 DXGI frames each leg. Busy underlying pixels make this unsuitable as static-desktop encoder-idle proof or a GPU-duration/streaming benchmark. |
| `evidence/stage-e-visual-v4/` and `stage-e-native-visual-v4.log` | Native GPU/D2D light/dark PNG exports for all presets and arrival/announcement/settling/compact; a zero-intensity Tamil-name export; a six-second native renderer motion preview. Transparent PNG is unpremultiplied; opaque composites use raw premultiplied RGB + background*(1-alpha). Raw pixel checks: every center alpha 0; zero-intensity edge alpha 0 and label present. |
| `evidence/stage-f-live-appearance-control.png`, `stage-f-live-appearance-control-ax.txt`, `stage-f-live-appearance-closed-ax.txt` | Hidden localhost IAB fixture renders actual shipping Control/settings/ClientPresence with a synthetic video source. Opened live sheet, selected Balanced, edited intensity to 0.66 and border thickness to 3, reset only Border, collapsed/closed sheet. Visible HUD: sink active, 0 unmounts, 0 input events, host intensity 0.66, unchanged 3 quality updates. Fixture server/tab were closed; no real PC transport or input was connected. Parent independently inspected the same UI in its own temporary tab. |

## Adversarial review and limits

- R4–R9 developing findings have concrete source fixes and scoped regressions;
  parent acceptance is still required. Recovery clears the last per-output error
  within the successful scene update instead of requiring another preference edit.
- The accepted static D JSON was restored from its exact original log and remains
  separate. Later runs have distinct stage/version names; no evidence replacement.
- Physical observation of the excluded local effect, taskbar/menus/text selection,
  mixed DPI/fullscreen/secure-desktop behavior, real cursor-shape/remote-click
  checks, Android/Quest and live network visibility/reconnect remain pending.
- The normal workstation timing sample does not prove static encoder inactivity.
  A controlled static source and actual produced/encoded-work off/on comparison,
  without ignoring overlay dirty regions, remains a J gate (or earlier).
- Native controls are validated and the browser preview path is verified; a mock
  video fixture is never described as a live PC/native decoder/device result.
- R2 fail-closed selected-output/topology checks still guard presence. Ordinary
  monitor/viewport/frame synchronization will be completed in G/H, including the
  parent-approved RTC epoch-peer path and DIRECT/carrier configuration metadata.
- No app or protected service was restarted; no release, install or source-control
  action was performed. All production changes remain in this original checkout.

![Live appearance sheet with retained Control video](evidence/stage-f-live-appearance-control.png)
