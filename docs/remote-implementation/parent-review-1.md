# Parent review 1 — baseline/domain/rotation checkpoint

Specification: `../ImplementationPlan.md`, sections 2–8 and the compatibility, lifecycle, and regression requirements in sections 14–21. The implementation agent retains production ownership. This review does not mark the full feature or its physical gates complete.

## Independently inspected evidence

- Read `checkpoint-1.md`, `PROGRESS.md`, the rotation hook/JNI bridge, shipping MainActivity and Java rotation policy, Java assertions, preference parser/tests, TypeScript/native display geometry, shared fixtures, patcher changes, and the developing presence integration.
- Re-ran `npx vitest run src/companion/remotePreferences.test.ts src/lib/displayLayout.test.ts`: 2 files / 16 tests passed.
- Re-ran `node scripts/test-remote-rotation.mjs`: 54 lifecycle assertions passed against the shipping Java class.
- Compared all nine protected files against `evidence/baseline.json`: all hashes match, including the user's saved implementation plan and existing signaling/Offroader work.
- Inspected the native debug APK build log: Kotlin's incremental-cache failure recovered through its fallback compiler and packaging completed. Independently checked the APK exists (177815647 bytes) and its SHA-256 matches `stage-b-apk-sha256.json`: `DAFB554D7FFBC1884485B13A6F623A50833CB268AB93002C86E39C2F271331C7`.
- Baseline/frontend and isolated capture logs have appropriately bounded claims. No phone installation or physical rotation/PiP behavior is proved by those artifacts.

## Findings sent to the implementation agent

### R1 — retire obsolete authorization continuations before capture/shared state

The developing `src/lib/rtcHost.ts` integration adds an awaited presence registration inside `authorize()`. After this await, the outer function proceeds to start capture/audio and touch module-scoped channels/senders without rechecking peer/session liveness. `HostPresenceSession` retiring its own late handshake does not stop the outer continuation. A teardown/replacement during registration can therefore let an old peer restart process-wide capture or acknowledge on a successor's data channel.

Required fix: guard the outer authorization continuation after registration and other awaited boundaries before shared mutations. Add a deferred-registration/peer-replacement regression exercising the real outer host integration, proving no obsolete capture/audio start and no ack/secret delivery to the successor. The existing helper-only adapter test does not establish that property.

Status after follow-up review: fixed for the identified continuation and queued-retry paths. The shipping `rtcHost` calls `runAuthorizedStartup`, checks session/peer identity after registration, video, audio, and recovery awaits, and wraps both incoming control channels in `onlyLiveSession`. Independently reran the authorization, host-presence, and client-presence tests: 3 files / 10 tests passed. The tests exercise the extracted startup orchestration used by the host, including deferred registration, replacement during startup, and a queued authorization retry. This does not establish live reconnect behavior or supersede the broader regression gate.

### R2 — keep ordinary monitor changes synchronized with native presence

The developing presence handshake constructs a single-display view at authorization. Existing monitor switching still changes capture separately, while no applied-view update is yet connected to that path. An overlay built immediately on this state could remain on the formerly selected display.

Required integration before accepting overlay correctness: synchronize ordinary single-monitor selection, actual viewport visibility, and topology changes with authoritative applied-view/presence state, including a negotiated new client's existing monitor-control messages. Do not defer this until combined-view input work while claiming the static overlay gate is complete.

Status after follow-up review: interim fail-closed mitigation inspected. Native `visible_entries` and update acceptance now reject a stale topology revision or a primary single-display view that no longer matches the selected capture output. This prevents decoration of a known wrong output while the ordered frame/view exchange is unfinished. Full ordinary monitor, viewport, and applied-frame synchronization remains open for G/H. A fixed-output native probe may establish D's window/capture properties; it cannot establish complete live view integration.

## Checkpoint disposition

The preference/display domain and rotation implementation have credible source, automated-test, and native-package evidence. Physical Android four-orientation locking, PiP, relaunch, and leaving Remote for Home/Notes/Voice remain awaiting device validation. Stage A's live-guest performance/reconnect baseline and physical topology transitions remain explicitly incomplete. The overall A/B gate is consequently conditional, not fully passed. C is still being reviewed; R1/R2 must be resolved before the affected downstream claims are accepted.

Implementation may continue on independent work. Parent will review the concrete fixes and later checkpoints against the unchanged full plan.
