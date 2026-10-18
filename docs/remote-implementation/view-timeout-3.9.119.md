# Working video with a stale RTC timeout — 3.9.119

The Quest browser report showed `RTC view setup timed out` while video continued.
That string belongs to the host's nine-second pending RTC video peer, not the
Android MediaCodec decoder. Source review and regression tests identified a
transport ownership race: DIRECT could display and acknowledge the current view,
then a late capture callback could start a redundant RTC peer for that same view.
Its timeout and asynchronous cancellation response could outlive the successful
DIRECT acknowledgment or a newer view. The client also retained view warnings
after recovery; the decoder-warning fix in 3.9.118 deliberately did not clear them.

## Changes

- Keep DIRECT ownership until explicit fallback, preventing late capture callbacks
  from staging redundant RTC peers. Ignore crossed same-view offers on the client
  and re-ack the source already proven on screen, including with older hosts.
- Explicit fallback re-enables RTC and rebuilds its feed so a fresh captured image
  creates the replacement track. A late DIRECT acknowledgment cannot reclaim that
  transport or commit the replacement feed after fallback has started.
- Invalidate asynchronous failure/status results when newer captured pixels or a
  successful acknowledgment supersede them. Tag host transport errors with their
  complete capture identity; reject errors belonging to obsolete client views.
- Clear view warnings after qualifying picture presentation and host confirmation.
  Initialization/status alone cannot clear a failed view. A rejected monitor
  selection remains visible until a later request succeeds. Decoder warnings and
  view warnings retain separate recovery events.
- Measure hitch gaps against requested/adapted stream FPS, replacing the fixed
  40 fps assumption. Reset the baseline across idle and stream transitions. The
  reported approximately 100 ms cadence alone does not establish whether the
  user's stream was intentionally limited or actually slow; genuine large gaps
  remain recorded. No encoding rate or capture scheduling was changed.

The existing nine-second RTC timeout remains in place for genuine failures.
Displayed-frame identity, input gating, same-size monitor switches, decoder
recovery limits, Android templates, and native capture algorithms are preserved.
This is shared flat-browser/Android remote code, not new immersive Quest work.

## Verification

- Six new regressions failed before the fixes and pass afterward.
- Full frontend suite: 52 files, 390 tests pass. Nine existing coordinator probes
  now run in normal CI alongside the new ownership/recovery regressions.
- TypeScript and production desktop/APK frontend bundle pass. The new test files
  also pass the project's frontend typecheck without adding Node type dependencies.
- Isolated discovery build passes; deployment uses the reviewed additive helper,
  preserving old hashed assets, runtime data and service processes.
- All 102 local/public entry-reference and asset-hash checks pass after deployment.
- Real Chromium 155 loopback RTC probe: initial picture, same-size switch with
  three dropped commits, rapid supersession, same-identity track replacement,
  failed offer retaining the current source, and DIRECT-to-RTC fallback pass.
  Maximum active/pending peers: two per side; all 12 created peers close.
- All nine protected baseline file hashes remain unchanged.

The browser probe uses synthetic local canvas pictures and real peer connections;
it is not a Quest headset or Android hardware run. Packaging is handled by the
tagged personal release CI. The desktop host changes require the new desktop
build; the web deployment alone updates only the browser/client side.

Reproduce automated checks with `npm test` and `npm run build`. Run the browser
probe using `npx vite --config docs/remote-implementation/parent-epoch-probe.vite.config.ts`,
open its local HTML page on port 14883, and select **Run real RTC module checks**.
Private build/test/deployment records are under `.logs/*3.9.119*`.
