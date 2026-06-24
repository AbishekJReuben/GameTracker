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
- **Tauri** builds stay tiny (our installer is **2.7 MB**; Electron would be ~100 MB), launch fast,
  and have first-class **tray + autostart + single-instance** plugins — ideal for a background
  utility. Rust gives us direct Win32 access for process/idle tracking.
- **Web frontend** unlocks the best modern UI/animation ecosystem (the reason we can hit "premium").

Frontend libraries chosen (and why):
- **React 18 + TypeScript + Vite** — fast, familiar, great DX.
- **Tailwind CSS** — design-token-driven styling; our tokens live in `tailwind.config.js`.
- **Framer Motion** — route transitions, `AnimatePresence`, layout animations, micro-interactions.
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
