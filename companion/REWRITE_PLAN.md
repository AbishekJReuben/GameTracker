# GameTracker Companion — Full Rewrite Plan (mirror the Windows app)

> **Purpose of this document.** This is a self-contained brief for an LLM/engineer to
> rewrite the Android **companion** app so it mirrors the Windows desktop app *exactly*
> — every page, every animation, every component — **minus the tracking engine** (tracking
> only ever runs on Windows; the phone is a read-only mirror + remote control). It also
> specifies how to **overhaul the remote-control** experience.
>
> The companion is a **second Vite entry** in the **same repo** (`companion.html` →
> `src/companion/**`), packaged as a Tauri Android app under `companion/src-tauri/`. Because
> it lives in the same codebase, it can import the desktop's design system and components
> directly — the real work is (a) a data layer that reads from the PC over the network
> instead of Tauri `invoke`, (b) mobile layout/navigation, and (c) exposing all the data the
> pages need over the remote server.

---

## 0. Ground truth: how the app is built (read before planning)

- **Stack:** Tauri 2 + React 19 + TypeScript + Vite 7 + Tailwind CSS v4 + Motion (Framer) 12 +
  react-router-dom 7 + @tanstack/react-query 5 + zustand 5 + recharts. Design lives in
  `src/index.css` (~870 lines: CSS-variable tokens + utility classes + keyframes).
- **Desktop routes** (`src/App.tsx`): `/` Dashboard, `/library`, `/apps`, `/system`,
  `/game/:id` GameDetail, `/timeline`, `/music`, `/remote`, `/collection`, `/suggested`
  (opt-in), `/tags`, `/settings`.
- **Desktop nav** (`src/components/Sidebar.tsx`): Dashboard, Library, Apps, System, Timeline,
  Music, Remote, Collection, Suggested*, Tags, Settings + a live "now playing" HUD footer.
- **Design tokens** (`src/index.css`): `--accent-1/2/3` (dynamic accent), `--ink*`, `--bg*`,
  `--line` families; utility classes `.card`, `.hud-panel`, `.pill`, `.input`, `.btn`,
  `.btn-primary`, `.btn-ghost`, `.btn-subtle`, `.accent-text`; keyframes `gt-marquee`,
  `gt-marquee-y`, `gt-kenburns`, `gt-spotlight`, `gt-wave`, `animate-shimmer`,
  `animate-glow-pulse`, `animate-pulse-ring`, etc.
- **Shared component library** (`src/components/**`), highlights to reuse:
  - Primitives (`ui.tsx`): `Card`, `HudPanel`, `SectionTitle`, `Badge`, `StatusBadge`,
    `Segmented`, `Toggle`, `EmptyState`, `Skeleton`, `Spinner`.
  - Layout: `Page.tsx`, `Panel.tsx` (collapsible/persisted panels), `Topbar.tsx`, `TitleBar.tsx`,
    `Sidebar.tsx`.
  - Data viz: `Charts.tsx`, `Sparkline.tsx`, `RadialGauge.tsx`, `Heatmap.tsx`,
    `LibraryPlaytimeChart.tsx`, `StatTile.tsx`, `AnimatedNumber.tsx`.
  - Game UI: `GameArt.tsx`, `GameCard.tsx`, `LibraryViews.tsx`, `GameStatsPanel.tsx`,
    `GameScores.tsx`, `ScreenshotGallery.tsx`, `Captures.tsx`, `SteamAchievements.tsx`.
  - Music: `MusicWidgets.tsx`, `Playlists.tsx`, `NowPlaying.tsx`, `SoundtrackPanel.tsx`,
    `Timeline.tsx`, `ActivityLog.tsx`.
  - Motion/decoration: `MarqueeFX.tsx` (+ `CoverMarquee`, `VerticalCoverMarquee`,
    `ImageMarquee`, `AppsTodayMarquee`, `PanelArtBackdrop`), `animations/` (`AmbientShell`,
    `PageTransitionFX`, `MarqueeShader`, `ShaderImageTransition`, `LottieIdle`,
    `FloatingParticles`), `Reveal.tsx`, `AnimatedOutlet.tsx`.
- **Data layer today:** desktop pages call `src/lib/api.ts` (`call<T>()` → Tauri `invoke`) either
  directly or via react-query hooks in `src/lib/queries.ts`. **The phone has no `invoke`** — it
  must read over HTTP/WebRTC.
- **Remote server** (`src-tauri/src/remote/mod.rs`): embedded axum server on port **47800**,
  gated by `remote_enabled`. Already exposes: `/api/tracking`, `/api/dashboard`, `/api/apps`,
  `/api/games`, `/api/sessions`, `/api/heatmap`, `/api/music/{overview,top,insights,recent,timeline}`,
  plus `/pair`, `/media?path=`, `/screen` (JPEG WS), `/control` (input WS), `/ws` (live).
  Cloud path = WebRTC P2P via signaling at `wss://discovery.chilloutgamestudio.com` (see
  `signaling/`, `src/lib/rtc.ts`, `src/lib/rtcHost.ts`, `src/companion/cloud.ts`).
- **Current companion** (`src/companion/**`): `CompanionApp.tsx` (3-tab shell), `Pairing.tsx`
  (From-anywhere / Same-network), `screens/{Stats,MusicView,Control}.tsx`, `link.ts`/`links.ts`
  (transport dispatch), `useRemote.ts` (polling hook), reusing `src/lib/remoteClient.ts`.

**Scope of "without tracking":** the phone never runs the tracker. Exclude PC-only *operational*
features: game/app detection, CSV import, DB backup/restore, autostart, launcher (Steam/GOG) OAuth
sync, screenshot-capture settings, "audit/repair content". **Keep** everything that *displays*
tracked data (including live "now playing"), plus a curated set of **remote actions** (pause
tracking, launch a game, change a game's status, playback control) that are just RPCs to the PC.

---

## 1. Target: page-by-page parity

Mirror each desktop route as a mobile screen with the same content and visual language, adapting
multi-column layouts to a single scrolling column and the sidebar to a bottom tab bar + "more"
sheet. Table below = source page → what it shows → data needed → endpoint status.

| Mobile screen | Desktop source | Shows | Data (command → endpoint) | Endpoint status |
|---|---|---|---|---|
| **Dashboard** | `routes/Dashboard.tsx` | Hero now-playing, today/week stats, streak, top games, heatmap, recent sessions | `dashboard` → `/api/dashboard`; `tracking_state` → `/api/tracking`; `heatmap` → `/api/heatmap`; `list_sessions` → `/api/sessions` | ✅ exists |
| **Library** | `routes/Library.tsx` + `LibraryViews`, `GameCard`, `GameArt` | Grid/list of games, sort/filter/search, cover art, status badges, playtime | `list_games` → `/api/games`; `get_game_stats` per game | ⚠️ games ✅, stats ❌ |
| **Game detail** | `routes/GameDetail.tsx` | Cover/hero, playtime, sessions, screenshots, scores (Metacritic/Steam), achievements, OST, reviews, trailer | `get_game`, `get_game_stats`, `list_screenshots`, `steam_achievements_overview`, `fetch_steam_reviews`, `list_sessions?game_id` | ❌ add all |
| **Apps** | `routes/Apps.tsx` + `AppsTodayMarquee` | App usage overview, today reel, per-app time | `apps_overview` → `/api/apps` | ✅ exists |
| **System** | `routes/Systems.tsx` + `RadialGauge`, `Charts` | Live CPU/GPU/RAM/temps gauges, history sparklines, specs | `system_specs`, `system_live`, `system_history` | ❌ add (great on phone) |
| **Timeline** | `routes/Timeline.tsx` + `Timeline`, `ActivityLog`, `Heatmap` | Day/week timeline of game+app+media sessions, activity log, heatmap | `list_sessions`, `media_timeline`, `heatmap`, `hour_of_day` | ⚠️ partial |
| **Music** | `routes/Music.tsx` + `MusicWidgets`, `Playlists` | Overview, top tracks/artists, insights, recent plays, heatmap, playlists | `media_overview/top/insights/recent` ✅; `media_heatmap`, `media_hour_of_day`, `playlists_list`, `playlist_get` | ⚠️ add heatmap/hourofday/playlists |
| **Collection** | `routes/Collection.tsx` | Catalog analytics, completion, insights, achievements roll-up | `catalog_analytics`, `insights`, `steam/gog achievements_overview` | ❌ add |
| **Tags** | `routes/Tags.tsx` | Tag analytics, tag list, per-tag playtime | `tag_analytics`, `list_tags` | ❌ add |
| **Suggested*** | `routes/Suggested.tsx` | AI/heuristic game suggestions (online, heavy) | `suggest_games` | ❌ optional/proxy |
| **Remote/Control** | this app's `screens/Control.tsx` | Live screen + input (see §6) | `/screen`, `/control` or WebRTC | ✅ (to overhaul) |
| **Settings** | `routes/Settings.tsx` (subset) | Companion-local: theme/accent, motion/perf, connection mgmt, about. **Not** PC operational settings | local + `remote_status` | local |

`*` Suggested is opt-in on desktop; keep it behind a toggle here too.

---

## 2. Architecture decision (do this first)

**Reuse the desktop components; abstract the data source.** Two clean options — pick **A**:

- **A. Transport-pluggable data layer (recommended).** Introduce a single seam so the *same*
  page/components run on desktop (Tauri `invoke`) and phone (HTTP/WebRTC). Concretely:
  1. Make `src/lib/api.ts`'s `call<T>(cmd, args)` delegate to a **transport**. Default transport =
     Tauri `invoke`. On the companion bundle, register an **HTTP transport** that maps each command
     name → a REST endpoint (see §3 table) using `remoteClient.ts` (bearer token) or the WebRTC
     `data` channel when in cloud mode.
  2. Keep `src/lib/queries.ts` (react-query) unchanged — it already calls `api.*`, so both apps get
     caching, retries, and `useQuery` ergonomics for free.
  3. Guard PC-only commands: on the companion transport, unsupported commands reject with a typed
     "not available on companion" error; pages that need them are simply not built for mobile.
  - **Why:** maximal reuse, one source of truth for data fetching, pages/components differ only in
    *layout*, not *logic*.

- **B. Parallel companion pages.** Rebuild each screen under `src/companion/screens/**` that renders
  the shared sub-components but fetches via `remoteClient`. More duplication, more drift. Only choose
  if A's `invoke` refactor is deemed too invasive.

**Layout adaptation:** desktop uses fixed multi-column grids sized for ≥1100px. For mobile:
- Replace the **Sidebar** with a **bottom tab bar** (primary tabs: Dashboard, Library, Music,
  Control) + a **"More" sheet** (System, Timeline, Collection, Tags, Settings). Preserve the
  sidebar's animated active-pill (`layoutId="nav-active"`) idea using Motion `layoutId` on the tab bar.
- Wrap each page in a mobile `Page` shell (sticky header with title + the live now-playing chip).
- Convert `lg:grid-cols-*` panels to single-column; make `Panel` collapsible sections stack.
- Cards/tiles: full-width; horizontal scroll rails for "top games / top tracks / today apps"
  (reuse the marquee components as touch-scrollable rails).

---

## 3. Backend work — expose all read data over the remote server

Add HTTP GET handlers in `src-tauri/src/remote/mod.rs` mirroring the remaining read commands, reusing
the existing `blocking()` helper and `db::*`/subsystem functions (never block the async runtime).
Every new route goes under the **token-protected** router. Follow the existing endpoint style.

**New endpoints to add (name → backing fn):**

| Endpoint | Backing call | Notes |
|---|---|---|
| `GET /api/games/:id` | `games::get` | single game |
| `GET /api/games/:id/stats` | `stats`/cached game stats | for Library + GameDetail |
| `GET /api/games/:id/screenshots` | `list_screenshots` | GameDetail gallery (serve files via `/media`) |
| `GET /api/games/:id/achievements` | steam/gog achievements overview | GameDetail |
| `GET /api/catalog` | `catalog_analytics` | Collection |
| `GET /api/insights?year=&kind=` | `insights` | Collection |
| `GET /api/hourofday?kind=` | `hour_of_day` | Dashboard/Timeline |
| `GET /api/tags` | `tag_analytics` + `list_tags` | Tags |
| `GET /api/music/heatmap?days=` | `media_heatmap` | Music |
| `GET /api/music/hourofday` | `media_hour_of_day` | Music |
| `GET /api/playlists` | `playlists_list` | Music |
| `GET /api/playlists/:id` | `playlist_get` | Music |
| `GET /api/system/specs` | `system_specs` | System |
| `GET /api/system/live` | `system_live` | System (poll ~1–2s) |
| `GET /api/system/history?minutes=` | `system_history` | System sparklines |
| `GET /api/settings` | whitelist of display settings (accent, perfMode…) | so phone can inherit theme |

**Write/action endpoints (POST, token-protected):**

| Endpoint | Backing call | Purpose |
|---|---|---|
| `POST /api/tracking/pause` `{paused}` | `set_paused` | pause/resume tracking from phone |
| `POST /api/games/:id/launch` | `launch_game` | launch a game on the PC remotely |
| `POST /api/games/:id/status` `{status}` | `save_game`(status) | change status from phone |
| `POST /api/media/stop` | `stop_media_play` | stop current media play |
| `POST /api/playlists/:id/reorder` `{vids}` | `playlist_reorder` | manage playlists |

Also mirror all of the above into the **WebRTC `data` channel** router in `src/lib/rtcHost.ts`
(`handleData()` switch) so cloud mode has feature parity with LAN. Keep the request contract
identical (`{id, path}` → `{id, ok, data|error}`) and just extend the `path` switch to cover the new
routes. Consider replacing the hand-written switch with a small **path→handler table** shared by both
the axum router and the data-channel handler to avoid drift.

**Media/artwork:** GameDetail/Library rely on lots of images. Over LAN, `/media?path=` already
works. Over **cloud** the current code returns `null` for media URLs. Add one of: (a) a `media`
request type over the data channel that returns base64 for small images (covers/icons), or (b) a
dedicated binary sub-channel; cache aggressively on the phone. Covers are the priority; screenshots
can lazy-load/skip on cloud.

---

## 4. Design-system & shell port

1. **CSS/theme:** the companion already builds from the same `src/index.css`, so tokens, utility
   classes, and keyframes are available. Verify the companion `main.tsx` imports the same stylesheet
   and that the accent variables (`--accent-1/2/3`) are seeded (mirror the PC's accent via
   `/api/settings`, or let the phone pick its own in Settings).
2. **Primitives:** reuse `ui.tsx` (`SectionTitle`, `Badge`, `StatusBadge`, `Segmented`, `Toggle`,
   `EmptyState`, `Skeleton`, `Spinner`, `Card`, `HudPanel`) verbatim.
3. **Mobile shell:** build `companion/Shell.tsx` = sticky header (page title + now-playing chip) +
   `<Outlet/>` + bottom tab bar. Use react-router (add `react-router-dom` to the companion entry) so
   pages get URL routes and `PageTransitionFX`/`AnimatedOutlet` transitions carry over.
4. **Navigation:** bottom tabs with Motion `layoutId` active indicator; overflow items in a swipe-up
   sheet (reuse `Modal.tsx`/a new `Sheet.tsx`). Preserve the desktop's live status dot logic from
   `Sidebar.tsx` (green/amber/idle from `tracking`).
5. **Responsive rules:** default every `grid lg:grid-cols-N` → `grid-cols-1` on mobile; convert wide
   tables (sessions/tracks) to stacked rows; make hero panels shorter; ensure 44px min touch targets.

---

## 5. Animations & motion (preserve the "feel")

Port these and keep them, but **budget for mobile GPUs**:
- **Page transitions:** `AnimatedOutlet` + `PageTransitionFX` (route-change wipe/shader). Keep, but
  shorten durations on mobile.
- **Marquee/decoration system:** `MarqueeFX` (~18 techniques) + `CoverMarquee`/`VerticalCoverMarquee`/
  `ImageMarquee`/`AppsTodayMarquee`/`PanelArtBackdrop`. Reuse as **touch-scrollable rails** and
  panel backdrops. Gate the heavy "extra" tier (shader/kenburns/bokeh) behind the existing
  `perfMode`/`prefs.marquee` and **`prefers-reduced-motion`**; default mobile to the "compact" tier.
- **Micro-interactions:** `AnimatedNumber`, `Reveal`, `SectionTitle` sheen, `Segmented`/`Toggle`
  spring, nav active-pill (`layoutId`), `Skeleton` shimmer, `animate-glow-pulse`,
  `animate-pulse-ring`. All cheap — keep.
- **Ambient:** `AmbientShell`, `FloatingParticles`, `LottieIdle`, `MarqueeShader`,
  `ShaderImageTransition`. Keep on capable devices; auto-disable under reduced-motion / low perfMode /
  when on battery saver. Note: the desktop's shader carousel has a DOM fallback because the Tauri
  asset protocol taints WebGL textures — on the phone images come over http(s), so WebGL should work,
  but keep the fallback path.
- **Respect a single motion switch:** wire everything to the shared `useMotionEnabled()` /
  `perfMode` conventions so one toggle governs it all (mirrors the desktop convention).

---

## 6. Remote-control overhaul (the headline improvement)

Current control path = Rust `xcap` grabs the whole primary monitor → JPEG (≤1280px, ~12fps) → sent as
WS binary or base64 over the WebRTC `screen` data channel → phone swaps an `<img>`; input =
normalized pointer/keys over `/control` → `enigo`. It works but is high-latency, bandwidth-heavy, and
single-monitor. Overhaul in phases:

### 6.1 Video pipeline (biggest win)
- **Replace `<img>` JPEG swapping with a real WebRTC *video track*.** Encode the screen to H.264/VP8
  and send it on a media track so the phone decodes in a hardware `<video>` element. This alone cuts
  latency and bandwidth dramatically and enables smooth 30–60fps.
- **Capture:** switch from `xcap` full-frame grabs to the **Windows Graphics Capture API** (or Desktop
  Duplication, DXGI) for GPU-side capture with dirty-rects, then a **hardware encoder** (Media
  Foundation / NVENC / QSV / AMF) producing an H.264 elementary stream.
- **Transport:** feed encoded frames into a WebRTC video track. Options: adopt a native WebRTC stack
  in Rust (e.g., `webrtc-rs`) on the PC side for a proper `RTCPeerConnection` with a video sender, or
  bridge encoded NAL units into the existing browser-host peer via `insertableStreams`/an encoded
  track. (Note: the current design deliberately uses the *browser's* RTCPeerConnection in the desktop
  webview to avoid a native WebRTC dep — moving to a real video track likely requires a native sender;
  weigh the tradeoff.)
- **Fallback:** keep the JPEG-over-datachannel path for compatibility / when hardware encode is
  unavailable, but make quality/fps **adaptive** (drop resolution/fps under `bufferedAmount` pressure;
  raise when idle). Encode **delta/dirty regions** only when static.
- **Audio:** optionally add a PC→phone **audio track** (WASAPI loopback capture) so games/music are
  heard on the phone.

### 6.2 Input & interaction
- **Pointer modes:** add a **trackpad/relative mode** (drag anywhere to move the cursor, tap to click)
  in addition to today's absolute mapping — much better for precise desktop control on a small screen.
- **Gestures:** two-finger scroll with inertia, pinch-to-zoom the remote view, long-press =
  right-click, two-finger tap = right-click, edge-swipe for back.
- **Keyboard:** keep the hidden-input capture; add a **modifier bar** (Ctrl/Alt/Shift/Win sticky
  keys), function keys, arrow cluster, and common combos (Ctrl+C/V, Alt+Tab). Add **clipboard sync**
  (copy on PC ↔ paste on phone and vice-versa) over a small control message.
- **Latency:** coalesce pointer moves to animation frames (already ~25ms throttle — make it adaptive),
  send input over an **unreliable/unordered** channel for moves and a reliable one for clicks/keys.

### 6.3 Multi-display, quality & QoL
- **Monitor selection:** enumerate monitors on the PC, let the phone pick which to view/control.
- **Quality slider:** resolution cap + fps + bitrate presets (Auto / Smooth / Sharp), and a
  **fit vs 1:1** view toggle with pan.
- **Connection HUD:** live RTT, fps, bitrate, and packet-loss indicator; **auto-reconnect** with
  session resume; graceful "PC asleep" / "host not on Remote page" messaging (see §7 caveat).
- **Wake & launch:** optional Wake-on-LAN; "launch game X then take control" one-tap flow (uses the
  new `POST /api/games/:id/launch`).
- **File transfer:** drag/drop or share-sheet → send a file to the PC (and pull screenshots back).

### 6.4 Security & sessions
- **Per-device pairing:** name devices, list connected devices on the PC Remote page, **revoke**
  individual tokens (rotate is all-or-nothing today).
- **On-PC confirmation:** first control session from a new device shows a confirm prompt on the PC.
- **View-only mode:** a toggle to allow watching but block input.
- **Encryption:** cloud path already gets DTLS/SRTP via WebRTC; for the LAN path consider TLS
  (self-signed + pinning) so screen/input aren't plaintext on the network.

### 6.5 Host lifecycle fix (do early — it's a real bug)
Today `startHost()` runs only while the **desktop Remote page is mounted**, so the phone can only
connect when that page is open. **Move the WebRTC host to an app-level effect** (e.g., a top-level
component or a zustand-driven service) gated on `remote_enabled && cloud_enabled`, so the PC accepts
connections regardless of the current page or when minimized to tray.

---

## 7. Constraints & gotchas (don't relearn these the hard way)

- **CSP:** the desktop webview's `connect-src` must whitelist any host it dials (signaling/STUN/TURN)
  — see `src-tauri/tauri.conf.json`. The **companion** CSP is `null` (unrestricted), so the phone can
  reach the PC freely; keep it that way or whitelist explicitly.
- **Cleartext:** LAN mode is `http`/`ws` — the Android manifest needs
  `android:usesCleartextTraffic="true"` (forced in `companion/src-tauri/gen/android/app/build.gradle.kts`).
  Cloud mode is `wss` via Cloudflare (TLS), so it's clean.
- **Companion build:** `companion/` needs its own `package.json` (Gradle's generated task runs
  `npm run tauri` with cwd there). Release APKs are **unsigned** — zipalign + apksigner with the debug
  keystore for sideloading (see `companion/README.md`).
- **Admin for input:** injecting into elevated apps/games needs the PC app run as administrator.
- **P2P reachability:** WebRTC needs STUN hole-punching; CGNAT networks need a **TURN** relay (not yet
  bundled — Cloudflare Calls TURN fits since the domain is already on Cloudflare).
- **Signaling ordering / peer-join** is symmetric now (`signaling/src/main.rs`) — keep it that way.
- **No tracking on the phone:** never import the tracking engine, tray, autostart, detection, importer,
  or launcher-sync code into the companion bundle. The phone only *reads* tracked data and issues the
  whitelisted remote actions.
- **Data source at runtime:** `remoteClient.ts` `normBase()` picks `https` for domains and `http` for
  raw IPs; WS URLs derive `wss`/`ws` from the base. Reuse this — don't hardcode schemes.

---

## 8. Suggested execution order (phased; each phase compiles & is verifiable)

1. **Phase 0 — Backend parity.** Add all §3 read endpoints + mirror them into the WebRTC `data`
   handler (shared path→handler table). Verify with `curl`/the `sigtest`-style script. *(No UI yet.)*
2. **Phase 1 — Data seam.** Refactor `api.ts` `call()` to a pluggable transport; add the companion
   HTTP/WebRTC transport; keep `queries.ts` intact. Verify existing companion Stats/Music still work.
3. **Phase 2 — Shell & nav.** Router + bottom tabs + "More" sheet + mobile `Page` shell + now-playing
   chip. Port `ui.tsx` primitives (already shared).
4. **Phase 3 — Core pages.** Dashboard, Library, Music, Apps (highest value, data mostly ready).
5. **Phase 4 — Rich pages.** GameDetail, System, Timeline, Collection, Tags (need the new endpoints +
   media-over-cloud).
6. **Phase 5 — Animations pass.** Wire marquee/ambient/shader systems with `perfMode` +
   `prefers-reduced-motion` gating; tune durations for mobile.
7. **Phase 6 — Remote actions.** Pause tracking, launch game, status change, playback control.
8. **Phase 7 — Remote-control overhaul (§6).** Host-lifecycle fix first (§6.5), then video-track
   pipeline, input modes, multi-monitor, quality HUD, security. Land incrementally behind flags.
9. **Phase 8 — Settings & polish.** Companion-local settings (theme/accent/motion/perf, connection
   management, device list), empty/error states, offline handling, accessibility, reduced-motion.

**Definition of done per phase:** `npx tsc --noEmit` clean, `npm run build` emits both bundles,
`cargo check` clean; the touched screens render against a live PC (LAN and cloud); no tracking-engine
code imported into the companion bundle.

## 9. Concrete file map for the executor

- New/edited backend: `src-tauri/src/remote/mod.rs` (routes), maybe `src-tauri/src/remote/api_map.rs`
  (shared path→handler table), `src/lib/rtcHost.ts` (`handleData` parity).
- New data seam: `src/lib/api.ts` (transport indirection), `src/companion/transport.ts` (HTTP/WebRTC
  transport), reuse `src/lib/remoteClient.ts`, `src/lib/remoteConfig.ts`, `src/companion/cloud.ts`.
- Companion UI: `src/companion/main.tsx` (router), `src/companion/Shell.tsx`, `src/companion/nav/*`,
  `src/companion/screens/{Dashboard,Library,GameDetail,Apps,System,Timeline,Music,Collection,Tags,
  Control,Settings}.tsx` — each composing the shared `src/components/**`.
- Keep: `companion.html`, `companion/src-tauri/**`, the existing pairing/cloud flow.

> Reuse desktop components wherever the layout allows; only fork a component when its desktop layout is
> fundamentally desktop-shaped. Match the surrounding code's naming, comment density, and idioms.
