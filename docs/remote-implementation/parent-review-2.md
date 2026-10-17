# Parent review 2 — authorization follow-up and static Windows overlay

Specification: `../ImplementationPlan.md`, especially sections 7–8, 16, 18–20. This review records evidence boundaries while implementation continues; it does not declare D or the complete feature finished.

## Authorization and presence

- Independently inspected the shipping `rtcHost` bindings to `runAuthorizedStartup` and `onlyLiveSession`, native fail-closed view checks, and their tests.
- Independently reran authorization, host-presence, and client-presence tests: 3 files / 10 tests passed. R1 is closed for its identified paths; broader real-peer reconnect proof remains separate.
- Read the complete Stage C frontend log: 38 files / 301 tests passed. This is agent-produced execution evidence, not a second parent run.
- R2 remains open for the full ordered applied-frame/view/viewport exchange. The interim native filter hides a mismatched single-output or topology revision rather than decorating a known wrong output.
- Rechecked all nine protected-file hashes against `baseline.json` during this follow-up: every file still matches, including `ImplementationPlan.md` and the existing signaling/Offroader work.

## Static overlay evidence inspected

- Read the actual native window/DirectComposition/Direct2D/DirectWrite implementation and isolated probe source.
- Affinity is applied before visibility. The window uses nonactivation, tool-window, layered and transparent styles; the renderer retains the normal system cursor.
- Read the first probe JSON: both physical 3840 x 2160 displays, including the negative-origin left output, had capture-affinity 17; sampled border and label locations matched their underlying owned targets through the actual DXGI and xcap/GDI capture implementations. Foreground focus stayed unchanged.
- Warmed USER/GDI counts stayed stable across twelve repeated show/hide cycles. Process initialization residual counts are distinguished from growth across cycles.
- Inspected the exported static GPU surface with `view_image`: a thin border, transparent center, and the exact top-center identity text render. This supports renderer output; it does not prove physical appearance, final Aurora motion, DPI suitability, or real application/taskbar interactions.

## R3 — enforce ownership immediately before probe clicks

The first click probe delivered eight rather than ten mouse events on each display and correctly failed its ten-event exit condition. Its original target check occurred before pointer movement and a wait. An auto-hide taskbar or human pointer movement could change the window underneath before injection.

Required fix: verify actual cursor position and `WindowFromPoint` immediately before injection; skip/fail any point that no longer targets the probe's own window. Preserve the ten-event gate.

The implementation agent added that check and a longer hover settle. Its subsequent run observed concurrent human pointer movement on the left output and skipped those clicks; the right output delivered all ten events. The user then explicitly answered "Ready—run the check now" to a coordinated hands-off interval. One coordinated run completed successfully in 7.36 seconds, exit 0, and the user was told the interval had ended.

Parent independently read `stage-d-static-overlay-probe-hands-off.log` and the resulting JSON. Each of the five points on each output delivered exactly two mouse events to an owned target. Both outputs retained affinity 17, all hit tests passed, DXGI/xcap samples matched, foreground stayed unchanged, and warmed USER/GDI counts stayed at 8/4 across twelve cycles. R3 and the isolated two-display static click/exclusion gate are closed. This proof does not require another pointer-moving run.

## Remaining D gate

- The isolated two-display click/exclusion gate has passed; retain the exact proof and its scope.
- Shipping ownership follow-up inspected and accepted: `overlay/manager.rs` owns COM/GPU/HWND resources on one render/message thread; process-role checks prevent main-app startup; a single latest-wins slot coalesces scene updates; native presence/watchdog updates the scene; the remote-host exit callback joins the worker. Read `checkpoint-2-static.md`, the manager source, the authorization command's blocking-work offload, host exit wiring, and the shipping-module lifecycle probe JSON. All 23 recorded checks passed, including simultaneous output HWND thread/process ownership, preauth absence, supersession/end/watchdog cleanup, zero idle render/wakeup deltas, and shutdown with zero owned HWNDs. These are agent-executed isolated native checks, not a restarted live application/network peer.
- Keep physical taskbar/menu/text-selection/fullscreen and mixed-DPI observations separate from unit/native probe evidence.
- The core static ownership/click/exclusion substrate is accepted for E/F to proceed. The physical/live-peer limits remain explicit; the complete feature is not finished.

## R4 — report exclusion/render failure truthfully during E/F

The static manager records per-window creation/draw failures only in private native statistics. A session's initial handshake can still report `overlayAvailable: true` after a later affinity or draw failure. Plan section 16 requires the affected decoration to remain hidden and its unavailable state to be reported while remote control keeps functioning.

Sent to the agent as an E/F follow-up: expose actual unavailable/degraded per-display state through the host/client status path; settings must not imply that a failed indicator is active. Status: requested, not yet verified.

## Input precision note for H

The probe's requested point `(-3838, 1080)` became `(-3839, 1080)` while still landing on its owned target. That is sufficient for this click-through test, but not evidence of exact absolute-input precision. Review the shipping Windows absolute-coordinate quantization separately during H's exact-point tests, including negative-origin pixels and seam endpoints; do not reuse the probe's one-pixel tolerance as the input gate.
