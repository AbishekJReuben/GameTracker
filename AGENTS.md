# GameTracker — Agent & Contributor Guide

> A working knowledge base for any AI agent (or human) picking up this project. Read this top
> to bottom once before touching code. It explains **what the app is, why it's built this way,
> how every layer fits together, the conventions you must follow, and the traps that already cost
> time so you don't repeat them.**

---

## 1. What this project is

GameTracker is a **premium, local-first game-playtime analytics desktop app for Windows**. It
auto-starts at login, lives in the system tray, silently records gaming sessions, and presents them
as an animated dashboard (live now-playing, heatmaps, streaks, a horizontal timeline) plus a curated
**completed-games collection** with personal/critic scores.

It is a **full rewrite** of an earlier .NET 8 / WinUI 3 app that was "ugly, buggy, non-functional"
with weak (foreground-only) tracking. The old code was deleted; nothing of it remains except the
domain concepts.

### Product requirements that drive the design (do not regress these)
- **Looks premium and compelling even on first run** — the onboarding screen and dashboard are the
  product's first impression. Visual polish is a feature, not a nice-to-have.
- **Accurate tracking** — record **both** total process *runtime* (counts even when alt-tabbed) and
  *active/focused* time (idle/AFK excluded). The old app only counted focused time and undercounted.
- **On-demand detection only** — never auto-add games at startup. The user adds games manually,
  by drag-and-drop, or by explicitly running a scan.
- **Local-first, with online enrichment on by default** — `online_metadata_enabled` now defaults
  **on**, so adding a game auto-fetches its cover + info (Steam → RAWG → SteamGridDB) on a worker
  thread and the app silently self-updates from GitHub Releases. All of it is gated by that one
  setting; turning it off restores fully-offline behavior.
- **Toggles & filters everywhere**; **horizontal** timeline.
- The user's **completed-games CSV** is a first-class, integrated part of the app (not a bolt-on).

---

## 2. Research summary (why this stack)

Comparable apps studied:
- **Playnite** — game library manager; logs hours for launched games. Heavy, launcher-centric.
- **ActivityWatch** — open-source automatic time tracker; local/privacy-first window-title tracking.
- **Playnite GameActivity plugin / ManicTime** — session aggregation, per-game stats.

Takeaways folded in: automatic background tracking, local/privacy-first storage, per-game session
aggregation with day/week/month rollups, and a "your library + your stats" mental model.

Stack decision — **Tauri 2 (Rust) + React/TS web frontend**, chosen over Electron and WinUI:
- **Tauri** builds stay small (the installer started at **2.7 MB** and is now ~27 MB as bundled
  assets and the hardware-monitor sidecar landed; Electron would still be far larger before any of
  that), launch fast, and have first-class **tray + autostart + single-instance** plugins — ideal
  for a background utility. Rust gives us direct Win32 access for process/idle tracking.
- **Web frontend** unlocks the best modern UI/animation ecosystem (the reason we can hit "premium").

Frontend libraries chosen (and why) — versions are what's actually in `package.json` today:
- **React 19 + TypeScript 5 + Vite 7** — fast, familiar, great DX. Vite is held at 7 on purpose: the
  dev machine runs Node 21, and newer Vite requires Node 22+ (see §11 Quick reference).
- **Tailwind CSS 4** — design-token-driven styling; our tokens live in `tailwind.config.js`.
- **Motion 12** (the `motion` package — the successor to `framer-motion`; import from `motion/react`,
  not `framer-motion`) — route transitions, `AnimatePresence`, layout animations, micro-interactions.
- **Recharts** — bar/scatter charts (Collection page); **custom SVG** for the heatmap, sparkline,
  and the horizontal timeline (more control than a chart lib gives).
- **TanStack Query** — all backend reads/mutations; **Zustand** — UI/live state; **lucide-react** — icons.

Backend crates: `rusqlite`+`r2d2_sqlite` (SQLite, bundled), `sysinfo` (process enumeration),
`windows` (Win32: foreground window, idle time, GDI icon extraction), `ureq` (blocking HTTP for the
on-demand cover fetch), `chrono`, `csv`, `serde`, `image`.

---

## 3. Architecture & repo layout

```
GameTracker/
├─ package.json, vite.config.ts, tsconfig*.json, tailwind.config.js, postcss.config.js
├─ index.html
├─ src/                         # React frontend
│  ├─ main.tsx                  # providers: QueryClient + HashRouter
│  ├─ App.tsx                   # layout, routes, AnimatePresence, global overlays
│  ├─ index.css                 # Tailwind layers + design-system component classes
│  ├─ lib/
│  │  ├─ api.ts                 # TS types mirroring Rust DTOs + invoke() wrappers + assetUrl()
│  │  ├─ queries.ts             # TanStack Query hooks (keys, useGames, useDashboard, mutations…)
│  │  ├─ bridge.ts              # subscribes to Tauri events -> Zustand store + query invalidation
│  │  ├─ format.ts              # dur(), clockString(), relativeTime(), accentFor(), initials()…
│  │  └─ cn.ts                  # clsx + tailwind-merge
│  ├─ store/app.ts              # Zustand: live tracking state, toasts, game-modal control
│  ├─ components/               # Sidebar, Topbar, Page, NowPlaying, Heatmap, Sparkline, StatTile,
│  │                            #   GameCard, GameArt, GameModal, DetectModal, DropZone, Onboarding,
│  │                            #   Toasts, Modal, AnimatedNumber, ui.tsx (primitives)
│  └─ routes/                   # Dashboard, Library, GameDetail, Timeline, Sessions, Collection, Settings
└─ src-tauri/                   # Rust backend
   ├─ Cargo.toml, tauri.conf.json, build.rs
   ├─ capabilities/default.json # Tauri 2 permission grants for the main window
   ├─ icons/                    # generated app icons (do not hand-edit)
   └─ src/
      ├─ main.rs                # thin entry -> gametracker_lib::run()
      ├─ lib.rs                 # Builder: plugins, setup, tray, tracker spawn, command registry
      ├─ state.rs               # AppState { pool, shared, data_dir, media_dir, db_path }
      ├─ error.rs               # AppError (serializes to a string for the frontend)
      ├─ util.rs                # path normalization, time parsing, name-from-exe
      ├─ db/
      │  ├─ mod.rs              # pool init + migrations (PRAGMA user_version)
      │  ├─ models.rs           # GameDto, GameInput, SessionDto, SessionFilter (serde camelCase)
      │  ├─ games.rs            # CRUD, stats join, tags, match_candidates() for the tracker
      │  ├─ sessions.rs         # filtered list + tracker lifecycle (start/resume/accrue/end/orphans)
      │  ├─ settings.rs         # key/value with defaults
      │  └─ stats.rs            # dashboard, heatmap, hour-of-day, streaks, catalog analytics
      ├─ tracking/
      │  ├─ foreground.rs       # GetForegroundWindow -> PID
      │  ├─ idle.rs             # GetLastInputInfo -> idle seconds
      │  ├─ matcher.rs          # exe path / install folder -> registered game
      │  └─ tracker.rs          # the loop + TrackingState + TrackingShared
      ├─ detect.rs              # Steam/Epic/GOG + running-process candidates
      ├─ importer.rs            # tolerant CSV import of the completed-games list
      ├─ icons.rs               # exe icon extraction (Win32/GDI) + cover import
      ├─ metadata.rs            # on-demand online cover fetch (Steam store API, keyless)
      ├─ commands.rs            # every #[tauri::command]
      └─ tray.rs               # system tray menu + actions
```

### Data flow
Frontend calls `invoke("command", args)` (wrapped in `src/lib/api.ts`) → Rust `#[tauri::command]`
in `commands.rs` → `db::*`/`detect`/`importer`/`metadata`. The background **tracker thread** writes
sessions directly and emits `tracking://state` / `session://event` events → `src/lib/bridge.ts`
updates the Zustand store and invalidates queries → UI reacts. Images are stored as files under
`media_dir` and shown via `convertFileSrc()` (the Tauri **asset protocol**).

---

## 4. Backend deep-dive

### Database (SQLite, WAL)
- Location: `%LocalAppData%\com.chilloutgames.gametracker\gametracker.db` (+`-wal`/`-shm`). Media
  (covers/icons) in the sibling `media/` folder.
- Tables: `games`, `sessions`, `tags`, `game_tags`, `settings`. See `db/mod.rs::run_migrations`.
- A **game** may have **no exe** — those are *catalog entries* (e.g. imported completed games).
  `is_tracked` is derived (`exe_paths != '[]' OR install_folder IS NOT NULL`), not stored.
- A **session** stores `runtime_seconds` AND `active_seconds` separately + `was_idle_ended`.

#### Migrations
Hand-rolled via `PRAGMA user_version`. To add one: bump the guard in `run_migrations` (e.g.
`if version < 2 { … ; PRAGMA user_version = 2; version = 2; }`). Never edit an already-shipped
migration block; always append a new one.

### Settings
`db/settings.rs` — key/value with a `DEFAULTS` table (idle_minutes=5, min_session_seconds=30,
tracking_paused=false, start_with_windows=true, online_metadata_enabled=false, onboarded=false,
close_to_tray=true, notify_sessions=true …). Reads fall back to defaults; `all()` merges them.

### Tracking engine (`tracking/tracker.rs`) — the heart of the app
A dedicated `std::thread` loop, ticking every **2s** (`TICK_SECS`):
1. Reload the registered-game cache every ~16s (`RELOAD_EVERY`).
2. If `tracking_paused`, end all open sessions and emit an idle state.
3. `sysinfo` refresh → build the **running set** (games with a live matching process). This drives
   **runtime** even when not focused.
4. Foreground PID (`foreground.rs`) → exe via `sysinfo` → match to a game = the focused game.
   Global idle via `idle.rs`.
5. End sessions for games no longer running. Start/resume sessions for new ones
   (`sessions::start_or_resume`, 120s merge window for quick restarts).
6. Accrue per tick: `runtime += 2` for every running game; `active += 2` **only** for the focused
   game when **not idle**.
7. Emit `tracking://state` (live now-playing) and `session://event` (start/stop toasts). Update the
   shared snapshot (`TrackingShared`) so `tracking_state` command and the tray can read it synchronously.

Crash recovery: `sessions::close_orphans` runs on startup (any session with `end_utc IS NULL` is
closed at its `last_seen_utc`).

### Commands (`commands.rs`)
**Commands are synchronous `fn`** (not async). This is intentional and safe: the WebView2 UI runs in
a *separate process*, and our SQLite queries are sub-millisecond, so brief main-thread work doesn't
jank the UI. Keep new DB commands sync unless you're doing genuinely long work (then spawn a thread).
Each returns `AppResult<T>` so errors serialize to a string the frontend can show.

To **add a command**: write `#[tauri::command] pub fn foo(state: State<AppState>, …) -> AppResult<T>`
in `commands.rs`, register it in the `tauri::generate_handler![…]` list in `lib.rs`, and add a wrapper
in `src/lib/api.ts`. If it touches files the webview must read, save under `state.media_dir`.

### Detection (`detect.rs`)
Keyless: parses Steam `libraryfolders.vdf` + `appmanifest_*.acf`, scans Epic/GOG folders, and
suggests running processes under game-like paths. Returns `Candidate`s; **never auto-imports** — the
user confirms in `DetectModal`.

### CSV import (`importer.rs`)
Tolerant: maps columns by fuzzy header match; bad years/scores are flagged as warnings, not dropped;
dedupes by name. Imports as `status='completed'` catalog entries.

### Online covers & enrichment (`metadata.rs`)
`fetch_game_info` resolves a title to a Steam appid (keyless storesearch) → `appdetails` →
`build_steam_metadata` (cover, dev, year, metacritic, tags, screenshots, trailer, theme). Titles not
on Steam fall back to RAWG (`RAWG_API_KEY`). **Covers**: Steam library art (`library_600x900[_2x]`,
then `header.jpg`); when that 404s or the game isn't on Steam, **SteamGridDB** portrait art
(`STEAMGRIDDB_API_KEY`), then the RAWG background image — so RAWG-only games still get a cover (this
fixed ZZZ / Wuthering Waves / 007 First Light). `fetch_game_info_by_appid` skips the name search when
the appid is already known (autosuggest pick / Steam detection). `search_game_suggestions` powers the
add-game autosuggest. Adds run enrichment via `enrich_game_async` (commands.rs) on a worker thread,
emitting `game://enriched` when done.

### Silent updates (`lib.rs`, `tauri.conf.json`)
`tauri-plugin-updater` checks `…/releases/latest/download/latest.json` on launch and silently
installs a newer **signed** build (`spawn_update_check` → `download_and_install` → `restart`). NSIS
`installMode: "quiet"`; since the app already runs elevated, no extra UAC prompt. The public key is in
`tauri.conf.json`; CI signs with `TAURI_SIGNING_PRIVATE_KEY` (see `.github/workflows/release.yml`).

### Icon extraction (`icons.rs`)
`SHGetFileInfoW` → `HICON` → GDI (`GetIconInfo`/`GetObjectW`/`GetDIBits`) → BGRA→RGBA → PNG via the
`image` crate. Best-effort: returns `Ok(None)` on any failure so the UI shows its gradient placeholder.

### Tray & autostart (`tray.rs`, `lib.rs`)
Tray menu: Open / Pause-resume / Quit; left-click shows the window; tooltip reflects live state
(updated from the `tracking://state` listener in `lib.rs`). Autostart via `tauri-plugin-autostart`,
configured **in Rust** (`init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"]))`). Closing the
window hides to tray when `close_to_tray` is on.

---

## 5. Frontend deep-dive

- **Routing**: `HashRouter` (file-protocol friendly). Routes in `App.tsx`, wrapped in
  `AnimatePresence` keyed by the top path segment for page transitions. Each route renders `<Page>`
  (sticky `Topbar` + scroll area + enter/exit motion).
- **Data**: every read is a TanStack Query hook in `queries.ts`; mutations invalidate via
  `useRefreshAll()`. `useDashboard` polls every 30s.
- **Live state**: `bridge.ts` (mounted once via `useTauriBridge()` in `App`) listens to Tauri events
  and writes to the Zustand store (`store/app.ts`). `NowPlaying`, `Sidebar`, `Topbar` read it.
- **Images**: `assetUrl(path)` = `convertFileSrc(path)`; `GameArt` falls back to a deterministic
  gradient + initials when there's no image.
- **Modals**: global add/edit game modal is controlled by the store (`openGameModal`), rendered once
  in `App`. Drag-drop is global (`DropZone`).

### Design system (keep new UI consistent with this)
- Tokens in `tailwind.config.js`: surfaces `bg-base/900/850/800…`, `ink`/`ink-soft/dim/faint`,
  `accent` (violet→blue→cyan→green), shadows `glow/card/float`, `bg-accent-sheen` gradient.
- Reusable classes in `index.css`: `.card`, `.glass`, `.pill`, `.btn-primary/ghost/subtle`, `.input`,
  `.accent-text`, `.focus-ring`.
- Primitives in `components/ui.tsx`: `Card`, `SectionTitle`, `Badge`, `StatusBadge`, `Segmented`,
  `Toggle`, `EmptyState`, `Skeleton`, `Spinner`, `statusColor()`.
- Status colors: playing=green, completed=violet, backlog=blue, dropped=pink.

---

## 6. Conventions you MUST follow

- **Serde casing**: Rust DTOs use `#[serde(rename_all = "camelCase")]`. The TS interfaces in
  `api.ts` must match exactly. When you add a field, update **both** sides.
- **Command args**: `invoke("name", { argName })` keys are **camelCase** and must match the Rust
  parameter names (Tauri converts snake_case params to camelCase on the JS side).
- **Errors**: backend returns `AppResult<T>`; never `panic!` in a command. Frontend wraps risky
  invokes in try/catch and surfaces a toast.
- **Paths**: normalize with `util::normalize_path` (lowercase, backslashes) before storing/matching.
- **Time**: store RFC3339 UTC strings; convert to local for any day/hour bucketing (see `stats.rs`).
- **New files the webview reads** must live under `media_dir` (asset-protocol scope is
  `$APPLOCALDATA/**`).
- **Tailwind weights**: use `font-500/600/700/800` (added to the config). `font-bold` etc. also work.

---

## 7. Build, run, verify

```powershell
npm install                 # once
npm run tauri dev           # hot-reload dev (Vite + Rust). Opens the window.
npx tsc --noEmit            # typecheck frontend (fast)
npx vite build              # verify the bundle
cd src-tauri && cargo check # compile-check backend (fast-ish; first run is slow)
npm run tauri build         # release installer -> src-tauri/target/release/bundle/nsis/*.exe
npm run tauri icon "_iconsrc/icon-square.png"   # regenerate app icons from a square PNG
```

**Verifying without a screen** (the human may decline computer-use): inspect the SQLite DB directly.
```
%LocalAppData%\com.chilloutgames.gametracker\gametracker.db
```
e.g. `select count(*) from games;`, check `sessions`, etc. This is how we confirmed the 90-game CSV
import worked end-to-end. To **reset** to first-run, close the app and delete the DB (+`-wal`/`-shm`).

**Manual tracking test**: add a harmless always-present exe (e.g. `notepad.exe`) as a game, focus it
(active ticks), alt-tab away (runtime continues, active pauses), close it (session is written with
both totals).

---

## 8. Troubleshooting — real issues already hit and their fixes

| Symptom | Cause | Fix |
|---|---|---|
| Startup panic: `PluginInitialization("autostart", … invalid type: map, expected unit)` | Put `"autostart": {}` under `plugins` in `tauri.conf.json` | Autostart is configured **in Rust**, not the config. Leave `"plugins": {}`. |
| Asset images don't load / forbidden | Asset protocol not enabled | `app.security.assetProtocol.enable=true` + scope in `tauri.conf.json`, **and** the `protocol-asset` feature on the `tauri` crate in `Cargo.toml`. |
| `TrackingState: Deserialize is not satisfied` (in `lib.rs`) | We parse the event payload back into the struct | Derive **both** `Serialize, Deserialize` on `TrackingState`. |
| Tailwind classes like `font-700` do nothing | Not default Tailwind keys | Added numeric `fontWeight` keys to `tailwind.config.js`. |
| Placeholder initials don't scale | `cqw` unit needs a container | `GameArt` root has `[container-type:inline-size]`. |
| `Segmented` rejects numeric options (timeline range) | Generic was `T extends string` | Relaxed to `T extends string | number`. |
| `accentFor` returns `string[]` not tuple | Array literal widened | Annotated `ACCENTS: [string,string][]`. |
| `cargo check`/`build` hangs or conflicts | A `tauri dev` instance holds the target lock | Stop `tauri dev` first (closing the app window also ends it), then run cargo. |
| `windows` crate GDI type mismatches | `GetObjectW`/`DeleteObject` want `HGDIOBJ` | Wrap handles: `HGDIOBJ(hbitmap.0)`. For foreground PID, prefer mapping PID→exe via `sysinfo` over more Win32 calls. |
| `tauri.conf.json` edits don't take effect | The config is embedded at compile time by `generate_context!` | Rebuild the Rust crate after editing it. |

### Tips & tricks that saved time
- **Compile the backend early and often** with `cargo check` — the `windows`/`sysinfo`/`tauri` API
  surface is where mistakes hide. We got the whole backend to one error this way.
- **Run long builds in the background** and poll the output file for `Finished`/`error`.
- **Verify via the DB**, not just the UI — it's objective and works headless.
- `sysinfo` 0.32: `refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::everything())`;
  `Pid::from_u32(pid)`; `process.exe()` → `Option<&Path>`.
- The icon source art is landscape; we center-fit it onto a 1024² transparent canvas before
  `tauri icon` (see `_iconsrc/`), otherwise icons come out squished.

---

## 9. Gotchas / invariants not to break
- **Detection never auto-adds.** Keep scans behind explicit user action.
- **Online enrichment is gated by `online_metadata_enabled` (default on).** Adding a game triggers a
  background `enrich_game_async` (covers/info) and the app checks GitHub Releases for updates on
  launch. Any new network feature must respect this single toggle so users can go fully offline.
- **Runtime vs active** are distinct metrics end-to-end (DB, stats, UI). Don't collapse them.
- Commands stay **synchronous** unless doing real long work.
- Heatmap/streaks/hour-of-day bucket by **local** day/hour; "today/this week" math is in `stats.rs`.

---

## 10. Roadmap / ideas (good next tasks)
- **Per-game "fetch cover" button** on `GameDetail` (backend `fetch_cover` already exists).
- **Yearly "Wrapped"** recap view (data is available; add a route + shareable image export).
- **Shareable stat-card image export** (render a card to canvas/SVG → PNG via a save dialog).
- **Better cover matching** in `metadata.rs` (fuzzy-compare the Steam result name to the query;
  optionally add SteamGridDB/IGDB behind the existing opt-in setting + a user-provided key).
- **Store Steam appid** during detection so covers/metadata are exact (no name search needed).
- **Break/wellbeing reminders** and **daily goals** (deferred per product decisions; revisit if asked).
- **Tag management UI** and tag-based library filters (tags exist in the schema already).
- **Real icon polish**: prefer the largest available icon (`SHGFI_SYSICONINDEX` + jumbo icons via
  `IImageList`) for crisper list art.
- **Tests**: add Rust unit tests for `util` path matching, `importer` parsing, and `stats` streaks.

---

## 11. Quick reference

- App identifier: `com.chilloutgames.gametracker` · product: GameTracker · version 1.0.0
- Data dir: `%LocalAppData%\com.chilloutgames.gametracker\`
- Events: `tracking://state` (live snapshot), `session://event` (`{kind:"start"|"end", …}`)
- Tracker constants: tick 2s, merge window 120s, reload cache ~16s
- Installer output: `src-tauri/target/release/bundle/nsis/GameTracker_<ver>_x64-setup.exe`
- Toolchain present on the original dev machine: Rust 1.96, Node 21, dotnet 10 (unused now)

---

## 12. June 2026 UX / performance pass (v3.1.x) — changes & new conventions

### Performance: network commands must run OFF the main thread
The online-fetch commands were synchronous `#[tauri::command] fn`, which run on the **main
thread** and froze the WebView while doing blocking HTTP — this caused the "page hangs for a
second" and "app feels very slow when info is loading" bugs. They are now **`async fn`** whose
blocking body is offloaded via the **`run_blocking`** helper in `commands.rs` (wraps
`tauri::async_runtime::spawn_blocking`). Pattern: clone `state.pool` / `state.media_dir` out of
`State<'_, AppState>` **first**, then move the clones into the closure (`State` isn't `'static`).
Converted: `fetch_cover`, `fetch_game_info`, `fetch_hltb`, `fetch_app_info`,
`fetch_steam_reviews`, `fetch_metacritic_reviews`.
**Rule: any new network/file-heavy command does the same — never a plain sync `fn`.** Pure
sub-millisecond SQLite commands stay sync (as before).

### Live game stats are cached with the game (migration v16)
The old blocking `fetch_game_stats` is **removed**. Migration **v16** adds `games.stats_json` +
`games.stats_fetched_utc` (helpers `games::get_stats_cache` / `set_stats_cache`). Two commands
replace it:
- `get_game_stats(game_id) -> CachedGameStats { stats, fetchedUtc }` — **sync, instant**, reads
  the cache only (no network → no hang on open).
- `refresh_game_stats(game_id)` — spawns a worker thread (like `enrich_game_async`), fetches,
  caches, and emits **`game://stats`** `{ id, stats, fetchedUtc }`; returns immediately.

`GameStatsPanel` renders the cache instantly on open, kicks a background refresh only when the
cache is missing or **>6h stale**, and listens for `game://stats` to update in place.
`metadata::GameStats` now derives `Deserialize` too (so the cache JSON can be read back).
Latest DB `user_version` is **16**.

### Prefs persist all filters/toggles (store/app.ts)
`Prefs` gained `libraryFilters` (status / sort / trackedOnly / tag / tagsOpen), `sessionFilters`
(kind / minMinutes / excludeIdle), and `marquee` (below). The Library and Sessions pages read
these from prefs instead of local `useState`; `timelineRange` is now written by GameDetail **and**
the Timeline page (shared "remembered" range). `mergePrefs` merges the new nested slices. All
prefs still mirror to the DB `ui_prefs` key, so they survive a localStorage wipe / reinstall.

### GameDetail
- **Missing-info nudge**: a one-tap "Get data" banner appears only when core enrichment fields are
  absent **and** the entry was never enrich-attempted (tracked in `localStorage`
  `gt.enrichAttempted`, set inside `enrichAll`).
- **Session history** is grouped into **24-hour day buckets** (Today / Yesterday / dated headers
  with per-day totals); each session shows its start time + duration.

### Dashboard
Stat tiles compacted to free horizontal space; new pieces: `VerticalCoverMarquee` (portrait cover
wall, left of the stats on `xl`), `AppsTodayMarquee` (CSS-mask-vignette app reel + a parallax icon
layer), and an "interesting stats" column beside the When-you-play clock (`PlayInsights`).
`Heatmap` gained a `maxStep` prop so it can grow to fill its panel.

### Marquee background system + 3-state toggle
`prefs.marquee: "off" | "compact" | "full"` (default **full**; Settings → Appearance). Gating hook
**`useMarqueeTier(tier: "base" | "extra")`** in `store/app.ts`:
- **base** marquees (the originals — `CoverMarquee`, `VerticalCoverMarquee`, `ImageMarquee`,
  `PanelArtBackdrop`/`ArtCard`, the `AppsTodayMarquee` reel) self-hide only when level is `off`.
- **extra** decorative backdrops show **only** when level is `full`.

The extra engine is **`components/MarqueeFX.tsx`** — one component with ~18 distinct techniques
(`drift`, `driftReverse`, `vertical`, `verticalReverse`, `parallax`, `diagonal`, `tilt3d`,
`conveyor`, `duotone`, `grayscale`, `bokeh`, `kenburns`, `ticker`, `wave`, `spotlight`, `mosaic`,
`pulse`, `shader`) + a **`MarqueeCard`** wrapper (Card + backdrop + `relative z-10` content). The
`shader` variant uses `components/animations/MarqueeShader.tsx` (self-contained WebGL plasma).
Applied across Dashboard / Library / Timeline / Collection / Sessions / Tags with
category-relevant art (covers, app icons, screenshots→cover fallback). Cover/icon variants render
via `GameArt` (gradient+initials fallback → **never an empty rail**, even pre-cover); the
photo-filter variants (`duotone` / `grayscale` / `bokeh` / `kenburns`) need real images
(screenshots, else cover URLs). New CSS keyframes in `index.css`: `gt-marquee-y`, `gt-kenburns`,
`gt-spotlight`, `gt-wave` (joining `gt-marquee`).

**Backdrop pattern** (reuse this for any new marquee panel): the backdrop is
`pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]` with vignette scrims; the
host panel must be `relative` and its content lifted to `relative z-10` — exactly what
`ArtCard`/`MarqueeCard` do. **Do not** add `overflow-hidden` to the host `Card` when it has hover
tooltips (Timeline / Heatmap): the backdrop already clips itself, and clipping the Card would cut
off the tooltips.

---

## 13. Remote access + phone companion (v3.2.x) — `/remote`, companion app, signaling

A **Remote** feature lets an Android phone view live stats and control this PC's screen. Two
transports share one UI; the whole feature is gated behind the **`remote_enabled`** setting
(default off), same "one toggle" convention as other network features.

**Desktop remote server** — `src-tauri/src/remote/`: `mod.rs` (the axum server), `capture.rs` (the
capture/encode pipeline), `dxdupe.rs` (DXGI Desktop Duplication + cursor), `gpu.rs` (the scale +
cursor-composite shader), `native.rs` (D3D11 plumbing + the Rust→webview frame container),
`nvenc/` (`ffi.rs` bindings, `mod.rs` encoder session, `sps.rs` bitstream fixup), `input.rs`
(injection), `audio.rs`, `gamepad.rs`, `focus.rs`, `adb.rs`, `uac.rs`. An
embedded **axum** HTTP+WS server on **port 47800** (`remote_port`), bound `0.0.0.0`, permissive
CORS. Pairing: a 6-digit **PIN** (shown on `/remote`) → `POST /pair` returns a bearer token; every
`/api/*` needs it. WS channels carry the token as a `?token=` query (browsers can't set WS headers).
Endpoints reuse the exact `db::*` functions via `spawn_blocking`. `/screen` streams delta JPEG tiles
(**xcap** capture); `/control` injects mouse/keyboard (**enigo**, on its own OS thread since `Enigo`
isn't `Send`); `/media?path=<abs>` serves artwork (path-checked under `media_dir`). `best_host_ip()`
prefers a Tailscale 100.64/10 address, else LAN.

**Screen-capture pipeline (`capture.rs` + `dxdupe.rs`) — the fps-critical path.**

> **Read v3.9.27 (native NVENC) at the end of this section first.** On an NVIDIA host the
> stream no longer goes through JPEG at all: it's duplication texture → `gpu.rs` (scale +
> cursor in one shader pass) → `nvenc` → data channel, all on the capture thread, and the
> mailbox/encoder-thread/JPEG machinery described below is the **fallback**. Everything
> here is still live and still correct for that fallback — and much of it (Desktop
> Duplication, MMCSS, TimerBoost, latest-wins) is shared by both paths — but "the host
> produces JPEGs" is no longer the default story.

Historically the companion always used the WebRTC video-track path (below), so the host frame
rate was capped by how fast Rust could produce JPEGs to feed `canvas.captureStream()`.
`start_capture` runs a **two-thread pipeline**: a capture thread hands frames to an encoder
thread through a single-slot latest-wins mailbox, so capture(N+1) overlaps encode(N). (The
zero-copy path finishes a frame entirely on the capture thread and never uses the mailbox —
NVENC at ~1.2ms doesn't need the overlap that a 3.5ms+ JPEG encode did.)
- **Capture = persistent DXGI Desktop Duplication (`dxdupe.rs`, Windows).** The old `xcap` path used
  GDI `BitBlt`+`GetDIBits`, which copies the **whole native framebuffer every frame** (fixed,
  single-threaded, memory-bandwidth-bound → capture was the flat bottleneck at every resolution with
  no core saturated). Desktop Duplication keeps a GPU capture session that only yields **changed**
  frames (cursor-only updates skipped) via a fast staging-texture DMA. Falls back to xcap/GDI if
  duplication init fails (exclusive-fullscreen game, driver quirk). Output is BGRA (`swap_rb`).
- **Downscale = SIMD** (`fast_image_resize`); **encode = SIMD/AVX2 JPEG** (`jpeg-encoder`). Large
  frames are split into **16-aligned horizontal strips encoded in parallel** (`rayon`, `encode_frame`)
  and packed into a "GS" container the host webview composites (see `rtcHost.ts buildVideoTrack`), so
  high-res encode uses all cores instead of one. Hot image crates build at `opt-level=3` (per-package
  profiles in `Cargo.toml`), not the app-wide `opt-level="s"`.
- `remote_capture_stats` exposes per-frame telemetry (capture/scale/encode ms, produced fps, frame
  bytes, native/out res) for the phone's debug HUD. **Do not revert to xcap/GDI full-frame capture or
  a single-threaded resize** — that reintroduces the low frame rate.
- **Zero-copy hot path (v3.2.7):** the capture→encoder mailbox carries `Arc<Vec<u8>>`, not a fresh
  `Vec` per frame — the old `rgb.clone()` (a ~25 MB memcpy per 4K frame) is gone. Change detection
  also moved off the encoder: DXGI only ever yields changed frames, so the capture thread sets a
  `changed` flag (Desktop Duplication → always true; xcap fallback → cheap slice compare) and the
  encoder trusts it instead of running a whole-frame memcmp. The mailbox **carries `changed` forward
  on coalescing** so a real update is never swallowed by a later keep-alive. **Don't re-add the
  per-frame clone or the encoder-side full-frame diff.**
- **GPU downscale + parallel resize (v3.2.7, capture/scale pass):** once encode got fast, capture then
  scale were the tall poles. `dxdupe::grab(timeout, max_w)` now downscales **on the GPU** via
  `GenerateMips`: it copies the frame into a full mip-chain texture (`BIND_RENDER_TARGET |
  BIND_SHADER_RESOURCE | MISC_GENERATE_MIPS`), generates mips, and reads back only the smallest mip
  level still ≥ `max_w` — so the CPU readback and the SIMD resize work on a ~2×-target image instead
  of full 4K, and the scaling load moves to the GPU. Guarded by a one-time `CheckFormatSupport`
  (`MIP_AUTOGEN`); if unsupported it falls back to a full-res readback (never a black frame). The
  staging readback **reuses one buffer** (`self.readback`) with a single bulk memcpy when the row
  pitch is tight (no 33 MB alloc+zero per frame), and `grab` returns the readback via `buffer()`
  (borrowed — `scale_u8x4_to_rgb` takes `&[u8]`, doesn't consume it). The remaining CPU resize is
  **multi-threaded** via `fast_image_resize`'s `rayon` feature (was single-threaded, left cores idle).
  **Don't remove the mip downscale, the buffer reuse, or the rayon feature.**
- **Cursor injection uses `SendInput`, not `SetCursorPos` (`input.rs::move_abs`).** `SetCursorPos` only
  teleports the pointer, so the shell never starts its hover timer → taskbar thumbnail previews (Aero
  Peek) never appear under the remote cursor. `SendInput` with `MOUSEEVENTF_MOVE|ABSOLUTE|VIRTUALDESK`
  injects a real move into the input queue (like AnyDesk), so hover/preview works; multi-monitor is
  preserved by normalizing to the virtual-desktop 0..65535 range. **Don't revert to `SetCursorPos`.**
- **Content-optimization mode** (`CAP_CONTENT`, `remote_set_capture_quality(..., content)`; 0 auto /
  1 text / 2 video): text keeps 4:4:4 chroma + a sharp bilinear downscale for crisp glyphs; video
  uses 4:2:0 + a fast nearest downscale (the 4K-downscale fps lever); auto keys the filter off
  quality. The phone's Quality dock picks it; the host also maps it to the video track's
  `contentHint` (detail/motion) and `degradationPreference` (maintain-resolution/-framerate). The
  guest shrinks its receiver `jitterBufferTarget`/`playoutDelayHint` (~40 ms) to cut decode latency
  — **not 0** (stutters at high res). The desktop Remote page's **Live session** panel shows the host
  capture + link telemetry (send bitrate/fps, RTT, per-stage ms) via `startHost({onStats})`.

**Desktop audio (`audio.rs`).** WASAPI **loopback** capture of the default render endpoint → float32
PCM over a Tauri channel → host webview WebAudio (`buildAudioTrack` in `rtcHost.ts`: jitter buffer →
`ScriptProcessor` → `MediaStreamAudioDestinationNode`) → a WebRTC **audio track** added to the same
stream as the video. `remote_start_audio`/`remote_stop_audio`. The phone starts **muted** (mobile
browsers only start audio from a user gesture) — a speaker toggle in Control unmutes the video track.

**Two ways the phone connects:**
1. **Same network** — phone enters the LAN/Tailscale address + PIN; talks straight to the server
   over http/ws (or over Tailscale from anywhere those are both on the tailnet).
2. **From anywhere (cloud)** — **WebRTC P2P**. A tiny **signaling server** (`signaling/`, standalone
   axum crate, port 8080) brokers only the SDP/ICE handshake; screen + control then flow **directly
   peer-to-peer** (never through signaling). Desktop is the **host** (`src/lib/rtcHost.ts`), phone is
   the **guest** (`src/companion/cloud.ts`), shared helpers in `src/lib/rtc.ts`. Both peers use the
   browser-native `RTCPeerConnection` — **no native webrtc crate**. The screen rides a real **WebRTC
   video track** (hardware H.264/VP9): the host feeds Rust JPEGs (`remote_start_capture`) into a canvas
   → `captureStream()`; the `screen` data channel base64 JPEG is a legacy fallback. `control`
   (guest→host input), `data` (id-correlated stats req/resp **plus** unsolicited host events —
   `focus` for auto-keyboard, `capstats` for the debug HUD). Backend state adds `cloud_enabled`/`code`
   (8-char room id, `remote_regen_code`); the host injects via `remote_inject` (see `commands.rs`).
   **Auto-keyboard:** the host polls `remote_textfield_active` (Win32 caret heuristic, `focus.rs`) and
   pushes `focus` events (with an extra rapid re-check right after each click, `pokeFocus` in
   `rtcHost.ts`); the phone focuses its hidden input. Mobile browsers only raise the soft keyboard
   from a user gesture, so a "Tap to type on PC" prompt is the guaranteed fallback.

**Self-hosting the signaling server (the current setup): Cloudflare Tunnel.** The signaling server
runs on this PC (`npm run signal:serve` → `signaling/serve.ps1`, builds+runs on `localhost:8080`)
and is exposed at **`discovery.chilloutgamestudio.com`** via a Cloudflare Tunnel
(`ingress: discovery.chilloutgamestudio.com → http://localhost:8080`; see
`signaling/cloudflared-config.example.yml`). **The signaling URL is baked in**, so the phone/desktop
"From anywhere" screens need no pasting — only the connection code. Single source of truth:
`src/lib/remoteConfig.ts` (`DEFAULT_SIGNAL_URL`) mirrored by the `remote_signal_url` default in
`src-tauri/src/db/settings.rs` — change both together. STUN is the public Google server; hard NATs
(CGNAT/symmetric) would need a TURN relay (not bundled) for P2P to succeed.

**Phone companion** — a **second Vite entry** `companion.html` → `src/companion/**` (Stats / Music /
Control tabs; `Pairing.tsx` has the two tabs; `link.ts`/`links.ts` dispatch data + the screen link
across LAN-WS vs WebRTC). Reuses the desktop design system + types but talks straight to the server
/ data channel (never proxies desktop `invoke`). Packaged as a **Tauri Android app** under
`companion/src-tauri/`. Build: `npm run companion:android` (see `companion/README.md`). Gotchas:
`companion/` needs its own `package.json` (Gradle's generated task runs `npm run tauri` with cwd
there); release APKs are **unsigned** — sign with the debug keystore (zipalign + apksigner) for
sideloading. Input into elevated apps/games needs the desktop app run as admin.

**CI APK release + phone auto-update (v3.2.8).** The Release workflow
(`.github/workflows/release.yml`) runs **APK before desktop** on every `v*` tag:
`create-release` → `android` (build/sign `GameTrackerRemote.apk` + `apk-latest.json`)
→ `desktop` (NSIS + updater `latest.json`). That way a phone build is checkable within
minutes instead of after the Windows installer. It signs with a
**dedicated release keystore** from repo secrets (`ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`) — a stable key so
updates install over each other (switching from debug-signed needs a one-time
uninstall/reinstall). `gen/android` isn't committed, so both CI and `Build-Apk.ps1` run the
idempotent, CRLF-safe **`scripts/patch-android.mjs`** after init to re-apply the manifest
customizations (cleartext, `REQUEST_INSTALL_PACKAGES`, `FileProvider`). Tauri's updater
plugin is desktop-only, so the phone self-updates via a **custom** flow:
`src/companion/update.ts` fetches `apk-latest.json` on launch, compares to `getVersion()`,
and shows an "Update available" banner; tapping it calls the native
`download_and_install_apk` command (`companion/src-tauri/src/update.rs`) which downloads the
APK (ureq) into the app cache dir and hands it to Android's package installer via a
FileProvider content URI (JNI, no Kotlin plugin). **Stock Android can't fully silently
install a sideload** — the OS always shows a one-tap install prompt. The APK URL/repo owner
in `update.ts` (`MANIFEST_URL`) must match the desktop updater's release host
(`AbishekJReuben/GameTracker`).

**Meta Quest 3 VR client (v3.8.x) — `quest.html` → `src/quest/**`.** A third Vite entry
(alongside `index.html` / `companion.html`). **Quest mounts the exact same `CompanionApp`
+ `ControlScreen` shell as Android** (tabs, docks, quality, shortcuts, keyboard, streaming)
via `setCompanionRuntime()` hooks — muscle memory matches the phone. Quest-only extras:
headset device name, Enter VR + pointer/gamepad toggle on the Control top bar, and
`ImmersiveScreen` WebXR overlay. (`FlatScreen` / `QuestPairing` remain on disk unused.)

- **Flat / 2D** — identical to Android Control (laser = PointerEvents). Typing uses the
  shared compose bar; field is reset before every `focus()` (Quest keyboard overwrite quirk).
- **Immersive VR "big screen"** (`ImmersiveScreen.tsx` + `xr/session.ts`): raw-WebGL
  `immersive-vr` session draws the WebRTC `<video>` on a floating quad. Mapping:
  **trigger = left click/drag**, **squeeze = right-click**, **thumbstick = scroll**,
  **A = keyboard**, **B = Enter**, **X / left-stick-press = recenter**,
  **Y or hold-both-grips = exit**. Gamepad mode → virtual Xbox pad (ViGEm).
  **WebXR layers:** session requests `optionalFeatures: ["layers", …]`. When Quest grants
  `layers`, `updateRenderState({ baseLayer })` throws — must use
  `updateRenderState({ layers: [webglLayer] })` and keep a cached `xrLayer` for the frame
  loop (`renderState.baseLayer` is null under the layers API). Do not regress.

Shared Control features (Android + Quest + discovery mobile browser):
- Special keys include Home/End/PgUp/PgDn/Ins/PrtSc/Caps/Num/ScrLk/Pause + F-keys/media.
- **Game keys** dock (WASD/Space/E/F/…, **WASD+** cluster, add-key, pinnable **Hold**/LMB).
- Shortcuts pane: builtins (Ctrl+C/V/X/Z/Y/S, Alt+Tab, …) + **custom shortcuts** persisted
  in `gt.remote.customShortcuts` (pinMode trash deletes customs only).
- **Control chrome** (`src/companion/controlChrome.ts`, `gt.remote.controlChrome`): free-place
  pins, per-pin style editor (`PinEditorSheet`), toolbar scale prefs; dual-writes legacy
  `gt.remote.pinned` / `pinLayout`.
- Fullscreen (`immersive`): keyboard FAB + pinned rail + tap-to-type (same as dock-collapsed).

Quest-specific gotchas — do not regress:
- **System keyboard has NO key events** and **overwrites the whole value** each open.
  Control resets before `focus()`; immersive still uses `textDiff.ts` (`TextDiffSender`).
  Needs Quest Browser **26.1+**. Hidden `<input>` stays in-DOM and on-screen.
- **Controller mapping is index-exact** (`meta-quest-touch-plus`, `xr-standard`):
  buttons `0`=trigger `1`=squeeze `3`=stick-press `4`=A/X `5`=B/Y, axes `2,3`=thumbstick.
  Unit tests in `xr/math.test.ts` — keep them green.
- **Discovery hosting (HTTPS):** `npm run discovery:build` (alias `quest:build`) emits
  both `companion.html` + `quest.html` into `signaling/static/`. Signaling serves
  `/` + `/companion` → phone browser companion, `/quest` → headset. `serve.ps1`
  auto-builds if either is missing. Desktop Remote page shows both URLs.

**Per-device auth + resilience + decode (v3.2.8).** The Remote page now has a **single**
toggle (`remote_set_enabled` flips both `remote_enabled` and `remote_cloud_enabled`). Access
uses **two codes**: the connection code (code 1 = signaling room) and a secret **permanent
key** (code 2, `remote_secret_code`, shown behind an eye toggle). The guest sends
`{type:"auth", deviceId, name, secret?}` on the control channel; the host **defers Rust
capture** (`startCaptureNow` in `rtcHost.ts`) and gates input/data until authorized. Auth is
decided by `remote_check_auth`: correct secret or a prior grant → allowed; otherwise the host
raises an app-wide approval prompt (`RemoteApprovalModal` via `useRemoteHost.pendingApproval`)
offering **Temporary** (custom-timer grant) / **Permanent** (confirm) / **Cancel**. Grants
persist in DB settings (`remote_trusted_devices`, `remote_temp_grants`, pruned on read);
`remote_grant`/`remote_revoke`/`remote_list_grants` manage them and the page shows a live
countdown. The desktop can also **`adb install`** the latest release APK to a USB phone
(`remote/adb.rs`, `remote_adb_devices`/`remote_adb_install`). **Reconnect-loop fix:** the
signaling server now **evicts a stale same-role peer** on join (no more `room-full` dead-end
when Android switches Wi‑Fi), the guest **retries** on `room-full` and has hard-reset +
decode-stall **watchdogs** (`cloud.ts`), and the host restarts capture if it produces 0 fps.
**Decode:** the receiver jitter buffer was raised from 20ms to an adaptive ~120–300ms (was
dropping ~30% of frames on Android); companion default quality is **1920 / Text / sharpness
100**; the phone always shows fps by the "Live" label and `companion.html` uses
`interactive-widget=resizes-content` so the keyboard doesn't push the top bar off-screen.

**v3.9.5–3.9.10 remote fixes — multi-monitor pop-out (loop 3.9.5, frozen feed 3.9.9, independent
capture+control 3.9.10) + gameplay audio crackle + Android update (fallbacks + integrity) (do
not regress):**
- **Pop-out input is decoupled from the captured monitor (`input.rs`).** There is ONE process-wide
  `Controller` (one system cursor). `ControlEvent::Monitor{index}` (the PRIMARY tab's display
  switch) is the ONLY event allowed to move the global `SELECTED_MONITOR` that the primary capture
  follows. The pop-out path (`inject_on_monitor`) now pins absolute-input bounds to its display via
  the new bounds-only `ControlEvent::InputMonitor{index}` — it must NEVER send `Monitor`. Sending
  `Monitor` there was the bug: controlling a pop-out repointed the original tab's capture and
  collapsed both DXGI duplications onto one output. `inject` (primary) also re-pins to
  `selected_monitor()` before each event so an interleaved pop-out event can't leave the shared
  cursor mapped to the wrong screen. Net: two monitors stream + are controllable side-by-side.
- **APK download integrity (`update.rs`).** In-app updates failed with "package appears to be
  invalid" while the same release APK installed fine from a browser. Cause: `ureq` 2's default
  transparent **gzip** could alter the binary, and the old check validated only the 2-byte "PK"
  magic + a 1 KB floor — so a truncated/altered file passed AND was then reused from cache on every
  retry. Fix: request `Accept-Encoding: identity`, download to a `.part` temp, verify received ==
  Content-Length AND a valid ZIP End-Of-Central-Directory (`50 4B 05 06`) via `apk_looks_complete`,
  then atomically rename into place; a corrupt cache is rejected and re-downloaded.
- **Aux pop-out capture uses DXGI Desktop Duplication, not xcap.** Each pop-out pipeline
  (`start_aux_capture`) now owns a `dxdupe::Duplicator` targeting its monitor by desktop origin,
  same as the primary. Desktop Duplication allows one session PER OUTPUT per process (OS limit is
  4 concurrent apps), so primary + pop-outs coexist. The old xcap full-framebuffer grab returned a
  stale/black or wrong-display image on secondary monitors — the pop-out connected but its visuals
  never updated. xcap remains only as the fallback when duplication init fails on that display.
- **Pop-out rooms:** `auxMonitorRoom` gives EVERY pop-out its own signaling room, including
  monitor 0 (`code~m0`). The bare code is reserved for the primary session — mapping any
  pop-out onto it drops a second host+guest pair into the primary room, and the server's
  same-role eviction then makes both sessions kick each other in an endless
  connect→evict→reconnect loop (both tabs flashing the screen for a second, forever).
- **`replaced` = stand down (newest wins):** the signaling server sends `{"type":"replaced"}`
  to a peer it evicts for a newer same-role join. A LIVE recipient must not auto-reconnect
  (that evicts the newcomer back → the same ping-pong): the guest (`cloud.ts`) latches
  `denied` and shows "Taken over by another tab or device"; the host (`rtcHost.ts`) sets
  `hostReplaced` and stops signaling retries. Own-reconnect deliveries are filtered by
  socket-identity guards (`sig !== mySig`), so this only fires for genuine second tabs/apps.
- **Aux hosts skip the capture-stall watchdog + capstats:** `remote_capture_stats` reports
  only the PRIMARY pipeline (aux pipelines don't write `ST_*`), so an aux host reading it
  would misdiagnose a stall and call `remoteStopCapture()` — killing the primary session's
  screen from a pop-out tab every 5s. Both blocks are gated on `opts.fixedMonitor == null`.
- **Remote audio is an AudioWorklet (`src/lib/audioFeeder.worklet.js`), not a
  ScriptProcessorNode.** ScriptProcessor callbacks run on the MAIN thread, so game/webview
  load starved them → crackling during gameplay (YouTube-only was fine because the machine
  was idle). The worklet runs on the real-time audio thread: jitter buffer + drift-adaptive
  linear resampler + slew-limited gain live there (no per-frame allocs); the main thread only
  forwards PCM chunks (`port.postMessage`, transferred). Its TARGET grows +40ms per underrun
  (bursty IPC delivery under load) up to 250ms and eases back after ~10s clean. The module is
  bundled via Vite `?url` import — CSP `default-src 'self'` blocks `blob:`/`data:` modules.
- **WASAPI capture thread registers with MMCSS** (`AvSetMmThreadCharacteristicsW("Pro Audio")`,
  `audio.rs`) so a running game can't starve the loopback loop. Best-effort, don't remove.

**v3.9.12 streaming-latency pass (do not regress):**
- **No RGB conversion pass on the video-track path (`capture.rs`).** Frames stay packed
  4-byte from capture to JPEG: `scale_u8x4` downscales U8x4→U8x4 and `encode_frame`/
  `encode_jpeg_px` feed **BGRA (DXGI) / RGBA (xcap) directly to `jpeg-encoder`**
  (`ColorType::Bgra`/`Rgba` — it drops alpha in its own per-MCU transform). The old
  `u8x4_to_rgb` scalar pass read+wrote every pixel and allocated a fresh full-frame Vec
  per frame; don't reintroduce it on the hot path. `RawFrame` carries `color`; the LAN
  `TileEncoder` still uses `scale_u8x4_to_rgb` (it needs `RgbImage` for tile diffs).
- **Capture + encoder threads register with MMCSS** (`boost_capture_thread()`, task class
  "Capture") — primary capture, primary encoder, and every aux pop-out thread — so a
  running game can't starve the screen pipeline (same fix as audio's "Pro Audio").
- **Pointer moves ride a lossy WebRTC channel.** The host creates a third data channel
  `"move"` (`ordered:false, maxRetransmits:0`, same `onControlMsg` handler + auth gate);
  the guest (`links.ts makeRtcLink`) routes absolute `move` messages there so a dropped
  move is never retransmitted (the next one supersedes it) and a burst can't head-of-line
  block clicks/keys on the ordered control stream. **Anchor invariant:** before any
  `click`/`down`/`up` the guest re-sends the last lossy move on the RELIABLE control
  channel — same-stream ordering guarantees button events never land on a stale cursor.
  Only absolute moves may use the lossy path (`moverel` would double-apply if anchored).
- **Receiver jitter buffer: lean ~40ms target** (`cloud.ts`). Windowed drop-ratio
  adaptation only — **never grow off freezeCount** (Chromium's ~1Hz IDR hitch
  increments freezes even at 258ms dwell). Cap 120ms on real drops; snap back to
  40ms when clean. Phone lag ≈ RTT/2 + buffer + decode — buffer was the 281ms
  culprit when freeze-driven growth bloated it.
- **Quality settings persist** on the phone (`gt.remote.streamQ`, `gt.remote.contentMode`
  in localStorage) — a tuned setup survives app restarts. Default sharpness 72
  (WebRTC re-encodes; q=100 wasted IPC on ~400KB JPEGs). Host clamps intermediate
  JPEG to ≤72 regardless of the slider.

**v3.9.13+ streaming/latency pass 2 (do not regress):**
- **`RemoteLink.send` returns a delivery boolean** (true = handed to an OPEN channel;
  `cloud.ts sendControl/sendMove` and the LAN WS link report it). Input-tied haptics key
  off it: all touch right-click paths in `Control.tsx` go through `sendRightClick()`,
  which vibrates ONLY when the click actually reached the PC — never on a dropped send
  during a reconnect blip.
- **Latency in the phone HUD.** `CloudConn.videoStats` also samples the nominated
  candidate-pair `currentRoundTripTime` plus cumulative `jitterBufferDelay/
  jitterBufferEmittedCount` and `totalDecodeTime`; Control computes windowed per-frame
  averages and shows "Latency (est.) ≈ rtt/2 + buffer + decode" with the breakdown row.
- **Display fps counts `presentedFrames` metadata, not rVFC callback invocations.**
  Under main-thread load the browser skips `requestVideoFrameCallback` callbacks while
  the compositor keeps presenting — counting invocations under-reported display fps
  (the fake "decode 56 / display 32" gap). The cumulative `presentedFrames` delta
  credits skipped callbacks (catch-up capped at 8 so tab-resume jumps can't spike it).
- **View-state commits are rAF-coalesced (`commitView`).** Refs stay the source of
  truth on the gesture hot path; React state (zoom/pan/cursor) now updates at most once
  per animation frame instead of once per 90–120Hz pointer event — a full ControlScreen
  re-render per touch move was starving the phone's compositor exactly while dragging.
- **Adaptive jitter-buffer floor** (cloud.ts): fixed lean target **40ms**. Grows
  only on >15% windowed drops (cap 120ms); eases back in 20ms steps. Freezes are
  HUD-only — do not inflate the buffer off them. Never 0.
- **Capture threads hold a `TimerBoost` RAII guard** (`capture.rs`,
  `timeBeginPeriod(1)`/`timeEndPeriod(1)`, needs the `Win32_Media` windows feature):
  Windows sleeps quantize to the ~15.6ms system tick, so the fps-pacing sleeps overshot
  and 40fps targets really ran ~30fps. Boosted only while a stream is running (primary
  capture + every aux pop-out thread).
- **Pointer moves send IMMEDIATELY, not on the next rAF** (`queueMove`, Control.tsx).
  Browser pointermove events are already vsync-aligned, so queuing each move for the
  NEXT requestAnimationFrame added a whole extra display frame (8–16ms) of input
  latency. Moves now go out the moment they're computed, rate-limited to ≥4ms apart
  with a trailing rAF flush for same-frame bursts — don't re-add the always-rAF queue.
- **Host munges the guest's answer with `x-google-start-bitrate=4000`**
  (`boostStartBitrate` in rtcHost.ts, applied at setRemoteDescription): skips
  Chromium's ~300kbps cold-start BWE ramp so the first seconds aren't blurry. RTX
  (`apt=`) fmtp lines are skipped; any parse failure falls back to the untouched SDP;
  newer Chromium may ignore the hint (harmless — BWE converges on its own).
- **Decode-stall self-heal ("raised resolution → frozen stream" fix).** A mid-stream
  resolution INCREASE can wedge the phone's hardware H.264 decoder: bytes keep
  arriving but `framesDecoded` stops, and no quality change recovers it — only a new
  decoder. The guest watchdog (`cloud.ts`) detects it behind a strict gate —
  `sinkActive` (Control screen mounted, via `RemoteLink.noteVideoSink` →
  `CloudConn.setVideoSink`) + page visible + >30KB/3s inbound + 0 decoded — and heals
  in two stages: at 2 ticks (~6s) it sends `{type:"vreset"}` (host rebuilds its
  encoder/track in place via `rebuildVideoPipeline`, rate-limited 4s, fixes host-side
  wedges); at 4 ticks (~12s) it rebuilds the whole peer session (fresh receiver +
  decoder — what a manual reconnect did). The sink gate exists because the old
  blanket decode-stall reconnect false-fired whenever the video wasn't rendered
  (Stats tab) — do NOT remove it. Quest is excluded (immersive sessions consume the
  video off-DOM; visibility semantics differ).
- **Soft keyboard + dock coexist (Android).** Dock tabs, panel `IcoBtn`s,
  `KeyCapButton`/`PinnedButton`, and the compose-row mode/Send buttons all
  `preventDefault()` on pointerdown so a tap never steals focus from the ghost input
  — the keyboard stays up while panels open/keys fire (previously the blur collapsed
  the keyboard and the reflow swallowed the tap). The ghost-input `onFocus` no longer
  force-closes an open panel. The compose bar mirrors the typed text live
  (`composeText`, tail-truncated via `direction:rtl` + `unicode-bidi:plaintext`);
  the collapsed-top/immersive chip cluster has NO keyboard toggle — the bottom-left
  FAB (immersive/collapsed dock) and the dock's Keyboard tab are the only two.

**v3.9.14+ periodic ~1s video hitch fix (do not regress):**
- **Symptom:** input (data channel) stays butter-smooth while video is smooth → micro-
  hitch → smooth on a ~1 Hz cadence. Classic Chromium HW-H.264 publisher behavior at
  ≥720p ([Flashphoner keyframe notes](https://docs.flashphoner.com/static/WCS53/Streaming_video_functions/Stream_capturing_and_publishing_to_the_server/Key_frames_management_while_capturing_WebRTC_in_browser/) —
  IDR every 1s; browsers don't expose a keyframe-interval knob —
  [discuss-webrtc](https://groups.google.com/g/discuss-webrtc/c/Uv8COw8eJCM)). Compounded
  by irregular `VideoFrame` timestamps (JPEG decode latency) and an aggressive
  jitter-buffer ease that sawtoothed around each IDR.
- **Host (`rtcHost.ts`):** pace `MediaStreamTrackGenerator` timestamps to `1/fps` with
  an explicit `duration` (resync only after a multi-frame stall); apply `maxBitrate` at
  **1.4×** the steady-state estimate so IDR spikes clear the RTP pacer instead of
  queueing a hitch. Browser APIs cannot lengthen Chromium's IDR period — don't try
  PLI loops (that *increases* keyframes).
- **Guest (`cloud.ts`):** jitter target **40ms** (cap 120 on real drops only). Watch
  `freezeCount` for the HUD — do **not** grow the buffer off freezes (that produced
  the 258ms buffer / 281ms lag while freezes kept climbing). Dense Stream stats HUD
  shows phone + host RTC counters (JB target, NACK/PLI/FIR, IDR↑/↓, QP, JPEG q,
  send fps) in a 2-col grid. Intermediate JPEG for the WebRTC canvas path is capped
  at q72 (`jpegForRtc`) so ~400KB frames stop burning host IPC/CPU.
  Forcing `jitterBufferTarget` to 0 (Selkies anti-pattern) reintroduces stutter —
  never do that ([selkies#157](https://github.com/selkies-project/selkies/issues/157),
  [MDN jitterBufferTarget](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget)).

**v3.9.18 direct-video path (WebCodecs over data channel) + auto-PiP + audio memory (do
not regress):**
- **The WebRTC jitter buffer was the unfixable ~170-260ms.** `jitterBufferTarget` is a
  *minimum* only; Chromium's own delay estimator (fed by the bursty JPEG→canvas arrival
  cadence) pinned playout far above the 40ms ask (`UA min 172ms` in the HUD) and no
  receiver hint can push below it. Fix: **bypass the buffer entirely.** The guest opts in
  with `{type:"vmode",mode:"wc"}` after auth-ok when `VideoDecoder` is available; the host
  then stops feeding the `MediaStreamTrackGenerator` track and instead encodes each
  composited canvas frame with **WebCodecs `VideoEncoder`** (H.264 annexb, `latencyMode:
  "realtime"`, long GOP — keyframes only every 10s/on-demand, so no ~1Hz IDR hitch) and
  ships it over a 4th reliable+ordered data channel **"video"** (20-byte header
  `'G''V' flags seq u32 tsMs f64 len u32` + ≤60KB fragments). The guest decodes with
  `VideoDecoder` (`optimizeForLatency`) and paints straight onto the Control canvas —
  no RTP, no playout delay, no compositor sampling. Measured e2e is clock-synced via the
  heartbeat (`pong` now carries host `performance.now()`; lowest-RTT-of-8 midpoint).
- **  Fallback is automatic and layered:** WebRTC track stays negotiated; guest reverts
  (`vmode rtc`) on probe failure, opt-in timeout (6s), repeated decoder errors, or flow
  stall (watchdog vkf at ~6s, revert at ~12s); host reverts on encoder failure and pushes
  `{event:"vmode",mode:"rtc"}`. **Immersive VR stays on the RTC track** (WebGL textures
  the `<video>` element; the wc canvas path would leave VR black). Flat Quest Control,
  discovery web, and the APK all opt into WebCodecs when `VideoDecoder` works —
  `isImmersiveActive()` (not blanket `isQuestBrowser`) is the only Quest gate. Entering
  VR forces `wcFallback`; leaving VR re-opts in. Decode-stall self-heal uses the same
  gate. Host encoder-stall watchdog is gated on `!wcSink` (0 RTP fps is HEALTHY in wc mode).
  Latest-wins everywhere: frames are skipped when `videoCh.bufferedAmount > 256KB` or
  `encodeQueueSize > 2` — a backlog can only become latency.

**v3.9.24 DIRECT is sticky, RTC is a waiting room (do not regress):**
- **No fallback may latch DIRECT off for the session.** Every revert used to set
  `wcSupported = false` / host `wcDead = true`, so ONE transient stall stranded the
  session on RTC's jitter buffer — the whole thing the path exists to avoid — until
  the user refreshed the page or restarted the app. Now `wcSupported` means **device
  capability only** (no usable `VideoDecoder`; never set it for a runtime fault), and
  soft failures arm `wcRetryAt` with a 15s→120s backoff that the watchdog re-attempts
  via `wcEligible()`. A clean stretch on DIRECT resets the backoff.
- **`{event:"vmode",mode:"rtc"}` now carries `permanent`.** True only when the host has
  no `VideoEncoder` / no codec on the ladder → guest sets `wcHostRefused` (cleared on
  the next peer session). Transient host faults (encoder error, configure rejected at
  a given size) send `permanent:false`, count toward `wcErrors`, and only go `wcDead`
  after >3 — so lowering Res can revive DIRECT. Pre-3.9.24 hosts send no flag; the
  guest treats that as retryable (backoff caps the cost of asking a hopeless host).
- **Guest probes the SAME codec ladder as the host** (`WC_CODECS`, High→Main→Baseline).
  It used to probe only `avc1.640034`, so any device topping out at Main/Baseline fell
  back to RTC permanently.
- **Leaving VR re-opts in.** `wcFallback(reason, hard=true)` blocks retries while
  immersive; the exit path must clear `wcRetryAt` or flat Quest stays on RTC.
- **"Feel" slider (Quality dock, `tune.pace` 0–100, default 0 = responsiveness).**
  VIDEO ONLY — input latency must never key off it. 0 is byte-for-byte the shipped
  behavior (paint on decode, JB base 40). Above 0 it buys even cadence with delay:
  guest holds each decoded frame to `capturedAtGuest + EWMA(e2e) + pace*0.6ms` (a
  CONSTANT offset off the clock-synced host capture time — pacing off *arrival* time
  just re-prints the jitter), capped at 150ms wait / 6 queued frames; `pace*0.6` also
  lifts the RTC jitter-buffer floor, and the host widens its latest-wins thresholds
  (`bufferedAmount` ×(1+pace), `encodeQueueSize` 2→4). `wcE2eMs` is measured BEFORE
  pacing — folding our own delay back in would ratchet the target upward.
- **Tune panel is self-documenting.** Every row carries a `hint` (what it does + which
  way to drag) and a `ScopeTag` (`host`/`direct`/`rtc`/`both`) — several knobs are
  no-ops on the live path (JB rows do nothing on DIRECT; Send/Enc-max do nothing when
  DIRECT is up), which was invisible before. `TuneSection` groups them. The "Info"
  toggle folds hints away; new rows MUST ship a hint + scope.
- **Formerly-hardcoded knobs now in Tune:** `wcKeyMs` (host DIRECT keyframe cadence,
  was `WC_KEY_INTERVAL_MS`), `wcBufKB` + `wcQueueMax` (host latest-wins bases, which
  `pace` then scales), `jbGrowAt` (guest RTC drop ratio that grows the JB, was a bare
  `0.15`), `directRetrySec` (DIRECT retry backoff floor). Host knobs ride the existing
  `quality` message; guest knobs go through `applyStreamTune`.
- **Dock clears curved screen edges.** The bottom bar carries
  `paddingLeft/Right: max(0.75rem, env(safe-area-inset-left/right))` — Android reports
  a **0 inset for a curved edge** (only cutouts are reported), so a bare `env()` fixes
  nothing and the `max()` floor does the real work. Tab strip trimmed to match
  (`h-9`→`h-8`, icons `h-5`→`h-4`, `py-1.5`→`py-1`, own `px-1.5` dropped since the
  container now owns edge spacing) so Mouse and Disconnect stay off the bend.
- **Auto-PiP: `onUserLeaveHint` is NO LONGER gated to pre-S** (`patch-android.mjs`).
  Relying on `setAutoEnterEnabled` alone on Android 12+ left devices where auto-enter
  silently no-ops (b/245392106) with **no PiP at all and no fallback** — the reported
  "auto pip is not working". The leave-hint path now runs on every API ≥ O, guarded by
  `isInPictureInPictureMode` so it's a no-op when auto-enter did fire. Google's wording
  is you "don't need to" call it under auto-enter, not that you must not. Also added:
  `setSourceRectHint` (without it the shrink is a cross-fade, not the seamless
  YouTube move), a `FEATURE_PICTURE_IN_PICTURE` check, and an `onResume` re-arm (the
  OS reads the LAST params snapshot when the user leaves — a stale one set at
  `onCreate`, before the session went live, is a documented way to get a silent no-op).
- **minSdk is 24, so every PiP call site needs an INLINE `SDK_INT` guard.** PiP APIs
  are 26. Do NOT fold the version check into a helper like `hasPipFeature()` — lint's
  `NewApi` can't see through a function boundary and `lintVitalRelease` fails the APK
  build. `pipParams()` carries `@RequiresApi(O)`; each caller checks `SDK_INT` itself.
- **Web PiP: what is and isn't possible on Chrome Android** (researched — don't
  re-litigate from memory, the folklore here is wrong in both directions):
  - **MediaStream-backed video CAN be PiP'd** — `getUserMedia`/`getDisplayMedia`/
    **`canvas.captureStream()`** have been supported since **Chrome 71**, and the
    `<video>` need not be in the DOM. Verified locally: `captureStream(0)` → `<video>`
    → `requestPictureInPicture()` resolves and `pictureInPictureElement` is set. Any
    claim that "PiP only works for plain `<video src>`, not WebRTC" is FALSE.
  - **Site-initiated auto-PiP does NOT exist on Android.** The Media Session
    `enterpictureinpicture` action is **desktop-Chrome only** (Chrome 134+), and even
    there needs audible-within-2s + audio focus + an MEI threshold — and Chrome 142's
    *browser*-initiated Auto PiP explicitly excludes players "using `MediaStream`",
    which is exactly us. Chrome-for-Android's automatic PiP (flag, late 2025) is an
    **in-browser mini-player on tab switch**, not system PiP on app-switch.
  - **What Android Chrome does do:** caniuse note #8 — "Automatically plays fullscreen
    videos in Picture-in-Picture mode after user hits Home Screen button." That's the
    behaviour people see on other sites; it needs the `<video>` **fullscreen**.
  - **So:** web gets a **tap-to-PiP** button (`pipSupported` = `pictureInPictureEnabled`
    && !isTauri). Once the mini window is open it survives leaving the browser, which
    gets the same end result as auto-PiP for one tap. DIRECT paints a canvas so it has
    no `<video>`; `pipSourceVideo()` mints one from `canvas.captureStream(0)` on first
    use (RTC just reuses `videoRef`). Fully automatic PiP on app-switch stays
    **APK-only** via the Android shell.
- **Stats HUD has a verbose mode** (Info button in its header, off by default).
  `STAT_INFO` maps every short label → `{ long, info }`, delivered via
  `StatVerboseCtx` so the ~44 `StatCell` call sites stay untouched; verbose cells
  `col-span-2` and the panel widens + scrolls. **A key missing from `STAT_INFO`
  silently falls back to the terse cell** — keep it 1:1 with the rendered labels.
- **Client parity (APK ≈ web ≈ Quest flat):** all three mount the same `CompanionApp` /
  `Control` / `cloud.ts`. `serve.ps1` rebuilds `signaling/static` when companion/quest/
  lib sources are newer than the published HTML (not only when files are missing).
  ImmersiveScreen plays PC sound via `onAudioStream` + a Volume toggle (Control mutes
  while VR is up). Web/Quest Settings show About + Open release page (install stays APK).
  Streaming opts (WebCodecs, JB 40, A/V split, lossy move, stall-heal, host bitrate/JPEG)
  are **not** Tauri-gated — discovery web gets the same path. Control also takes a
  **Screen Wake Lock** while live so Chrome Android doesn't dim/throttle mid-stream.
  Stream stats HUD has a collapsible **Tune** panel (res/JPEG/fps/bitrate/headroom/min/
  start bitrate/JB base·min·max/content/direct) persisted in `gt.remote.streamTune`,
  with **Reset to defaults**; stalled connect UI + `forceRebuild` also wipe tune back
  to the soft spot so a bad experiment can't wedge pairing.
- **Control chrome + Game keys (v3.9.22):** pinnable **Hold** (momentary LMB for drag-select),
  Game dock (WASD+/extras), free-place animated pins with per-pin editor
  (`controlChrome.ts` / `PinEditorSheet`). Shared APK/web/Quest flat. Pin editor draft is
  frozen at open (no prop re-sync) so sliders/chips don't reset on Control re-renders.
  Toolbar scale chips on every dock tab cycle **25%–1000%**; screen zoom **0.25×–10×**.
  Zoom popover is `position:fixed` (toolbar `overflow-x-auto` was clipping the vertical
  slider) with a rotated range input for Android/WebView reliability (v3.9.23).
- **Quest WebXR layers fix (v3.9.22):** when `layers` is granted, set
  `renderState.layers = [XRWebGLLayer]` (not `baseLayer`) or Enter VR throws
  `Can't use baseLayer with layers feature requested`.
- **HUD:** header shows the transport (`DIRECT`/`RTC`/`LAN`); wc mode swaps the top grid
  for measured stats (E2E, net+enc, decode ms, dec queue, frame KB, clock ±) and the host
  section gains H264 enc ms / skipped / channel buf. The lag pill uses the measured E2E.
- **Android auto-PiP:** `MainActivity.setPipWanted(bool)` (JNI static method; field-set
  fallback for old builds) arms `setAutoEnterEnabled` on Android 12+ — the OS runs the
  seamless YouTube-style shrink on home gesture/app-switch; 8–11 keep `onUserLeaveHint`
  (gated `< S` so S+ can't double-trigger). Control detects the tiny PiP window
  (`innerWidth ≤ 550 && innerHeight ≤ 350`) and hides ALL chrome — pure video.
  Backgrounded-without-PiP guests skip decoding (delta frames dropped, resync by
  keyframe on return) to save battery.
- **PC sound remembers its state** (`gt.remote.soundOn`): restored on connect by
  attempting an unmuted `play()`; if the platform still demands a gesture the toggle
  falls back to off so one tap restores it.
- **Auth handshake is IDEMPOTENT + deadlined (cold-start wedge fix).** The guest's
  single `{type:"auth"}` (or the host's `auth ok`) could be lost around channel-open,
  and the watchdog counts a connected transport as healthy — so the phone sat in
  "Device authorization" forever until an app restart. Now: the guest RE-SENDS auth
  every watchdog tick while `transportUp && !authed && authState !== "pending"` and
  force-rebuilds after 15s unanswered (`AUTH_STALL_MS`); the host re-acks `ok` for an
  already-authorized session and guards duplicate asks with `authBusy` (re-states
  `pending`, never stacks a second approval prompt — the superseded-prompt rules stay
  intact). A genuine PC-side approval prompt (`authState === "pending"`) is exempt
  from all deadlines. Also: `negotiating` stuck >20s (ICE limbo after glare with a
  zombie session) force-rebuilds, and the 60s hard reset drops to **25s before the
  first-ever connect** (`HARD_RESET_FIRST_MS`). `forceRebuild()` bypasses the
  `connecting` guard + backoff.
- **Connection diagnostics:** `ConnectSnapshot.detail` (`ConnectDetail`) carries the
  real per-layer states — signaling socket, pc/ICE/gathering/SDP, per-channel
  readyStates, offers/candidates counts, auth state (`none/sent/pending/ok/denied` +
  ask count + age), permanent-key presence, sid, last event. `ConnectionProgress`
  shows a live sub-line under the ACTIVE step, plus a collapsible Diagnostics panel
  that auto-expands when a stage stalls >6s (compact overlay gets a one-liner). A 1s
  progress ticker in `CloudConn` keeps it live while connecting.

**v3.9.16+ A/V-sync buffer lag (do not regress):**
- **Symptom:** JB target shows 40ms but measured buffer stays ~200ms; decode fps
  far below host produce; bitrate can collapse (~200kbps). Chromium implements
  jitterBufferTarget as a *minimum* only ([webrtc-extensions#199](https://github.com/w3c/webrtc-extensions/issues/199)).
- **Root cause:** guest merged host audio+video into one MediaStream for
  <video>, re-enabling lip-sync — video is delayed to the audio NetEq buffer
  ([discuss-webrtc A/V sync latency](https://groups.google.com/g/discuss-webrtc/c/ZvAHvkHsb0E)).
  Host already sends separate streams; guest must keep them separate.
- **Fix:** onStream = video only; onAudioStream + hidden <audio> for PC
  sound; video element stays muted forever. Re-assert JB hint every 250ms.
  Host SDP x-google-min-bitrate + encoding minBitrate floor so GCC cannot
  crush the share to ~200kbps.

**v3.9.27 native NVENC encode — the host stops shipping JPEG (do not regress):**
- **What the numbers actually said.** The DIRECT path measured ~35ms "H264 enc" and
  ~30ms phone decode. But at **2×2 pixels / 1kbit/s they were still 27.5ms and
  30.2ms** — four pixels cannot cost 27ms to encode, so neither number was ever
  *work*. ~55ms of the 93ms E2E was **fixed pipeline overhead**, which is why no
  quality/bitrate/fps knob ever moved it. Don't tune this; the dials aren't connected
  to it.
- **Host encode: the round trip was the cost.** The old path was DXGI texture → GPU
  downscale → **CPU readback** → JPEG (334KB) → **IPC** → `createImageBitmap` →
  canvas → `VideoFrame(canvas)` → **back into the GPU process** → MediaFoundation
  H.264. Pixels crossed the GPU/CPU boundary four times and were compressed twice.
  Now: duplication texture → NVENC on the same D3D11 device → ~30KB Annex-B → IPC →
  data channel. Measured **1.2ms median at 1080p** on an RTX 4070 Ti (`nvenc_smoke`).
- **Phone decode: we never controlled the SPS.** Chromium's WebCodecs encoder emitted
  a stock SPS; Android decoders read `pic_order_cnt_type=0` as "reordering is
  *possible*" and buffer a frame ahead ([ExoPlayer#8514]), and NVENC's default
  `max_num_ref_frames=16` makes some allocate 16+ buffers (Moonlight
  decoder-errata #1/#2). Our NVENC config (`frameIntervalP=1`, no B-frames,
  `zeroReorderDelay`) makes it emit **`poc_type=2`** — reordering *impossible*, so
  that slow path is never armed — plus refs=1/reorder=0/dpb=1. `nvenc/sps.rs` rewrites
  the SPS to force those three regardless; it's a **guarantee, not the mechanism**, and
  a parse failure ships the encoder's SPS untouched.
- **`nvenc/ffi.rs` is hand-written and ABI-asserted.** The crates (`nvidia-video-codec-sdk`,
  `nvenc`) need the SDK installed + cudarc; we load `nvEncodeAPI64.dll` (ships with the
  driver) so the build stays turnkey. **Targets API 12.0 on purpose:** NVENC is
  *backward* compatible, so an older API reaches more drivers — and this dev box caps
  at 13.0, so binding 13.1 disabled NVENC on the machine it was written for. Layouts
  differ between versions (`NV_ENC_INITIALIZE_PARAMS` 1808 @12.0 vs 1800 @13.1), so
  **version and layouts move together, never one alone.** Every size/offset is asserted
  against machine-generated ground truth from `scripts/nvenc-abi-probe.c` — re-run it
  if you touch a struct. This is not ceremony: it already caught `Option<*mut c_void>`
  having no null-pointer optimisation (every function-table slot 16 bytes → silently
  misaligned → corruption *inside the display driver*), and `FORCEIDR` being 2, not 1.
- **Zero-copy (`gpu.rs`) removes the readback too.** One full-screen pass samples the
  duplication texture (sampler does the downscale, trilinear off `grab_gpu`'s mip
  chain) **and composites the cursor in the same fetch**. Cursor compositing has to be
  in-shader because Desktop Duplication delivers the pointer as metadata, and because
  masked/monochrome cursors **XOR the screen** — blend state cannot express that, the
  shader must read the screen value. **Monochrome maps exactly onto masked-colour**
  (`and=1,xor=0` → XOR black = no-op; `and=1,xor=1` → XOR white = invert), so the 1bpp
  AND/XOR unpack stays on the CPU, runs once per *shape change*, and the shader has two
  branches instead of three. Shaders compile at runtime via `D3DCompile`
  (`d3dcompiler_47.dll` ships with Windows — no build dep). `dxdupe::draw_cursor` and
  `dxdupe::cursor_image` must stay in step.
- **Layered fallback, all deliberate — do not collapse it.** zero-copy → readback+upload
  (`native.rs::encode_pixels`) → JPEG+WebCodecs. Any failure at any layer drops one
  level and **stays retryable**; nothing latches off for the session (same rule as
  v3.9.24's "DIRECT is sticky").
- **`CAP_NATIVE_OK` defaults OFF and resets in `start_capture`.** Only a DIRECT guest
  can take pre-encoded H.264 — **the RTC track composites a canvas and would go black**.
  The host enables it on wc opt-in and disables it on every fallback to RTC. The webview
  still builds its WebCodecs encoder underneath as a live net for a mid-session NVENC
  fault. Missing WebCodecs is no longer fatal to DIRECT when NVENC is up.
- **Only the BGRA (Desktop Duplication) source qualifies.** The xcap fallback is RGBA;
  swizzling per-pixel would reintroduce exactly the cost this removes.
- **Infinite GOP ⇒ a fresh decoder needs an IDR.** `vkf`/`vreset`/DIRECT opt-in all call
  `remote_request_keyframe`. Without it the guest stares at nothing until the interval.
- **HUD:** NVENC badge beside the DIRECT pill; "H264 enc" reports real NVENC time and
  flags >5ms native (vs >15ms on the JPEG path); capture stats carry `native` +
  `zeroCopy`. Hardware tests are `#[ignore]`d (`-- --ignored`) so CI and non-NVIDIA
  machines don't fail: `remote::nvenc::tests::nvenc_smoke`,
  `remote::gpu::tests::composites_scale_and_every_cursor_op`.
- **One NVENC session only (`ST_ZC_LIVE`).** A `grab_gpu` Timeout must NOT fall through
  to the CPU mailbox — that started a second NVENC session on the encoder thread whose
  reference chain is unrelated to the zero-copy one. Interleaving them made the picture
  glitch with static patches that never refreshed. While zero-copy owns the stream,
  keep-alives re-encode the last composited texture from the *same* session; the
  upload-path encoder stands down behind `ST_ZC_LIVE`.
- **Announce a codec string before the first native frame.** The guest builds its
  `VideoDecoder` from a JSON `{codec}` on the video channel. The canvas/WebCodecs path
  announced during configure; the NVENC path never paints the canvas, so without an
  explicit announce the phone dropped every Annex-B frame and sat on "Waking your
  screen…" until the 6s opt-in watchdog fell back to RTC. `wcActivate` + the first
  GN frame both announce; `wcTeardown` must NOT null `nativeSink` (a DIRECT retry
  only flips `CAP_NATIVE_OK`).
- **Decode latency: Constrained Baseline + CAVLC + multi-slice.** High+CABAC left
  some Android HW decoders out of low-latency mode (Moonlight errata #8 — "B-frames
  might be present"). NVENC now ships Constrained Baseline / CAVLC, forces
  `constraint_set1` in the SPS rewriter, and uses `sliceMode=3` (~1 slice / 540 px)
  so the phone can parallelise decode. Guest `VideoDecoder.configure` sets
  `optimizeForLatency`, `avc: { format: "annexb" }`, and `codedWidth/Height` from
  the host announce. WebCodecs still cannot pick MediaCodec's
  `FEATURE_LowLatency` decoder variant or vendor keys (Parsec/Moonlight native
  path) — that needs a native Android bridge if Baseline+slices aren't enough.

[ExoPlayer#8514]: https://github.com/google/ExoPlayer/issues/8514

**v3.9.26 Remote-only vs Full install mode (do not regress):**
- **UI-only gating.** Installer always lays down every file; the setup-type choice
  only seeds `remote_only` in the DB. Tracking, media logging, and the system
  monitor keep running so flipping back to Full leaves no gap in history.
- **Single source of truth = PC Settings.** Toggle lives under Settings → Setup
  type (`remote_only`). Phone / discovery web / Quest only *mirror* it via
  `/api/settings` (15s poll in `CompanionApp`) — they cannot change it.
- **Installer → marker → seed.** NSIS page radios write `$INSTDIR\install-mode.txt`
  (`full` / `remote`) in `NSIS_HOOK_POSTINSTALL`. Silent/passive updates leave the
  state empty and write nothing (so a Settings flip isn't clobbered by auto-update).
  `seed_install_mode` / `apply_install_mode` in `lib.rs` adopt the marker only when
  it differs from `install_mode_seen`. **Do not** re-apply every launch.
- **Shared policy:** `src/lib/setupMode.ts` (`routeAllowed` / `tabAllowed` /
  `readRemoteOnly`). Desktop: Sidebar filter + App route guard bounce to `/remote`.
  Companion: tab strip + Control "Go to…" menu. Settings hides tracker-only sections
  while remote-only is on (dashboard / tracking / screenshots / launchers).
- **ToolbarScaleChip portals to `document.body`.** The dock is a Framer
  `motion.div` (transform containing block); in-tree `position:fixed` made the
  vertical scale slider invisible on web. Keep the portal.
- **Curved-edge dock padding** uses `max(1.25rem, env(safe-area-inset-*))` on the
  Control bottom bar and the companion tab strip — Android reports 0 for curves.

