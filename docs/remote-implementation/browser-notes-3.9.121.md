# Browser Notes panel — 3.9.121

The browser remote toolbar now has a compact Notes icon, including when the
toolbar is collapsed. It opens a panel over the current remote session with
the existing encrypted desktop Notes/clipboard history. The browser's existing
Notes menu entry opens the same panel. Android's existing Notes navigation stays
as before.

The panel starts `useCompanionClip` only while open and visible. It reuses the
approved PC key, relay, encryption, reconnect handling, sort order and bounded
300-item cache. It renders 24 rows initially, with search and Load more. No
separate clipboard store or background synchronization was introduced.

Text is displayed as selectable plain text. Copy writes to the local browser
clipboard; it never injects the text into the PC. Copy feedback waits for actual
success. If the browser refuses clipboard access, a selection fallback is tried,
then a selectable full-text field is offered. Images load only on request and
can be saved; PNG clipboard copying is available where the browser supports it.

Opening Notes releases held input and temporarily gates remote input, clears
pending gestures/IME state and pauses gamepad forwarding. Closing restores the
user's saved input-lock choice. The video element and its sink remain mounted;
the Notes panel does not navigate away from Control or rebuild its stream.
Keyboard focus stays within the dialog and Escape closes it.

## Verification

- Full frontend suite: 55 files, 410 tests pass.
- New tests cover local text/image clipboard APIs, failed copy/manual selection,
  search, image loading, Notes lifecycle, and retaining the video/input-lock choice.
- TypeScript and production desktop/APK frontend build pass; isolated discovery
  bundle passes. No Android native or Rust implementation changed.
- Chromium preview of the actual Control/Notes components showed a synthetic
  desktop item, confirmed local Copy feedback and zero injected input with the
  video sink still active and zero unmounts. The fixture uses a local clipboard
  shim and no relay, credentials, live notes or workstation clipboard.
- Desktop `clipboard_enabled` and `clipboard_auto_capture` are already true,
  confirmed by a read-only settings query. No setting was changed.
- Static publication uses the reviewed additive deployment helper, preserving
  runtime files, old asset hashes and running service processes.
- All 106 local/public entry-reference and asset-hash checks pass after deployment;
  all nine protected baseline file hashes remain unchanged.

Physical Android/Quest clipboard behavior is not claimed. Private verification
records and the preview screenshot are saved under `.logs/*3.9.121*`.
