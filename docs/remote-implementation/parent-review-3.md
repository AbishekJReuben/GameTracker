# Parent review 3 — developing visual controls and RTC design

The complete, unchanged `../ImplementationPlan.md` remains authoritative. E/F is still in progress; this is a review record, not a completed visual or integration gate.

## E/F findings sent to the implementation agent

- **R4: truthful renderer availability.** Later per-output affinity/draw failures must reach the host/client status path and keep failed decoration hidden while control works. Status DTOs, replies, forwarding, and settings copy have now been inspected in the developing source. Full failure/recovery evidence still needs checkpoint review.
- **R5: monotonic notice timeline.** The original sample function could move from Compact back to Announcement when its live dwell setting increased (for example 3 s to 8 s at age 4 s). Required fix: freeze the current arrival timeline and its device/scope history across reconnects; apply the new duration to a future announcement. The agent reports this fix and regressions for Compact/Settling; final evidence review remains pending.
- **R6: nonblocking decorative input notifications.** Successful OS button injection is the correct ripple position/ownership boundary, but the original notification then blocked on the renderer mailbox. Required fix: bounded nonblocking try-lock/try-send with optional effect drops under contention. The developing source now uses `try_lock`; the contention regression still needs checkpoint review.
- **R7: finish static parameter changes.** A single interpolation step followed by clearing `dirty` can leave old decorative pixels/values indefinitely when reduced motion, zero speed, or zero intensity prevents subsequent draws. Required fix: render until convergence or snap targets under static/reduced semantics. Test live changes/disabling at Compact with motion disabled. Changing the polled Windows motion policy must also invalidate/clear static windows; otherwise an in-progress ripple can freeze when animation is stopped. Sent; verification pending.
- **R8: credible preview and live tuning.** The initial Canvas preview resets its clock on skipped rAF callbacks but advances phase only when drawing, losing elapsed motion time. Its first touch-down also uses stale/default pointer coordinates. Required fixes: account for elapsed time consistently and normalize the down event's own coordinates. Verify a control-surface settings path can tune the actual indicator while Control remains visible. Sent; verification pending.
- **R9: export premultiplied pixels correctly.** D3D/D2D readback is premultiplied BGRA; simply swapping R/B and saving a straight-alpha PNG can darken the decoration again when viewed. E's presentation exports must unpremultiply safely or composite raw premultiplied RGB against an opaque light/dark background using `rgb + background * (1 - alpha)`. Preserve raw GPU data separately from the visual presentation export. Sent; verification pending.

## Evidence preservation

An animated probe initially overwrote the accepted static D lifecycle JSON. The agent restored D from the exact original JSON line in `stage-d-overlay-lifecycle.log`, retained the animated run separately as `stage-e-animated-lifecycle.json`, and added a validated stage-specific evidence prefix. Accepted checkpoints must retain their original logs/results/previews. New probe build caches belong in a local ignored `target/` directory, preserving the protected root `.gitignore`.

## R2: approved RTC fallback design for G/H

The implementation agent identified that the existing RTC fallback reuses a video sender/SSRC through `replaceTrack`. A separate control event and equal frame dimensions cannot prove a same-sized monitor switch. DIRECT/carrier has an ordered configuration path, but RTC needs its own frame-associated identity.

Parent approved a bounded video-only epoch peer for negotiated clients, with these gates:

1. Keep the existing authorized control/audio peer and DIRECT/carrier fast path. Old peers retain their existing supported behavior.
2. Bind immutable full `AppliedView`, session/epoch identity, and the sole video stream/track to that exact peer's SDP. Exchange its signaling only through the existing authorized channel; reject late/stale work after asynchronous boundaries.
3. Retain at most an active and a pending video peer. Use a distinct pending sink/element associated with its peer/track. Commit only that source's decoded/displayable frame, then retire old callbacks/peer after acknowledgment.
4. Never feed new-layout frames into the old displayed peer/track. Preserve a valid old frame and audio during setup. On timeout/failure restore capture and mapping together.
5. Point quality, keyframe recovery, telemetry, visibility/decode watchdogs, and cleanup at the actual active video peer, while keeping control/audio ownership intact.
6. Verify same-sized switches, rapid supersession, topology invalidation, setup/ack failure, teardown, RTC/DIRECT/carrier changes during a pending layout, and old/new combinations. Measure transition latency and resource bounds.

This is an authorized implementation choice within the approved product plan, not a user-facing feature reduction. R2 remains open until the ordered frame/view mechanism is implemented and verified on each transport.

## E/F checkpoint disposition

Read `checkpoint-3-appearance.md`, the complete frontend execution summary (41 files / 312 tests), actual-HWND lifecycle v5 JSON (33 passing checks), final manager/preview source, and native visual-export code. Independently reran the prebuilt E native model test executable: 15 tests passed. Independently reran preview-model, appearance-settings, and host-presence tests: 3 files / 9 tests passed. Rechecked all nine protected-file hashes: all match the original baseline.

Parent also independently opened the isolated shipping Control fixture in a temporary hidden browser tab, used Quality → Desktop appearance, expanded the individual controls, and inspected its rendered UI. The fixture kept its sink active with zero unmounts/input events and no additional quality changes while the panel was opened/expanded. No settings were edited by this parent inspection; its temporary tab was closed. This is browser fixture evidence, not a real remote PC/native-decoder/device result.

Inspected native Subtle compact opaque exports on light and dark backgrounds: the thin boundary, readable exact identity text, restrained fringe/halo, and unobstructed center match the selected direction. Verified the export code composites premultiplied data correctly. The retained native preset/state renders and six-second motion preview support renderer review; they do not establish physical visibility or cursor/taskbar/fullscreen behavior on a real controlled desktop.

R4–R9 are accepted for the identified source/automated/native/browser-fixture paths. In particular, the 33-check native execution covers same-ID failure recovery, coefficient convergence in a stationary zero-speed scene, the last ripple's clearing presentation, and return to idle. E/F may proceed to G integration with these boundaries retained.

Open gates remain R2's actual ordered transport/view integration; controlled static-source produced/encoded-work comparisons (the busy-workstation 4 s off/on/off sample does not prove this); real streaming latency/fps/transport regressions; physical phone/Quest, mixed-DPI, cursor-shape, application/taskbar/fullscreen, and local excluded-effect observation. These are not waived by this checkpoint acceptance.
