# GameTracker

A premium, local-first **play & app analytics** app for Windows. It lives in the system tray,
silently records what you play and use, and turns it into an animated dashboard — live now-playing,
activity heatmaps, streaks, a horizontal timeline, and a curated collection of your completed games.

It also **streams your PC to your phone**. The Remote feature is a full cloud-gaming-style remote
desktop: hardware H.264 encoded on the GPU, controllable from Android, a browser, or a Meta Quest.

Built with **Tauri 2 (Rust)** + **React 19 / TypeScript / Tailwind 4 / Motion**. The app launches to
the tray at login and stays out of your way.

---

## What it does

### Tracking
- **Dual tracking, accurately.** Records both total process **runtime** (counts even when
  alt-tabbed) and **active/focused** time (idle/AFK excluded). Most trackers only do the latter and
  undercount badly.
- **Nothing is added behind your back.** Games are added by you — manually, by dragging in an `.exe`
  or folder, or by running an explicit scan (Steam / Epic / GOG / running processes). There is no
  auto-add-at-startup.
- **Survives crashes.** Sessions merge across quick restarts and orphaned sessions are recovered and
  flushed on exit.

### Dashboard & library
- Live now-playing card, animated stat tiles, a 6-month activity heatmap, weekly trends, top games,
  recent sessions.
- **Library** with poster art, statuses (Playing / Backlog / Completed / Dropped), ratings, notes and
  tags.
- **Completed-games collection** — import your CSV (title, developer, release/completed year,
  Metacritic, your score) and get completions-per-year, *your score vs critics*, and top studios.
- **Horizontal timeline** of colour-tagged sessions, plus a completions-by-year view. Toggles and
  filters throughout.
- **Sessions log** — filterable table (game, date range, min duration, hide-AFK) with CSV/JSON export.

### Beyond games
- **Music & media** (`/music`) — tracks what you listen to via Windows' media session (SMTC), with
  its own analytics, heatmaps and manual playlists.
- **System monitor** (`/system`) — live hardware stats. Real temperatures come from a bundled
  LibreHardwareMonitor sidecar (CPU temp needs admin).

### Remote + phone/Quest companion
Stream and control this PC from an Android app, a mobile browser, or a Quest headset — over your LAN,
Tailscale, or through a tiny signaling relay from anywhere.

On an NVIDIA PC the frame **never leaves the GPU**: Desktop Duplication → one shader pass that
downscales *and* composites the cursor → **NVENC H.264** → your phone's hardware decoder. A 1080p
frame encodes in **~1.2 ms**. The bitstream is deliberately shaped for latency (no B-frames, no
reordering, 1-frame DPB) so the phone's decoder emits each frame the moment it arrives instead of
buffering ahead. Non-NVIDIA hosts fall back to a SIMD JPEG pipeline feeding the browser's encoder.

Mouse, keyboard, and a virtual Xbox controller all inject into games. See
[`companion/README.md`](companion/README.md), [`signaling/README.md`](signaling/README.md), and the
Remote page in-app.

### Privacy
**Your data stays on your machine.** SQLite at
`%LocalAppData%\com.chilloutgames.gametracker\gametracker.db`. Use **Settings → Backup / Restore** to
snapshot or move it.

Two things do reach the network, both behind a single toggle each:
- **Online metadata** (`online_metadata_enabled`, **on** by default) — fetches cover art and game
  info (Steam → RAWG → SteamGridDB) when you add a game, and lets the app self-update from GitHub
  Releases. Turn it off for fully-offline behaviour.
- **Remote** (`remote_enabled`, **off** by default) — the whole streaming feature. Nothing listens
  until you enable it.

---

## Requirements

- Windows 10/11 with **WebView2** (preinstalled on Windows 11)
- [Rust](https://rustup.rs/) 1.77+ and [Node.js](https://nodejs.org/) 18+
- Optional: an **NVIDIA GPU** (driver 522.25+, Oct 2022) for the fast remote-streaming path. Nothing
  to install — `nvEncodeAPI64.dll` ships with the driver, and the app falls back cleanly without it.

## Develop

```powershell
npm install
npm run tauri dev
```

## Test

```powershell
npm test              # frontend (vitest)
npm run test:rust     # backend (cargo test)
```

Hardware-dependent tests are `#[ignore]`d so they never fail CI or a non-NVIDIA machine. Run them
deliberately:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib remote:: -- --ignored --nocapture
```

## Build

```powershell
npm run build:installer   # NSIS installer -> src-tauri/target/release/bundle/nsis/
npm run build:apk         # Android companion APK
npm run build:all         # both
```

## Release

```powershell
powershell -File scripts/bump-version.ps1 3.9.27 -Tag
git push <remote> HEAD; git push <remote> v3.9.27
```

The tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml), which publishes
the installer + updater manifest and the signed APK. `bump-version.ps1` updates all seven
version files at once — including the Android companion, which the phone's in-app updater reads.

---

## How tracking works

A background thread ticks every ~2 s: it enumerates running processes (`sysinfo`) to find registered
games, reads the foreground window and global idle time (Win32), then accrues **runtime** for every
running game and **active** seconds only for the focused game while you're not idle.

## Project layout

```
src/            React + TypeScript frontend (routes, components, hooks)
  companion/    the phone/Quest client (shared by the APK, web, and Quest)
  lib/          api bindings, queries, WebRTC host
src-tauri/      Rust backend
  db/           SQLite + migrations
  tracking/     the tracking engine
  remote/       remote server, capture, NVENC encode, GPU compositor, input
  system/       hardware monitor
companion/      Android shell (a separate Tauri app)
signaling/      tiny WebSocket rendezvous server
scripts/        build, release, and version tooling
```

## Contributing / working on this project

Read **[AGENTS.md](AGENTS.md)** first — it's the real guide for both humans and AI agents, covering
the architecture, the conventions you must follow, and the traps that already cost time (each one is
there because someone hit it). The remote-streaming pipeline in particular has a long, deliberate
do-not-regress list; §13 explains *why* each piece is the way it is before you change it.
