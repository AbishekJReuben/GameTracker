# GameTracker Remote — Android companion

A thin Tauri Android app that connects to the desktop GameTracker's **Remote** server
to show live stats/music and remote-control the PC.

**Connecting is one-time.** The app connects **From anywhere** over WebRTC peer-to-peer,
brokered by a small signaling server (baked in as `wss://discovery.chilloutgamestudio.com`);
you enter the **connection code** shown on the PC just once. The code is remembered, so on
every later launch the app **auto-connects** and, if the PC is offline, keeps retrying and
re-attaches the moment it comes back online — no re-pairing. See `../signaling/README.md`
for hosting the signaling server (a Cloudflare Tunnel from the PC).

The UI is the shared React bundle built from `companion.html` (`src/companion/**`), so
it reuses the same design system, types, and helpers as the desktop app. This crate is
just the native shell.

## Remote control features

The **Control** tab is a full remote-desktop surface (see `src/companion/screens/Control.tsx`):

- **Hardware-video screen stream** over a **WebRTC media track** (like Chrome Remote Desktop):
  the desktop capture thread streams frames to its webview over a binary Tauri channel, which
  feeds `canvas.captureStream()` into the peer connection, so the browser hardware-encodes
  H.264/VP9 with inter-frame compression + adaptive bitrate; the phone renders a plain,
  hardware-decoded `<video>`. Pinch-to-zoom and pan (edge-clamped so no empty space shows).
  The desktop side captures via **persistent DXGI Desktop Duplication** (GPU, only delivers changed
  frames) and runs a **two-thread SIMD pipeline** (fast downscale + AVX2 JPEG, high-res frames split
  into strips encoded across all cores, capture overlapping encode) so it feeds the video track at a
  high frame rate instead of the old ~6 fps GDI-grab-every-frame loop.
- **Desktop audio**: the PC's sound is captured (WASAPI loopback) and sent as a WebRTC audio track in
  sync with the screen. It starts **muted** (phones only start audio on a tap) — hit the speaker
  button in the top bar to hear your PC.
- **Fullscreen app**: the Android shell hides the system bars (immersive; swipe to reveal) and
  the in-app toolbars are collapsible, so the stream uses the whole screen.
- **Two pointer modes**: **Trackpad** (relative on-screen cursor; tap = click, double-tap-drag =
  drag, long-press = right-click; the view pans to follow the cursor when zoomed) and
  **Direct touch** (tap/drag maps to the absolute screen position). Universal gestures in both:
  two-finger tap = right-click, two-finger drag = scroll, pinch = zoom.
- **Two keyboard modes** (toggle in the compose bar / Keys tab):
  - **Direct** (default) — each keystroke is sent live as you type (robust IME value-diff, so
    autocomplete/emoji/backspace all work). **Android Enter never presses Enter on the PC** —
    use the dock's Enter key for a deliberate PC Enter.
  - **Buffered** — type on the phone, then Android Enter sends the whole line at once (again, no
    PC Enter). Good on flaky links / to avoid accidental submits.
  - The keyboard **auto-opens** when a text field gains focus on the PC (best-effort — mobile
    browsers only raise the soft keyboard from a user gesture, so a prominent **"Tap to type on
    PC"** prompt + a tappable "Typing on PC" chip guarantee one-tap access), plus an always-visible
    floating keyboard button.
- **Buttons & keys**: left/right/middle click, drag-lock, pointer speed, scroll; Esc/Tab/Enter/
  Backspace/Del, arrow cluster, **sticky modifiers** (Ctrl/Alt/Shift/Win), F1–F12, media/volume.
- **Shortcut macros**: Alt+Tab, Win, Show desktop, Task Manager, Alt+F4, Explorer, Copy/Paste/
  Cut/Undo/Select-all, Ctrl+Alt+Del.
- **Navigation**: a quick tab switcher (Stats / Library / Music) is reachable right from Control.
- **Adjustable quality** — live presets *Fluid* (720p/60fps) · *Smooth* (900p/40fps) · *Balanced*
  · *HD* · *Ultra* · *Max 4K*, or custom resolution / sharpness / frame-rate; the desktop capture
  retunes and the encoder bitrate/framerate ceiling is set on the fly. A one-tap frame screenshot,
  and a **debug stats HUD** (enable in the Quality tab) that shows phone display fps, decode fps +
  bitrate + jitter + loss + dropped/frozen frames (WebRTC `getStats`), and host produce fps +
  capture/scale/encode ms + frame size + resolution — with a plain-language bottleneck guess
  (host CPU vs network/decoder). (Lower-sharpness presets use a fast nearest-neighbour downscale —
  the main fps lever on high-res/4K monitors.)

## Prerequisites (one-time, on your PC)

1. **Rust** + the Android targets:
   ```sh
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```
2. **Android Studio** (or the command-line tools) with the **SDK**, **NDK**, and
   **platform-tools**. Set these env vars (paths will differ):
   ```sh
   ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
   NDK_HOME=%LOCALAPPDATA%\Android\Sdk\ndk\<version>
   JAVA_HOME=<your JDK 17 path>
   ```
3. A device with **USB debugging** on, or an emulator.

## Build the APK

From the repo root:

```sh
# 1. First-time only: scaffold the Android project (creates companion/src-tauri/gen/android)
npm run companion:init

# 2. Allow cleartext HTTP/WS (the PC link is http/ws, not https) — REQUIRED once, after init.
#    Edit: companion/src-tauri/gen/android/app/src/main/AndroidManifest.xml
#    Add to the <application ...> tag:
#        android:usesCleartextTraffic="true"

# 3. Build the release APK/AAB (also builds the web bundle first)
npm run companion:android
```

The **unsigned** release APK lands under
`companion/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`.
Android refuses to install an unsigned APK, so sign it (the stock debug keystore at
`~/.android/debug.keystore`, password `android`, is fine for sideloading):
```sh
BT="$ANDROID_HOME/build-tools/<version>"   # e.g. 35.0.0
"$BT/zipalign" -f -p 4 app-universal-release-unsigned.apk aligned.apk
"$BT/apksigner" sign --ks ~/.android/debug.keystore --ks-pass pass:android \
  --ks-key-alias androiddebugkey --key-pass pass:android --out GameTrackerRemote.apk aligned.apk
```
For a Play-Store release, use a real keystore and the `.aab` instead.

## Automated releases (GitHub Actions)

Pushing a `v*` tag runs `.github/workflows/release.yml` in this order:

1. **`create-release`** — opens the GitHub Release for the tag (seconds)
2. **`android`** — builds, signs, and attaches `GameTrackerRemote.apk` + `apk-latest.json`
3. **`desktop`** — builds the Windows NSIS installer + updater `latest.json`

The APK job runs **before** the desktop build on purpose so phone builds are checkable
within minutes instead of after the ~30 min Windows installer. The APK is signed in CI
with a **dedicated release keystore** (not the debug keystore) so every release is signed
with the same key and can install as an update over the previous one.

The CI job re-runs `scripts/patch-android.mjs` after `tauri android init` (the same script
`Build-Apk.ps1` runs locally) to re-apply the manifest customizations — cleartext traffic,
the `REQUEST_INSTALL_PACKAGES` permission, and the `FileProvider` — since `gen/android` is
regenerated and not committed.

### One-time keystore setup (repo secrets)

Generate a release keystore once and store it (base64) as GitHub Actions secrets:

```sh
keytool -genkey -v -keystore release.keystore -alias gtremote \
  -keyalg RSA -keysize 2048 -validity 10000 -storepass <PW> -keypass <PW>
base64 -w0 release.keystore   # value for ANDROID_KEYSTORE_BASE64
```

Add these repo secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

> **Switching signing keys is a one-time break:** a phone that already has a debug-signed
> build installed must uninstall it once before the first release-signed APK will install
> ("signatures do not match"). After that, all updates install cleanly.

## In-app auto-update

Tauri's updater plugin does **not** support Android, so the companion has a small custom
updater:

- On launch it fetches `apk-latest.json` from the Release's stable
  `releases/latest/download/` URL and compares the version to the running app
  (`src/companion/update.ts`).
- If a newer version exists, an **"Update available"** banner appears. Tapping **Update**
  calls the native `download_and_install_apk` command
  (`companion/src-tauri/src/update.rs`), which downloads the APK into the app cache dir and
  hands it to Android's package installer via a `FileProvider` content URI.
- **Android never allows a fully silent sideload install** — the OS shows its own one-tap
  install confirmation (and, the first time, prompts to allow "install unknown apps" for the
  companion, which is why the `REQUEST_INSTALL_PACKAGES` permission is required). This is as
  close to the desktop's silent self-update as stock Android permits.

If you repoint releases at a different GitHub repo, update `MANIFEST_URL` in
`src/companion/update.ts` to match (it must be the same host as the desktop updater's
`latest.json`).

### Live-reload dev (optional)
```sh
# terminal 1 — serve the web bundle
npm run dev
# terminal 2 — run on a connected device/emulator
npm run companion:android:dev
```
For a physical device, set `build.devUrl` in `companion/src-tauri/tauri.conf.json` to your
PC's LAN/Tailscale IP (e.g. `http://100.x.y.z:1420`) so the phone can reach Vite.

## Using it

On the PC, open GameTracker → **Remote** → toggle it on, then turn on **cloud access** (one-time:
run the signaling server + Cloudflare Tunnel — see `../signaling/README.md` — so
`discovery.chilloutgamestudio.com` reaches your PC).

In the app, enter the **connection code** shown on the PC (the signaling address is already
baked in). It connects **directly peer-to-peer** and **remembers the code** — every later launch
auto-connects. To pair with a different PC, use **Disconnect** (which forgets the saved code).

**Access approval:** with only the connection code, the PC shows a prompt the first time this
device connects — choose **Temporary** (pick a duration; a live countdown shows on the PC's
Remote page), **Permanent** (remembered across restarts), or **Cancel**. To skip the prompt
entirely, also enter the PC's **permanent key** (the value behind the eye toggle on the Remote
page) in the app's optional "Permanent key" field — that device is then trusted automatically.
Manage or revoke devices in the PC's Remote → **Devices** panel.

**Stats** and **Music** mirror your PC live; **Control** streams the screen and drives the
mouse/keyboard (see *Remote control features* above).

## Notes / gotchas

- **`companion/` needs its own `package.json`** (already committed). The generated Gradle build
  shells out to `npm run tauri android android-studio-script` with its working directory set to
  `companion/`; without a local `package.json` there, npm walks up and runs the **root** app's
  `tauri` script instead, silently building the wrong project (wrong identifier, wrong config).
- **Cleartext traffic** (step 2) is mandatory — without it Android blocks the `http://`/`ws://`
  connection to your PC and the app can't connect. `build.gradle.kts` sets
  `manifestPlaceholders["usesCleartextTraffic"] = "true"` unconditionally (not just for debug),
  since the companion always talks plain http/ws, release builds included.
- **Input into games / elevated apps**: injecting mouse/keyboard into an elevated window (many
  games, UAC prompts) requires the desktop GameTracker to run **as administrator**.
- Everything stays on your own devices — the phone talks only to your PC; nothing goes to a
  third-party server.
- The screen stream is a **WebRTC video track** (hardware H.264/VP9, adaptive bitrate), fed from
  the desktop capture thread. The phone picks quality live (resolution up to 4K, 10–60 fps) via
  the **Quality** tab. For it to always be reachable after a reboot, install the signaling server
  as a logon task: `npm run signal:install-startup` (see `../signaling/README.md`).
- **Keyboard text goes to the PC's focused window** — click into the target field on the streamed
  screen first (the keyboard also auto-opens when the PC reports a focused text field). Injecting
  into elevated/game windows still needs the desktop app run as administrator.
