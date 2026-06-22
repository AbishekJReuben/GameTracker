# GameTracker

A premium, local-first **game playtime analytics** app for Windows. It runs quietly in the system
tray, automatically records your gaming sessions, and turns them into a beautiful, animated
dashboard — live now-playing, activity heatmaps, streaks, a horizontal timeline, and a curated
collection of your completed games.

Built with **Tauri 2 (Rust)** + **React / TypeScript / Tailwind / Framer Motion**.

## Highlights

- **Accurate dual tracking** — records both total process **runtime** (even when alt-tabbed) and
  **active/focused** time, with idle/AFK excluded from active time.
- **Auto-start & background** — launches to the tray at login and tracks silently. Rich tray with a
  live timer, pause/resume, and today's total.
- **Beautiful dashboard** — live now-playing card, animated stat tiles, 6-month activity heatmap,
  weekly trends, top games, and recent sessions.
- **Library** — poster-style cover art, statuses (Playing / Backlog / Completed / Dropped), ratings,
  notes and tags. Add games manually, **drag-and-drop an .exe or folder**, or **scan** Steam / Epic /
  GOG and running processes (never auto-added — you choose).
- **Completed-games collection** — import your games CSV (title, developer, release/completed year,
  Metacritic, your score). Analytics for completions-per-year, *your score vs critics*, and top studios.
- **Horizontal timeline** — colour-tagged sessions laid out left-to-right, plus a completions-by-year
  view. Toggles and filters throughout.
- **Sessions log** — full filterable table (game, date range, min duration, hide-AFK) with CSV/JSON export.
- **100% local** — your data never leaves your machine. SQLite at
  `%LocalAppData%\com.chilloutgames.gametracker\gametracker.db`.

## Requirements

- Windows 10/11 with **WebView2** (preinstalled on Windows 11)
- [Rust](https://rustup.rs/) 1.77+ and [Node.js](https://nodejs.org/) 18+

## Develop

```powershell
npm install
npm run tauri dev
```

## Build an installer

```powershell
npm run tauri build
```

The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`.

## How tracking works

A background thread ticks every ~2s: it enumerates running processes (via `sysinfo`) to find
registered games, reads the foreground window and global idle time (Win32), then accrues **runtime**
for every running game and **active** seconds only for the focused game while you're not idle.
Sessions merge across quick restarts and are recovered if the app exits unexpectedly.

## Data & privacy

Everything is stored locally. Use **Settings → Backup / Restore** to snapshot or move your database,
and **Export** (CSV/JSON) from the Sessions page. Online cover-art fetching is opt-in and **off by
default**.

## Project layout

```
src/            React + TypeScript frontend (routes, components, hooks)
src-tauri/      Rust backend (db, tracking engine, detection, commands, tray)
```

## Contributing / working on this project

See **[AGENTS.md](AGENTS.md)** — a full guide for AI agents and contributors covering the
architecture, conventions, build/verify workflow, troubleshooting of issues already encountered,
and a roadmap.
