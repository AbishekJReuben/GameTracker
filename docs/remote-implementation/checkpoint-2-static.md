# Static Windows ownership gate (C/D)

The complete saved plan remains authoritative and unchanged. This is a bounded
sub-gate before the E/F visual checkpoint, not completion of all desktop behavior.

## Implemented and executed

- C: device approval remains distinct from controller text. Capability negotiation
  is versioned and backward compatible. Only an existing authorized host peer may
  register native presence. The native watchdog expires visibility, and a retired
  session cannot overwrite/end its successor. R1 continuation/retry guards are
  accepted by the parent in `parent-review-1.md`.
- D: native top-level HWNDs, DirectComposition/D3D11, Direct2D and DirectWrite live
  on one dedicated worker in the separate remote host. An explicit process-role
  guard prevents starting it in the main app. Creation is off the Tauri UI thread.
  A single-slot mailbox coalesces updates; empty presence blocks the worker.
  Shutdown joins that worker and destroys its windows/resources on their owner.
- Affinity is installed before visibility. Older unsupported Windows/DWM fails
  closed. The full window is transparent to input and never activates. The local
  renderer does not modify the cursor or any encoded frame.

Commands/artifacts:

1. `npm test -- --run`: `evidence/stage-c-complete-frontend-tests.log`, 38 files / 301
   tests passed before the additional three protocol validation tests.
2. `npx vitest run src/lib/remoteProtocol.test.ts src/companion/clientPresence.test.ts src/lib/rtcHost.authorization.test.ts`:
   `evidence/stage-c-protocol-authorization-tests.log`, 11 tests passed. Includes
   geometry validation and deferred authorization/queued-retired-retry cases.
3. `npx tsc --noEmit`: `evidence/stage-c-final-typescript.log`, passed.
4. `cargo test --manifest-path src-tauri/Cargo.toml --lib remote:: -- --nocapture`:
   `evidence/stage-c-final-rust-tests.log`, 33 passed / 12 hardware-ignored. This ran
   before the manager mailbox unit test was added; that test remains to be run.
5. `cargo check --manifest-path src-tauri/Cargo.toml`:
   `evidence/stage-d-manager-check.log`, passed with existing/new unused-probe warnings.
6. The already compiled `src-tauri/target/debug/examples/remote_overlay_probe.exe docs/remote-implementation/evidence`
   ran once in the human-authorized hands-off interval, 7.36 s, exit 0. Exact log:
   `evidence/stage-d-static-overlay-probe-hands-off.log`; complete JSON:
   `evidence/stage-d-static-overlay-probe.json`. Both actual 4K outputs passed:
   10 real down/up events at four edges + label, immediate owned-target checks,
   unchanged foreground, actual DXGI and xcap/GDI pixel equality, affinity 17.
   Warmed USER/GDI counts remained 8/4 across twelve creation/show/hide/destruction
   cycles. Native GPU exports each contain 73,776 nontransparent colored pixels.
7. `cargo run --manifest-path tools/remote-probes/Cargo.toml --bin remote-overlay-lifecycle-probe -- docs/remote-implementation/evidence`:
   `evidence/stage-d-overlay-lifecycle.log` and `.json`, all 23 checks passed. The
   probe imports the shipping presence/watchdog/manager/window modules. It proves
   authorization alone/unknown peers create no HWND; concurrent two-display HWNDs
   belong to the same separate render thread/process; duplicate/replaced/hidden/
   disconnected/stalled sessions clean up; legacy monitor mismatch hides only the
   stale primary indicator; empty presence produces zero rendering/wakeups over
   the measured idle interval; shutdown joins and leaves zero owned HWNDs. It
   starts no app/database/network service and never moves the pointer.

The standalone probe manifest avoids repeatedly linking the app's large staticlib.
A disk-space build failure was resolved with Cargo's package-scoped dev cache clean
(`stage-d-build-cache-cleanup.log`); no source/user data was removed.

## Adversarial review against the complete plan

- The first probe read a post-flip backbuffer and an uninitialized duplication
  sample. Corrected by exporting the painted surface before presentation and
  checking a known owned target after warm-up. The failed artifact is retained.
- Initial missing clicks could not be accepted. Added immediate pre-injection
  ownership checks; concurrent physical movement correctly skips/fails the probe.
  The final coordinated run passes the original ten-event gate on both outputs.
- Physical pointer quantization differs by one pixel at some negative positions.
  This still proves owned-target click-through; it does not prove H's exact input
  mapping. H must replace/verify the shipping quantization and exact seams.
- R2 remains open: ordinary monitor, topology, viewport and actual displayed-frame
  epochs are not fully synchronized yet. The native production path fails closed
  when the applied layout or selected primary capture output is stale. D's fixed
  output proof does not close the later ordered transport/frame exchange.
- The actual shipping manager is connected to native presence; the isolated probe
  tests its source with an explicit remote-host role. The live installed app has
  not been restarted or replaced. No live network-peer behavior is inferred.
- The export was visually inspected: thin static border, transparent center, exact
  identity text/backing. Physical desktop observation, mixed DPI, taskbar/menu/text
  selection/fullscreen interactions remain awaiting physical validation.
- Rotation physical validation, baseline guest latency/fps/reconnect and the
  remaining E–J features/gates are still incomplete. No packaging/release claim.

## Next

E adds the restrained aurora, label state machine and cursor reactions using this
owned, capture-excluded subsystem. F adds all controls and preview. Before closing
R2 in G/H, each transport must carry view metadata with a provably associated frame;
an unrelated data-channel event or matching dimensions is insufficient for RTC.
