# Remote input lock — 3.9.120

Web, Quest flat-browser and Android Control now share a compact padlock toggle.
It stays available when the main toolbar is collapsed. The amber icon and small
`Input locked` indicator identify viewing mode. Tap the padlock again to resume
control. The independent `gt.remote.inputLock.v1` preference remembers the choice
on that browser/device; a missing preference keeps the existing unlocked default.

## Behavior and ownership

- Lock at both the UI send wrapper and `makeRtcLink.send`, covering mouse hover,
  absolute/relative movement, taps, drags, wheel input, text/IME, special keys,
  sticky modifiers, nested shortcut sequences and physical gamepad forwarding.
  Blocked input reports failed delivery, preserving input-feedback semantics.
- Track successful key/button holds and gamepad state in the transport. Entering
  lock sends only their releases in one reliable sequence. Clear both legacy and
  epoch pointer anchors first, so release/unlock cannot replay an old cursor move.
- Cancel pending move flushes, long presses, target right-click and edge movement.
  Clear held/sticky UI state, close the active input panel, stop gamepad polling,
  dismiss/reset the keyboard and prevent host focus notifications from reopening it.
- Single-finger/mouse drag pans the local picture; two fingers pinch and pan.
  Wheel movement pans locally; Ctrl+wheel zooms locally. None moves the PC cursor.
  Keep the zoom chip, monitor/all-screen selection, sound, stream tuning, screenshot
  and viewing/presence machinery available. Hide input pins/scroll strip while locked.
- Physical PC cursor updates can still be mirrored, but cannot pull a locked
  viewer's crop away from its chosen position.

No native/protocol change is required: existing authorized reliable input messages
perform releases. Frame identity, pointer anchoring while unlocked, input gating,
decoder recovery, rotation and video quality remain under their existing owners.
The preference protects the current client; it does not lock the PC's local input
or other independently connected clients.

## Verification

- Full frontend suite: 53 files, 399 tests pass, including nine new regressions.
- Tests cover every input family, nested shortcuts, held releases, failed sends,
  legacy and epoch anchor clearing, preference restoration, keyboard suppression,
  the collapsed-toolbar toggle, and actual local pinch/pan with zero sent input.
- TypeScript and production desktop/APK frontend build pass. Isolated discovery
  build passes. Android/native implementation sources are unchanged; signed
  packaging runs through the personal tagged release CI.
- Chromium preview of the actual Control component: lock indicator, locked click
  with zero input events, zoom to 2x, active video, and collapsed-toolbar access
  verified. The fixture connects to no PC. Preference remount is automated-tested.
- Publication uses the additive reviewed web deploy helper, retaining runtime data,
  old hashed assets and the running discovery/remote-host processes.
- All 102 local/public entry-reference and asset-hash checks pass after deployment;
  all nine protected baseline file hashes remain unchanged.

Physical Android/Quest validation remains outstanding. Private logs and the isolated
preview screenshot are saved under `.logs/*3.9.120*`.
