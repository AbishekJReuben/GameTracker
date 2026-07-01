# GameTracker Remote — Android companion

A thin Tauri Android app that connects to the desktop GameTracker's **Remote** server
to show live stats/music and remote-control the PC. Two ways to connect:

- **Same network** — over your LAN or Tailscale, using the PC's address + PIN.
- **From anywhere** — WebRTC peer-to-peer, brokered by a small signaling server (baked in as
  `wss://discovery.chilloutgamestudio.com`); you only enter the **connection code**. See
  `../signaling/README.md` for hosting that (a Cloudflare Tunnel from the PC).

The UI is the shared React bundle built from `companion.html` (`src/companion/**`), so
it reuses the same design system, types, and helpers as the desktop app. This crate is
just the native shell.

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

On the PC, open GameTracker → **Remote** → toggle it on. Then pick one:

**From anywhere (cloud, recommended):**
1. One-time: run the signaling server + Cloudflare Tunnel (see `../signaling/README.md`) so
   `discovery.chilloutgamestudio.com` reaches your PC. Turn on **cloud access** in Remote.
2. In the app, pick **From anywhere** and enter the **connection code** shown on the PC (the
   signaling address is already baked in). It connects **directly peer-to-peer**.

**Same network:**
1. Pick **Same network**, enter the PC's **address** + **PIN** (Tailscale address works too, from
   anywhere both devices are on the tailnet).

Either way: **Stats** and **Music** mirror your PC live; **Control** streams the screen and lets you
drive the mouse/keyboard.

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
- The screen stream is CPU-encoded JPEG (~12 fps at up to 1280px wide). Good enough for control
  and monitoring; it's not a gaming-grade low-latency codec.
