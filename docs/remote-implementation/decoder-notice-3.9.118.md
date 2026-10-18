# Clear decoder warnings after recovery — 3.9.118

The user confirmed that video recovered, while the top `Phone decoder error`
banner remained visible. The banner previously expired after 20 seconds and
native frame recovery emitted no event to clear it. A successful codec init
could clear it prematurely; delayed fallback diagnostics could also resurrect
a warning after working video had already returned.

## Changes

- Allow a 750 ms grace period for a transient native error before displaying a
  warning. Persistent failures still produce one warning per interrupted stream.
- Emit a recovery event after a fresh picture reaches the existing native,
  WebCodecs or RTC presentation boundary. Initialization alone is insufficient.
- Current native bridges require visible-frame/feed/bounds proof; older bridges
  keep their output-counter compatibility path. No view/input acknowledgment is
  synthesized by these message changes.
- Clear the decoder banner and its expiry timer on recovery/disconnect. Preserve
  unrelated monitor-switch warnings. Dispose of timers when changing links.
- Guard asynchronous diagnostic delivery with a notice revision, so a late old
  dump cannot restore a recovered warning or overwrite a newer decoder notice.

The decoder/capture/restart algorithms, codec selection, frame queues, view
identity, input safety and Android Java templates are unchanged. This follows
the user's clarified request to fix the warning after successful recovery.

## Verification

- Regressions reproduce transient warning flashes, missing recovery notification,
  late diagnostic resurrection and initialization clearing before presentation.
- Full frontend suite: 50 files, 368 tests pass.
- TypeScript and desktop/APK frontend bundle: pass.
- Isolated discovery frontend build: pass.
- Native UI tests also preserve monitor-switch errors and check timer cancellation.
- The three original dirty tracked files and all nine protected baseline hashes
  remain unchanged. Static deployment retains runtime data and old hashed assets.

No Android Java or Rust implementation changed; signed APK/desktop packaging is
delegated to the tagged personal CI. ADB lists no devices, so device verification
of the new banner behavior remains pending. No live service is restarted.
