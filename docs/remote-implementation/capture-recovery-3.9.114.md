# Remote capture recovery — 3.9.114

The 3.9.112 incident had a connected phone, zero video FPS and a running host capture pipeline with zero produced frames. Restarting the desktop restored capture. No contemporaneous Rust panic or Windows graphics failure was logged, so the exact original native stall trigger cannot be established retrospectively.

Review found concrete recovery defects: the capture watchdog ran after awaited focus and RTCP polling; stop was not awaited before start; delayed callbacks could stop a successor's capture; and the legacy track-rebuild path could reuse a media socket whose callback still belonged to the discarded feed. A process that remained alive but had wedged graphics state had no independent recovery.

The normal five-second watchdog now has its own session-owned timer, independent of those polls. Recovery is serialized, awaits stop and rechecks session liveness. Native stop requests identify their capture generation, so delayed stops are rejected after supersession. A rebuilt feed opens a fresh socket. Existing view/epoch acknowledgment gates remain intact.

A native thread also watches actual primary frame deliveries, using a lifetime counter that soft capture restarts cannot reset. Twenty seconds without delivery ends only the isolated remote-host process. The existing main-app mutex supervisor respawns it, and the companion's existing reconnect/authentication flow reconnects. The native monitor does not acquire graphics, view-registry or WebView locks. It gives intentional encoder pauses and Windows sleep/resume a fresh grace period, and respects Quit/update flags. Before exiting it attempts to release remote-owned input, with a 200 ms maximum acknowledgment wait; an unresponsive injector cannot block recovery.

Validation:

- 334 frontend tests passed, including recovery ordering, coalescing, retired-session callbacks, retry, pauses and frame progress.
- Shipping native stream/model tests: 36 passed, 12 existing hardware tests ignored. Shipping input/view tests: 17 passed, including internal-only cleanup and bounded cleanup acknowledgment. Production Rust compile check passed.
- The independent watchdog's four tests also pass using the exact standalone `rustc --test` command added to Windows CI.
- A separate process ran the shipping capture pipeline with an injected zero-frame stall. Four soft restarts still produced zero frames. The real native watchdog ended that child with status 75; the probe launcher started a fresh child, which delivered 15 epoch-bearing JPEG packets. No app connection, OS input, pixel export or live app restart was performed.
- TypeScript, desktop/companion Vite production build and isolated discovery production build passed.

Reproduce the fault-injection check with `cargo run --manifest-path tools/remote-probes/Cargo.toml --bin remote-stream-probe -- --recover-stalled-child`. The stall hook is compiled only with the probe feature. This proves the bounded native recovery mechanism; it does not reproduce the unknown original driver condition or claim a physical-phone test of the new signed release.
