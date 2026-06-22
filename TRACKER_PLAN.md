# Tracker — Implementation Plan (apps + games, properly separated)

> **Audience:** the engineer/LLM implementing this. Read this top to bottom, then read
> `AGENTS.md` for conventions (serde camelCase, sync commands, migrations via
> `PRAGMA user_version`, media under `media_dir`, etc.). Follow those conventions exactly.
>
> **Scope of this document:** rebrand to **Tracker**; treat **apps** and **games** as
> first‑class but *separately accounted* entities (apps can run boot→shutdown, so their
> time must NOT inflate or mix with game stats); split **Timeline / Insights / Collection /
> Sessions** so the two never blend; enrich **app** pages with online icon/cover/info; add
> **embedded review panels** (Steam + Metacritic, review section only) and an **embedded
> site panel** to the **game** detail page.
>
> **Out of scope / already done** (do not redo): the `kind` discriminator column, the Apps
> page, basic app detection (`detect_apps`), basic Wikipedia app info (`fetch_app_info`),
> Steam screenshots on games, the cover-image cached-render fix, fluid responsive `Page`,
> the timeline tooltip-clip fix, and the suggestions tag‑mute/variety work. Build on these.

---

## 0. Current state (what exists today)

- **Entity model:** apps and games share the `games` table, discriminated by
  `kind TEXT NOT NULL DEFAULT 'game'` (`'game' | 'app'`). Sessions reference `games.id`;
  `sessions` rows are produced by the tracker thread.
- **Tracker** (`src-tauri/src/tracking/tracker.rs`): every 2s, builds a running set
  (process present → **runtime**), finds the foreground PID (→ **active** when focused &
  not idle). Accrues `runtime += 2` for *every* running registered entry and `active += 2`
  for the focused one. **This is the core problem for apps** (see §2).
- **Stats** (`src-tauri/src/db/stats.rs`): dashboard counts are already scoped to
  `kind='game'`; `catalog_analytics` is games‑only; `raw_sessions()` (used by dashboard
  totals, heatmap, hour‑of‑day, insights) is **NOT** kind‑scoped → currently app time leaks
  into shared time totals/heatmap/insights. Fix in §6.
- **Timeline:** single timeline with an All/Games/Apps filter. Needs to become **two
  stacked timelines** (§3).
- **App metadata:** `metadata::fetch_app_info` (Wikipedia summary + media‑list images).
  Needs richer sources & a guaranteed icon/cover (§4).
- **Detail page** (`src/routes/GameDetail.tsx`): kind‑aware; shows screenshots gallery for
  games and Wikipedia images for apps. Needs embedded review/site panels for games (§5).
- **Branding:** "GameTracker" strings throughout. Rename to "Tracker" (§1).

Key files you will touch repeatedly:
- Backend: `src-tauri/src/db/{mod.rs,models.rs,games.rs,sessions.rs,stats.rs}`,
  `src-tauri/src/tracking/tracker.rs`, `src-tauri/src/{commands.rs,metadata.rs,detect.rs,lib.rs}`,
  `src-tauri/tauri.conf.json`.
- Frontend: `src/lib/{api.ts,queries.ts,mock.ts}`, `src/routes/{Timeline,Insights,Collection,Sessions,GameDetail,Apps,Dashboard}.tsx`,
  `src/components/{Sidebar,Topbar,TitleBar,Timeline,ScreenshotGallery}.tsx`, `src/store/app.ts`.

**Conventions reminder (do not violate):** Rust DTOs `#[serde(rename_all="camelCase")]`;
TS interfaces in `api.ts` must mirror exactly. New columns → new migration block (bump
`user_version`, never edit a shipped block). New command → write in `commands.rs`, register
in `lib.rs` `generate_handler!`, add wrapper in `api.ts`, add a `mock.ts` case. Commands stay
synchronous unless doing real long/network work (those may spawn a thread, like the metadata
calls already do). Update `src/lib/mock.ts` for every new command/field so `npm run dev`
(browser preview) keeps working.

**Verification per phase:** `npx tsc --noEmit` (frontend), `cd src-tauri && cargo check`
(backend), and for anything network‑shaped, a throwaway `curl` test of the live endpoint to
confirm JSON/DOM shape before writing parsing code. Final: `npm run tauri build`.

---

## 1. Rebrand: GameTracker → "Tracker"

**Goal:** the product is called **Tracker** (it tracks apps *and* games). Change *display*
strings only. **Keep the Tauri identifier `com.chilloutgames.gametracker`** so existing
users keep their database/auto‑start registration (the data dir is keyed off the identifier:
`%LocalAppData%\com.chilloutgames.gametracker\`). Changing the identifier would orphan all
existing data — do **not** do it unless the user explicitly asks; if they do, add a one‑time
data‑dir migration that copies the old dir to the new one on first launch.

**Tasks**
1. `src-tauri/tauri.conf.json`: `productName` → `"Tracker"`; window `title` → `"Tracker"`.
   Leave `identifier` unchanged. (Config is compiled in — rebuild after.)
2. `package.json`: `name` may stay `gametracker` (internal) or become `tracker`; if you
   change it, also check any script/path that references it (none currently do).
3. UI branding:
   - `src/components/Sidebar.tsx` — the wordmark currently renders `Game` + accented
     `Tracker`. Change to just accented `Tracker` (or `Track` + accented `er`), and the
     subtitle `play analytics` → `play & app analytics` (or similar).
   - `src/components/TitleBar.tsx` and `src/components/Topbar.tsx` — any "GameTracker" text.
   - `src/routes/Settings.tsx` — the about block "GameTracker 2.0 …".
   - `src/components/Onboarding.tsx` — welcome copy.
4. Tray: `src-tauri/src/tray.rs` and `tray_tooltip()` in `lib.rs` — "GameTracker — paused"
   → "Tracker — paused", "GameTracker · … today" → "Tracker · … today".
5. Installer name follows `productName`, so NSIS output becomes `Tracker_<ver>_x64-setup.exe`
   automatically. Bump `version` to `2.1.0` in `tauri.conf.json` + `package.json` +
   `Cargo.toml` for this whole feature set.
6. Grep the repo for the literal `GameTracker` and review each hit:
   `rg -n "GameTracker"` — update user‑facing strings; you may leave internal crate/lib
   names (`gametracker_lib`, the `gametracker` cargo package) as‑is to avoid churn.
7. Update `AGENTS.md` product name references (optional but nice).

**Acceptance:** window title, sidebar wordmark, tray tooltip, settings about, and installer
filename all say "Tracker"; existing DB still loads (identifier unchanged).

---

## 2. App tracking semantics — the "boot→shutdown" problem

**Problem:** an app like Spotify/Discord/Steam can be running from boot to shutdown. The
current tracker accrues `runtime += 2` for *every* running entry, so such an app would log
~16 h/day of "runtime" and a single multi‑hour session — meaningless, and it must never be
summed with game time.

**Design decision:** apps are tracked by **focus (foreground) usage**, not by background
process presence. Games keep dual metrics (runtime when present + active when focused).

**Data model**
- Add a per‑entry tracking mode so the rule is explicit and user‑overridable. Add to a new
  migration (see §7): `ALTER TABLE games ADD COLUMN count_background INTEGER NOT NULL DEFAULT 1;`
  - For **games**, default `1` (count background runtime — current behavior).
  - For **apps**, insert with `count_background = 0` (focus‑only). The app add paths
    (`add_app_from_path`, `import_detected_apps`) must set it to `0`.
  - Expose a toggle in the edit modal for apps: "Also count background time" (off by
    default) — useful for e.g. a music app the user *does* want counted while minimized.

**Tracker changes** (`src-tauri/src/tracking/tracker.rs`, and `MatchGame` in
`db/games.rs::match_candidates`)
1. Extend `MatchGame` to carry `kind: String` and `count_background: bool`. Update the
   `match_candidates` SQL to select `kind, count_background`.
2. In the tick loop:
   - **Runtime accrual:** only `runtime += 2` for an entry that is running **AND**
     (`kind == 'game'` OR `count_background == true`). A focus‑only app that is running in
     the background accrues nothing.
   - **Session lifecycle for focus‑only entries:** start/resume a session when the entry
     becomes the **focused** entry (not merely when its process appears); end it when it
     stops being focused for longer than the merge window. (For games, keep the current
     process‑presence lifecycle.) Practically: compute the "should‑have‑open‑session" set as
     `running_games ∪ {focused_app_if_any}` instead of `running_set` for apps.
   - **Active accrual** stays the same: `active += 2` only for the focused entry when not
     idle (applies to both kinds).
   - Net effect: an app's session spans only the periods it was actually in the foreground;
     its `runtime` ≈ `active` (no background inflation) unless `count_background` is on.
3. Make sure the live `TrackingState` snapshot still reflects the focused entry regardless of
   kind (so NowPlaying shows the focused app too). Consider adding `kind` to `TrackingState`
   so the UI can label "Now using <app>" vs "Now playing <game>".

**Acceptance:** add `notepad.exe` as an **app**, focus it (active+session accrue), minimize
it for several minutes (session ends after merge window; no runaway runtime), close it. The
recorded app session length ≈ focused time, not wall‑clock presence. Add a game and confirm
its runtime still accrues while alt‑tabbed.

---

## 3. Stats separation — never mix apps and games

**Rule:** every aggregate is computed per‑kind. No screen ever sums app seconds + game
seconds into one number. Where a screen is conceptually "games" (Collection, Insights of the
year‑in‑games, Dashboard top games) it shows games only; apps get parallel sections.

**Backend** (`src-tauri/src/db/stats.rs`)
1. `raw_sessions(pool, min_seconds)` currently reads `sessions` with no join — **add a
   `kind` parameter** and join `games` to filter `g.kind = ?`. Provide `raw_sessions_kind`
   or thread a `kind: &str` through. This is the single most important fix — it is the
   source of app time leaking into heatmap/hour‑of‑day/insights/dashboard totals.
2. `dashboard()`: make it games‑only (pass `'game'`). Add a sibling
   `apps_overview()` → `AppsOverview` DTO with: today/week/month/total **active** seconds,
   app session count, app count, top apps (by active), recent app sessions, last‑14 active
   sparkline, current/longest "usage streak" (apps). Reuse the same helpers but kind‑scoped.
   (Do NOT report background runtime as a headline app metric.)
3. `heatmap(days)` and `hour_of_day()`: add a `kind` argument (or make two commands:
   `heatmap`/`heatmap_apps`). Simplest: add optional `kind: Option<String>` param defaulting
   to `'game'`, plus an apps variant call from the Apps screens.
4. `insights(year)`: scope to games. Add `insights_apps(year)` (or a `kind` param) producing
   an apps‑only recap (active seconds, sessions, unique apps, top apps, monthly active). The
   `unique_games`/`completions` fields are game concepts — for apps return app‑appropriate
   fields (unique apps; drop "completions").
5. `catalog_analytics()` stays games‑only (already is). Apps have no "completion/score"
   catalog — do not invent one.

**Frontend (`api.ts` + `queries.ts`)**
- Add command wrappers: `appsOverview()`, `heatmap(days, kind)`, `hourOfDay(kind)`,
  `insights(year, kind?)` or `insightsApps(year)`, plus the DTO interfaces (camelCase).
- Add query hooks (`useAppsOverview`, `useHeatmap(days, kind)`, etc.). Keep existing
  game hooks defaulting to `'game'`.
- Update `useRefreshAll()` to invalidate the new keys.
- Update `mock.ts`: kind‑filter the existing builders and add `apps_overview` / apps
  variants returning app‑only data from the seeded app sessions (VS Code/Figma/Blender).

**Acceptance:** with app sessions present, Dashboard totals/heatmap/streaks reflect **games
only**; the Apps page shows its **own** overview (active time, top apps, usage by hour) with
numbers that match only app sessions; no screen shows a combined app+game total.

---

## 4. Timeline — two separate timelines (games + apps)

**Goal:** in `src/routes/Timeline.tsx`, show **two stacked timeline panels**: "Games" and
"Apps", each its own `<Timeline>` (the component in `src/components/Timeline.tsx`), each with
its own legend and its own per‑range stepper. Remove the All/Games/Apps *filter* segmented in
favor of two always‑visible sections (or keep a "Both / Games / Apps" view switch where
"Both" renders the two stacked panels and the others render one).

**Tasks**
1. Fetch sessions once (as today, broad window). Split into `gameSessions` and `appSessions`
   by `session.kind`.
2. Render:
   - Section header "Games" → `<Card><Timeline sessions={gameSessions} …/></Card>` + legend
     of game entries.
   - Section header "Apps" → `<Card><Timeline sessions={appSessions} …/></Card>` + legend of
     app entries (use the `AppWindow` icon, as already in the legend code).
3. Share the range control or give each its own; recommended: one shared range/`Segmented`
   at top driving both, plus each `<Timeline>` keeps its own offset stepper (it already owns
   `offset` internally — that's fine; both can page independently).
4. Keep the §existing "TimelineInsights" bottom section but split it too: compute "top
   games" from `gameSessions` and "top apps" from `appSessions`, or show one insights block
   per section. Do not blend.
5. App bars: consider a subtly different visual treatment (e.g., slightly lower saturation or
   a dashed top edge) so the two timelines read as distinct even at a glance. Optional.

**Acceptance:** Timeline screen shows a Games timeline and an Apps timeline, each with only
its own entries, each navigable, with no mixed bars or mixed legends.

---

## 5. App metadata enrichment (guarantee icon + cover + richer info)

Apps must reliably get an **icon** (always) and, when possible, a **cover/logo** and **rich
info** from the internet, shown on the app detail page.

**Icon (always, local, already available):** when an app is added with an exe path,
`commands::save_game` already calls `icons::extract_icon_png` for new tracked entries. Verify
this runs for apps too (it does, since apps have an exe). If an app has no exe (manual add),
fall back to the gradient placeholder. Optionally upgrade `icons.rs` to prefer the largest
available icon (jumbo icons via `SHGFI_SYSICONINDEX` + `IImageList`) per the AGENTS roadmap,
for crisper app art.

**Online enrichment (`metadata::fetch_app_info`, already partially built — expand):**
- Keep Wikipedia summary (description) + `media-list` images (already done).
- **Add a logo/cover guarantee:** if Wikipedia's `originalimage` is an SVG or missing, try:
  (a) the app's website favicon/og:image — fetch `website` (from Wikidata or a guess), read
  `<meta property="og:image">` / `<link rel="icon">`; (b) Wikidata `P154` (logo image) via
  `https://www.wikidata.org/w/api.php` then Commons. Keep all of this best‑effort and keyless;
  return `Ok(None)`/empty on any miss (never error the command).
- **More info fields:** extend `AppInfo` (and the `games` columns / `GameDto`) with
  app‑relevant facts where cheaply available from the Wikipedia summary/infobox:
  `developer/publisher`, `initial release year`, `latest version` (often in infobox),
  `category/genre` (→ tags), `license`, `platforms`, and the `website` URL. The Wikipedia
  REST `summary` is thin; for infobox fields use the MediaWiki action API
  (`action=parse&prop=wikitext` or `prop=text` and scrape the infobox) **or** Wikidata
  claims. Pick Wikidata (cleaner, JSON): resolve the article → Wikidata QID
  (summary response has `wikibase_item`), then `wbgetentities` for claims:
  developer `P178`, publisher `P123`, official website `P856`, logo `P154`, genre `P136`,
  inception `P571`, license `P275`, platform `P400`. Map to existing columns where possible
  (`developer`, `release_year`, `website`, tags) and store extras in a new
  `info_json TEXT` column (JSON blob) rendered as a key/value list on the detail page.
- **Test first:** before coding, `curl` the Wikidata `wbgetentities` for a known app QID and
  confirm the claim shape; `curl` the summary for `wikibase_item`. Only then write parsing.

**Frontend (`GameDetail.tsx`):** for apps, render an "About" card (description), a "Details"
list built from the new `info_json` (version, license, platforms, genre, released, developer,
website link), and the existing Wikipedia image gallery. Make the hero use the fetched
logo/cover. Ensure the **Get info** button on apps triggers this enriched fetch.

**Acceptance:** adding a well‑known app (VS Code, Spotify, Blender) and clicking **Get info**
yields: an icon (always), a cover/logo image, a description, and a details list with several
real fields + a working website link.

---

## 6. Embedded panels on the **game** detail page (Steam + Metacritic reviews, site)

**Goal:** on a game's page, show small **embedded webview** panels: (a) the **Steam review
section** only, (b) the **Metacritic review section** only, and (c) the game's **official
site** if available — all embedded *inside the app screen*, not as external browser tabs.

**Key technical reality (read carefully):**
- You **cannot** use HTML `<iframe>` for Steam/Metacritic — they send
  `X-Frame-Options`/`frame-ancestors` that block framing. An `<iframe>` will be blank.
- Tauri v2 supports **multiple webviews per window** (a child `Webview` positioned at an
  (x,y,width,height) in physical pixels, overlaying your HTML). A top‑level child webview is
  **not** an iframe, so it is **not** subject to `X-Frame-Options` and *can* load those pages.
  We inject JS/CSS to hide everything except the review section. This is the intended approach.
- Caveat: an embedded webview is a native layer painted over the WebView2 content; it does
  **not** flow with HTML or clip to rounded corners, and it must be manually positioned,
  resized, shown/hidden on scroll, and destroyed on navigation. Plan for this lifecycle.

**Approach A (preferred): embedded child webview with DOM stripping**
1. Backend (`src-tauri/src/lib.rs` or a new `src-tauri/src/embed.rs`): add commands
   (sync wrappers around Tauri's webview API; these touch the window so take `AppHandle`):
   - `open_embed(label: String, url: String, x,y,w,h: f64, strip: String)` — create or
     reuse a child webview with `WebviewBuilder` added to the main window at the given rect,
     navigate to `url`, and register an **initialization script** chosen by `strip`
     (`"steam"`, `"metacritic"`, or `"site"`). The init script hides all DOM except the
     target container and scrolls it into view.
   - `set_embed_bounds(label, x,y,w,h)` — reposition/resize (called on scroll/resize).
   - `set_embed_visible(label, visible)` — hide when the panel is scrolled out of view or on
     route change.
   - `close_embed(label)` — destroy on unmount/navigation.
   Use physical pixels: convert CSS rect → physical via the window scale factor.
2. **Strip scripts** (inject via `initialization_script`, runs before page scripts; also
   re‑apply on `DOMContentLoaded` and via a `MutationObserver` since these pages hydrate):
   - **Steam:** target the reviews block on the store page. Steam store URL:
     `https://store.steampowered.com/app/<appid>/?l=english`. There is an **age gate** for
     some titles — inject `document.cookie` for `birthtime`/`lastagecheckage`/`wants_mature_content`
     and `mature_content` to bypass, or use the App Reviews fragment. Reviews live under
     `#app_reviews_hash` / `.user_reviews` / the "Customer reviews" area; hide `<body>`
     children except that container, set `body{background:#1b2838}`, remove header/nav/footer.
     Store the Steam `appid` on the game (we already capture `steam_app_id` during
     `fetch_game_info` — persist it into a `steam_app_id` column so this panel can build the
     URL without re‑searching; add that column in the migration).
   - **Metacritic:** URL pattern `https://www.metacritic.com/game/<slug>/critic-reviews/`
     (and `/user-reviews/`). Resolve `<slug>` by searching Metacritic for the game name
     (server‑side scrape of the search page, or store a `metacritic_slug` column populated on
     **Get info**). Strip to the reviews list container; hide nav/ads/header.
   - **Site:** the game's `website` (already captured from Steam appdetails). No stripping —
     just load it; optionally inject CSS to hide cookie banners is out of scope.
3. Frontend: a `<EmbeddedPanel url strip />` React component that:
   - Measures its placeholder `div` with a `ResizeObserver` + listens to the scroll container
     (the `Page` scroll area) to recompute bounds; calls `open_embed`/`set_embed_bounds`.
   - Calls `set_embed_visible(false)` when the placeholder is outside the viewport, and
     `close_embed` on unmount/route change (use a cleanup in `useEffect`). The global route
     `AnimatePresence` means you MUST destroy on unmount or the native webview will linger.
   - Renders a styled frame (border, header "Steam reviews" / "Metacritic" / "Website", a
     "Open in browser" fallback link) with the native webview painted into the inner area.
   - In the **browser preview / non‑Tauri** mode (`isTauri()` false), render a graceful
     placeholder ("Embedded reviews available in the desktop app") instead of calling the
     commands — `mock.ts` has no webview.
4. Place these panels in a new "Reviews & links" section on `GameDetail.tsx`, **games only**
   (`!isApp`). Order: Steam reviews, Metacritic reviews, Website. Each panel ~360–520px tall,
   collapsible. Only create the webview for a panel when it's expanded/visible (lazy) to keep
   it light.

**Approach B (fallback if embedded webviews prove too fragile): native scraped reviews.**
Server‑side fetch + parse the review snippets (Steam: the appreviews API
`https://store.steampowered.com/appreviews/<appid>?json=1&num_per_page=10&language=english`
is **keyless** and returns review text/score/helpful counts as JSON — much more robust than
DOM stripping; Metacritic: scrape the critic snippets) and render them natively in a styled
list. This loses the "live page" feel but is reliable and testable. **Recommendation:** ship
Approach B for Steam reviews using the keyless `appreviews` JSON API (test it with `curl`
first — it's well‑structured), and use Approach A (embedded webview) for the **site panel**
and optionally Metacritic. Document both; implement whichever the user prefers, but the Steam
`appreviews` JSON is the pragmatic, low‑risk default and should be built first.

**Acceptance:** on a game with a known Steam appid, the detail page shows a Reviews panel with
real recent Steam reviews (text + thumbs + helpful count) and, if a website exists, an
embedded site panel (desktop app) or an "Open site" card (preview). No layout breakage on
scroll/resize; panels disappear cleanly when navigating away.

---

## 7. Insights / Collection / Sessions — split games vs apps

**Collection** (`src/routes/Collection.tsx`): already games‑only by virtue of
`status==='completed'` + scores (apps lack both). Add a guard `g.kind==='game'` on every
`useGames()`‑derived array there to be explicit and future‑proof. Do **not** add an apps
section to Collection (apps have no completion/score concept). If desired, add a tiny note or
leave as is.

**Sessions** (`src/routes/Sessions.tsx`): add a **kind switch** (Segmented: "Games | Apps")
at the top that filters both the session list and the per‑entry filter dropdown by `kind`.
Pass `kind` into `useSessions({ kind })` (the `SessionFilter.kind` field already exists and is
honored by `sessions::list` and `mock.ts`). Keep games as the default tab. Never show a mixed
list unless you add an explicit "All" tab — if you do, badge each row with a game/app icon.

**Insights** (`src/routes/Insights.tsx`): add a top‑level Segmented "Games | Apps". For
"Games", render the existing year recap from `insights(year,'game')`. For "Apps", render an
apps recap from the new `insights_apps(year)` / `insights(year,'app')` — active seconds,
unique apps, top apps, monthly active, peak streak — and **omit** game‑only concepts
(completions, scores). Keep the year stepper shared.

**Dashboard** (`src/routes/Dashboard.tsx`): keep it games‑centric (already is). Optionally
add a single compact "Apps today" strip (today active + top app) that links to the Apps page,
but keep its numbers in their own widget — never folded into the game totals.

**Acceptance:** Sessions has Games/Apps tabs; Insights has Games/Apps tabs with
kind‑appropriate metrics; Collection contains zero apps; no screen blends the two.

---

## 8. Migrations & schema summary (one new migration block)

Add a single migration `if version < 5 { … PRAGMA user_version = 5; }` in
`src-tauri/src/db/mod.rs::run_migrations` (append; never edit shipped blocks). Columns:

```sql
ALTER TABLE games ADD COLUMN count_background INTEGER NOT NULL DEFAULT 1; -- §2 (apps insert 0)
ALTER TABLE games ADD COLUMN steam_app_id     INTEGER;                    -- §6 review/site URLs
ALTER TABLE games ADD COLUMN metacritic_slug  TEXT;                       -- §6 (optional)
ALTER TABLE games ADD COLUMN info_json        TEXT;                       -- §5 app extra facts (JSON)
```

Wire each new column through: `GameRow` + `map_row` + `to_dto` (`games.rs`), `GameDto`
(`models.rs`, camelCase), `GameInput` if user‑editable (`count_background`), `api.ts`
`Game`/`GameInput`, and `mock.ts` (`makeGame` + the two construction sites + add‑app cases).
`save_game`/upsert: persist `steam_app_id`/`info_json` via the metadata apply path; persist
`count_background` on app creation (`= 0`).

`MatchGame` (`games.rs::match_candidates`) gains `kind` + `count_background` for the tracker.

---

## 9. Frontend type/contract changes (checklist)

- `src/lib/api.ts`:
  - `Game`: add `countBackground: boolean`, `steamAppId: number | null`,
    `metacriticSlug: string | null`, `infoJson: string | null` (or a parsed `info` object).
  - `GameInput`: add `countBackground?: boolean`.
  - `TrackingState`: add `kind: EntryKind` (§2.3) if you surface "now using app".
  - New DTOs: `AppsOverview`, apps‑variant of `Insights`/`DayValue` usage, embed command args.
  - New wrappers: `appsOverview`, `heatmap(days,kind)`, `hourOfDay(kind)`,
    `insights(year,kind)` (or `insightsApps`), `openEmbed/setEmbedBounds/setEmbedVisible/closeEmbed`,
    Steam reviews fetch (`fetchSteamReviews(appId)`), enriched `fetchAppInfo`.
- `src/lib/queries.ts`: hooks for the above; extend `useRefreshAll` invalidations.
- `src/lib/mock.ts`: a case for every new command; new fields on every `Game` literal;
  kind‑filtered overview/insights builders; return graceful empties for embed/review commands
  in non‑Tauri mode.
- `src/store/app.ts`: if you add an apps "now using" concept, thread `kind` through.

---

## 10. Risks, gotchas, and ordering

- **Embedded webviews (§6) are the highest‑risk item.** Build §1–§5 and §7 first (pure
  data/UI, low risk), then attempt §6. Start with the **Steam `appreviews` JSON** (Approach
  B) which is robust and unit‑testable, then add the embedded site panel, then optionally the
  embedded Steam/Metacritic DOM‑strip panels. Always provide an "Open in browser" fallback.
- **Embedded webview lifecycle:** destroy on unmount and on route change; reposition on the
  `Page` scroll container's scroll event (not just window resize). A leaked child webview will
  float over other screens. Test by navigating away mid‑scroll.
- **CSP:** `img-src` is already `https:`. If you fetch og:images/logos client‑side you're
  fine; server‑side (Rust `ureq`) fetches are unaffected by CSP. Embedded webviews are their
  own browsing contexts (not constrained by the app CSP).
- **`tauri.conf.json` is compiled in** — rebuild the Rust crate after editing it (rename,
  version bump).
- **Don't regress the existing separations** already shipped (Library games‑only, dashboard
  game counts, suggestions games‑only taste). Re‑run the checks.
- **Tracker correctness (§2) is load‑bearing.** Add Rust unit tests for the accrual decision
  (given kind + count_background + running + focused → expected runtime/active deltas) so the
  cheaper LLM can't silently break it.
- **Mock parity:** the browser preview must keep working for fast iteration; every backend
  command needs a `mock.ts` case.

## 11. Suggested implementation order (PR‑sized chunks)

1. **Rebrand** (§1) — small, isolated, visible win. Build + smoke test.
2. **Migration 5 + plumb new columns** (§8/§9) through DTOs/types/mock (no behavior yet).
3. **Tracker app semantics** (§2) + Rust unit tests.
4. **Stats kind‑scoping + apps overview** (§3) + apps hooks/mock.
5. **Sessions/Insights/Collection split** (§7).
6. **Two timelines** (§4).
7. **App metadata enrichment** (§5) — Wikidata details + guaranteed logo + `info_json` UI.
8. **Steam reviews (JSON) panel** on game pages (§6 Approach B).
9. **Embedded site panel** (and optionally Metacritic/Steam DOM‑strip) (§6 Approach A).

Each chunk: `tsc --noEmit` + `cargo check` green, `mock.ts` updated, then a manual smoke
(`npm run dev` for UI, `npm run tauri dev` for tracker/webview behavior). Final deliverable:
`npm run tauri build` → `Tracker_2.1.0_x64-setup.exe`.

---

## 12. Definition of done

- Product reads "Tracker" everywhere user‑facing; existing data preserved.
- An always‑on app never inflates runtime and never appears in game stats; its time is
  focus‑based and shown only in app‑specific views.
- Dashboard/Heatmap/Insights/Collection/Sessions show games and apps in **separate**
  areas/tabs; no combined totals anywhere.
- Timeline shows two timelines (Games, Apps), each isolated.
- Apps reliably have an icon and, when online info exists, a cover + rich details panel.
- Game pages show a working reviews panel (Steam, real data) and an embedded site panel when
  a website exists, with browser fallbacks.
- `cargo check`, `tsc --noEmit`, and `npm run tauri build` all succeed; `mock.ts` keeps the
  browser preview functional.
