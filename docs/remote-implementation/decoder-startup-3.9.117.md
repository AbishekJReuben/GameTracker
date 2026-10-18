# Native decoder startup after a failed snapshot — 3.9.117

## Confirmed cause

The 2026-10-18 Moto G57 Power report contains the exact error
`Unable to retain the last native picture for this view transition`.
That exception was raised by `nativeDecoder.ts` before invoking `decoder_init`.
Version 3.9.116 made snapshots optional for reset and fallback teardown but left
initialization dependent on them. Three regressions reproduced that remaining
blocker: a snapshot refusal, a snapshot exception, and repeated reconnect while
an old snapshot owner stays busy. All three fail against 3.9.116 and pass here.

The report's stopped decoder and GONE TextureView are consistent with reconnect
after teardown. The previous Java snapshot routine tested single-flight ownership
before checking whether there was a running picture to retain. Snapshot refusal
could also reflect an unavailable surface or the 450 ms UI/copy deadline; the
old journal does not identify which happened in this particular event.

The earlier journal includes codec errors/configure failures followed by later
successful starts. Its stale `probeDetail=all attempts failed` survived those
starts. This patch refreshes that diagnostic on successful start and preserves
exception names when configuration failures have empty messages.

## Change and review

- Snapshot retention is best effort for initialization, recovery and retained
  teardown. Native initialization proceeds when snapshot capture refuses/throws.
- A stopped/hidden decoder skips unnecessary snapshot capture. Pending copies
  remain single-flight and keep their bitmap until completion.
- Feed changes and codec stops invalidate pending snapshot tickets. A late copy
  cannot attach an old picture to a new feed, generation or replaced view.
- Snapshot completion is guarded and releases its ownership in a finally block
  even when attaching the retained image fails.
- Existing retained pictures, actual rendered-frame proof, bounds/feed identity,
  reveal gates and input gating remain in place. Snapshot failure itself never
  acknowledges presentation or clears a retained picture.
- Real JNI initialization errors still report failure and allow a later retry;
  the existing codec recovery/fallback ladder remains responsible for them.

Reviewed against ImplementationPlan.md's view-epoch, stale-frame, PiP and
fallback requirements. No capture, encoder, toolbar, queue, codec-selection,
tracking or server behavior changes.

## Validation

| Check | Result |
| --- | --- |
| Three reported-startup regressions before patch | All fail with the exact reported error |
| Full frontend suite | 50 files, 363 tests pass |
| TypeScript and desktop/APK frontend build | Pass |
| Isolated discovery frontend build | Pass |
| Android Java/Kotlin compile | BUILD SUCCESSFUL, 31 seconds |
| Actual decoder FIFO JVM tests | FIFO, IDR recovery, bounds and 100000 concurrent inputs pass |
| Rendered-frame and snapshot ownership JVM tests | 23 + 14 assertions pass |
| Fresh Android patcher/idempotence fixture | 86 files, zero second-run changes |

ADB currently lists no devices. These results establish the reproduced startup
bug, source changes and compilation; physical Moto long-session validation is
still pending. Signed APK/desktop packages are built by the tagged personal CI.
Static web publication preserves runtime files and old assets and does not
restart discovery/notes/voice or Offroader.
