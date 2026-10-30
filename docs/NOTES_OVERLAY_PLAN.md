# Notes floating overlay: rewrite plan

**Status: waiting for your go-ahead. None of this is built yet.** Published with a live prototype: [Notes Orb Plan](https://claude.ai/artifact/No73HXdMke9KN9xLeUuVRY).

Researched 2026-10-30 on this PC: Windows 11 build 26300, two 3840×2160 monitors at 125 % (one at negative X), 60 Hz, WebView2 156.0.4314.50, Tauri 2.11.3, tao 0.35.3, wry 0.55.1. Every number below was measured here unless it says otherwise. Lab code and raw results are in the shared notes folder under `overlay-lab/`.

## 1. The short version

**Why it says Not Responding.** When you press Copy on a note, GameTracker calls Windows' `EmptyClipboard` on its only UI thread. Windows makes that call wait for whichever app owns the clipboard at that moment. If that app is busy, for example Unity during a domain reload, GameTracker waits up to 5 seconds. The overlay, the main window and the tray all share that one thread, so everything freezes. After 5 seconds Windows swaps the overlay for a ghost window titled "Clipboard". I reproduced both halves on this PC.

**Why it feels buggy the rest of the time.** One copied note fires 8 refreshes and 24 commands. One incoming image blocks the UI thread for 558 ms. A click made during any of that is lost, and then the bubble sticks to your mouse. The bubble's window is also 71 px wider than the bubble, so an invisible strip eats clicks.

**What I recommend.** Take the overlay out of the main app:

- A small new process, `gametracker.exe --notes-shell`, in the same style as the remote host.
- A **native orb** drawn by the Windows compositor. Its animations run inside Windows itself, so they keep moving even when our thread is frozen. Measured: 1.8 MB of private memory, and an animation that carried on through a 2.4 second freeze.
- A **WebView panel** behind real desktop acrylic, reusing the React notes UI with a virtualised list.
- Every slow operation moved off every UI thread.

**What I need from you.** A yes on the direction, and the decisions in section 12. Phase 0 is small and stops the freezes straight away, so it can ship before anything else.

## 2. What is actually wrong

| # | What you see | Root cause | Evidence |
|---|---|---|---|
| 1 | "Not Responding", everything frozen for up to 5 s | `EmptyClipboard` on the UI thread waits for the clipboard's current owner | Reproduced: 5,013 ms wait, ghost window |
| 2 | Any other freeze | One UI thread runs the overlay, main window and tray; 172 of 193 commands run on it | Live window list, stall meter |
| 3 | Half-second stalls around images | Decode, re-encode, decode and thumbnail all run on the UI thread | 558 ms for a real 15.3 MB image |
| 4 | Jank whenever a note arrives | Double events plus double listeners: 8 refreshes per note | 24 commands, 120 ms stall |
| 5 | Clicks do nothing, bubble glued to the mouse | Drag state is saved after an `await` | Reproduced on the real component |
| 6 | Dead zone beside the bubble, Alt-Tab entry, focus stolen | Wrong size at creation, missing permission, wrong window styles | Measured on the live window |
| 7 | Stuttery open and close | The OS window is resized every frame through IPC | 20× more UI-thread load than a compositor animation |
| 8 | Small faults listed in 2.8 | See below | Code reading |

### 2.1 The freeze: `EmptyClipboard` on the UI thread (confirmed)

The path is `Copy` button, `clip.copy`, `clipboard_copy` ([commands.rs:2898](../src-tauri/src/commands.rs)), `copy_to_os` ([clipboard/mod.rs:395](../src-tauri/src/clipboard/mod.rs)), `set_os_text` and then `EmptyClipboard()` ([watch.rs:399](../src-tauri/src/clipboard/watch.rs)). `clipboard_copy` is a synchronous command, so all of it runs on the UI thread.

I measured the wait directly. A helper thread took clipboard ownership and then stopped pumping messages, as a busy app does. A second thread then did exactly what `clipboard_copy` does. It ran inside a private window station, which has its own clipboard, so your real clipboard and notes were never touched.

<!-- chart:clipboard -->

| Owner busy for | Time inside `EmptyClipboard` |
|---|---|
| 0 s | 3 ms |
| 2 s | 1,950 ms |
| 4 s | 3,949 ms |
| 8 s | 5,013 ms |
| 20 s | 5,004 ms |

The cap is about 5 seconds, which is also Windows' hang threshold. To confirm the hang itself, I froze the UI thread for 9 seconds with a command sent from the hidden main window. About 5 seconds in, `IsHungAppWindow` turned true for the overlay and Windows created a Ghost-class window titled **Clipboard**. It cleared when the freeze ended. So the overlay can go "Not Responding" from work that has nothing to do with it.

This fits your day well, although my test used a stand-in owner, not Unity itself. The clipboard owner is the app you last copied from, and your notes are full of Unity console output. So a likely trigger is: copy from Unity, Unity starts compiling, you press Copy on a note, and the app freezes. Each extra click queues another wait.

### 2.2 One thread runs everything (confirmed)

The live window list shows the overlay, the main window and the tray all on thread 11592. Tauri runs a synchronous command on that thread: a 40 ms sleep in a command held the UI thread for 41 ms. The numbers:

- 172 of 193 commands are synchronous, including 22 of the 23 `clipboard_*` commands.
- 27 synchronous commands contain something risky: `open_external_link` (shell call), `detect_games`, `system_app_history`, `launch_game`, `import_games_csv` and more.
- SQLite waits up to 5 seconds on a locked database (`busy_timeout = 5000`, [db/mod.rs:34](../src-tauri/src/db/mod.rs)) and r2d2 waits up to 30 seconds for a free connection. A write on the UI thread can therefore hit the same 5 second wall. I didn't catch this one happening; it is a second route to the same symptom.
- Windows logged 9 low-memory events in the last 60 days, all naming Unity at 11–14 GB. Page faults on a shared UI thread stall everything too. In one stretch today, a new process took 17 seconds to log its first line.

### 2.3 Images block the UI thread (measured)

`clipboard_add` on your largest stored image, 15.3 MB:

| Step | Time |
|---|---|
| Decode PNG (`to_png`) | 76 ms |
| Re-encode as PNG (`to_png`) | 371 ms |
| Write file | 5 ms |
| Decode again for the thumbnail (`save_image`) | 78 ms |
| Make and write the thumbnail | 11 ms |
| **Total on the UI thread** | **558 ms** |

Pressing Copy on an image costs another 125 ms before it even reaches the clipboard. There are 1,625 images in your history, and every image arriving from the phone takes this path.

### 2.4 One copied note: 8 refreshes, 24 commands (measured)

`add_local` emits `item` and `changed` to everyone, then emits both again to the overlay ([clipboard/mod.rs:386](../src-tauri/src/clipboard/mod.rs)). `app.emit` already reaches the overlay, so it gets each one twice. The overlay and the panel each listen to both, and every refresh runs three commands. The lab counted 8 refreshes and 24 commands per copied note, with one 120 ms UI stall.

The worst of those commands is `clipboard_tags`, a 20.3 ms scan of all 4,461 live notes on every refresh. It is slow because `tags` is stored after `text`, so SQLite has to walk through every note's text to reach it, including one 20 MB note. On a copy with the text moved out of the way, the same scan took 4.7 ms.

### 2.5 Lost clicks and the sticky bubble (confirmed on the real component)

`useWindowDrag` awaits the window position before it saves its drag state ([ClipboardOverlay.tsx:46](../src/features/clipboard/ClipboardOverlay.tsx)). If the mouse button comes up during that wait, the release finds no state and the click is dropped. The state is then saved after the button is already up, so the next mouse move drags the window with no button held.

I ran the shipping component with a 120 ms delay on the position call. The click was lost and the bubble followed the mouse. A UI thread busy for 120 ms is common here because of 2.3 and 2.4.

### 2.6 The bubble's window is wrong (measured on your live window)

- **Size.** Your bubble's window is 166×95 px right now, not 95×95. Windows applies its minimum width of 166 px when a window with a caption is created, and nothing calls `setSize` until the first open. The extra 71 px is invisible and still takes clicks. The lab showed the same 166 at creation and a correct 95 after one `set_size`.
- **Permission.** `setResizable` is called in three places, but `core:window:allow-set-resizable` isn't granted. Every call is rejected, so the bubble keeps its resize frame (style `0x14CF0000`).
- **Styles.** The window has `WS_EX_APPWINDOW` and lacks `WS_EX_TOOLWINDOW` and `WS_EX_NOACTIVATE`, so it can show up in Alt-Tab, and it takes focus from your app on every click.

### 2.7 The open animation resizes an OS window every frame (measured)

`tweenSize` calls `setSize` once per frame. Each step costs a median 8.9 ms of IPC out of a 16.7 ms frame, and each resize triggers two more commands from `installDesktopVisibility`. UI thread latency during the morph:

| Approach | p95 | p99 |
|---|---|---|
| Resize the window each frame (today) | 4.99 ms | 7.56 ms |
| Fixed window, compositor animation | 0.22 ms | 0.46 ms |

On an idle lab page this still holds 60 fps. The problem is that it has no margin, so any stall from 2.3 or 2.4 shows up as a stutter.

### 2.8 Smaller faults (from reading the code)

- The bubble and panel are one React tree with no error boundary. Any render error blanks both and leaves an invisible window on top. A paste larger than the localStorage quota is one way to get there, because the draft effect has no try/catch ([Composer.tsx:113](../src/features/clipboard/Composer.tsx)).
- `backdrop-filter` can't see the desktop from inside a transparent WebView, so the panel's 24 px blur only blurs its own page. Every note row adds another blur layer. That is GPU cost for no visible effect.
- The watcher encodes PNGs while it holds the OS clipboard open ([watch.rs:323](../src-tauri/src/clipboard/watch.rs)). Other apps' paste can fail during that time. Our own `OpenClipboard` has no retry, so a Copy press can silently do nothing.
- Pin, delete, tag and folder changes made while offline are dropped, because `sendPin` and friends only send if the socket is open ([clipboardSync.ts:472](../src/lib/clipboardSync.ts)).
- The overlay loads the whole app: router, query client, tracking bridge.
- The panel unmounts on every close, so scroll position and expanded rows are lost.
- The fullscreen guard polls every 2 seconds and makes a blocking call into the UI thread.

### 2.9 Ruled out

I tested these because they looked likely. None of them causes the hang.

| Suspect | Result |
|---|---|
| Huge notes through IPC | 20 MB stalls the UI thread for only 56 ms, sync or async |
| Huge notes as events | 20 MB delivered in 433 ms, 57 ms UI stall |
| Note classifier or a bad regex | 5.6 ms per 40 notes; slowest real note 6.4 ms |
| Text layout at the tiny bubble width | 33 ms at 30 px wide, 45 ms across the whole open |
| `setPosition` flooding during drag | No backlog at 125 Hz; drains in 3 ms |
| A stalled WebView2 browser or GPU process | Suspended either one for 8 s: `set_size` still returned in 2 ms, no hang |
| `OpenClipboard(NULL)` | Microsoft documents `SetClipboardData` failing after this; here it succeeded |
| Slow commits | 0.01 ms median, 0.04 ms p99 on this disk when idle |

### 2.10 The crash.log lead

The panics are not the hang, and the evidence ties them to app shutdown, not the overlay:

- `Destroyed` is the state tao enters after the event loop has ended, so that panic can only happen during exit. It also hit the remote-host process on 2026-10-09, and that process has no overlay.
- In the 2026-10-27 case the host had already gone a second earlier, and the next normal start was an hour later.
- Neither main-app panic was followed by the host's "main app gone" restart, which is what a real crash produces.
- The `re-entrant` panic needs a nested message pump inside tao's event handler. wry's `wait_with_pump` during window creation is one such pump, and `open_overlay` builds its window inside `run_on_main_thread`. So the old overlay is a possible trigger for that one, but I can't prove it from one log line.

Two related findings:

- The only hang Windows recorded (2026-10-28 13:46, process `0x5da8`) was the remote host stuck in `build()`, already fixed in 3.9.123. Overlay freezes that clear on their own leave no record, which is why Phase 0 adds a stall log.
- The main app also had three `0xc0000409` aborts on 2026-10-28 with nothing in crash.log, so they skipped the panic hook. One came 14 seconds after a low-memory warning, which points at allocation failure, but the other two have no such signal. This is separate from the overlay and I've proposed it as its own task.

## 3. Options compared

| Option | Stops the freezes | Fluid | Idle cost | Keeps features | Work |
|---|---|---|---|---|---|
| A. Patch in place | Only the known ones; 150 other sync commands can still freeze it | No | WebView always on | Yes | Small |
| B. Second UI thread in the main process | Hangs yes, crashes no; unsupported by Tauri | Partly | WebView always on | Yes | Large, risky |
| C. Own process, all WebView | Yes | No: still resizes per frame | About 150 MB private | Yes | Medium |
| **D. Own process, native orb, WebView panel** | **Yes** | **Yes** | **Orb 1.8 MB plus a small host** | **Yes** | **Medium to large** |
| E. D plus full Visual hosting | Yes | Best | Same as D | Yes, after rebuilding input | Large |
| F. Fully native panel (GPUI, Slint, egui) | Yes | Yes | Lowest | Rewrite | Very large |
| G. WinUI 3 sidecar | Yes | Yes | Adds .NET and Windows App SDK | Rewrite | Very large |

Why D:

- **A** can't win, because one thread would still run 150 other synchronous commands.
- **C** isolates the freeze but keeps the old morph and pays for a WebView while the bubble is doing nothing.
- **E** would let Windows animate the WebView itself, which is the most advanced route. But wry doesn't support it, so we'd have to rebuild mouse, keyboard, IME, focus, accessibility and Tauri's IPC by hand. The same result on screen is reachable with D, and D can still grow into E later.
- **F** throws away Composer, voice, type-aware rendering, link previews and tags, and stops sharing UI with the `/clipboard` page. GPUI is real on Windows now (Zed ships on it, with a DirectX 11 renderer), but it is pre-1.0, and a 2025 survey found no screen reader support.
- **G** adds a second language and a large runtime for one window.

What the lab proved for D:

| Question | Result |
|---|---|
| Native window at exact size? | 95×95 px, no 166 px floor |
| Does a compositor animation survive a frozen thread? | Yes. Thread asleep 2,400 ms, width grew 177, 317, 357, 371, 379 px |
| Orb memory | 1.8 MB private, 11.5 MB working set |
| Window to Visual mode | Cross-process child windows go from 3 to 0, one environment variable |
| Real acrylic on a transparent WebView | Works in both hosting modes |
| New panel in a running WebView2 | 92–164 ms to first paint |
| Reopen a hidden panel | 14–17 ms |
| Fresh process to first paint | 382–400 ms |
| Helper process, own WebView2 folder | About 150 MB private while the panel exists |
| Second process sharing a folder | About 64 MB private |

## 4. Recommended design

<!-- diagram:architecture -->

### 4.1 Processes and threads

**`gametracker.exe --notes-shell`** is a new process, started and supervised exactly like `--remote-host`: named mutex `Local\GameTrackerNotes-v1`, restart with backoff, `quit.flag` and `updating.flag` respected. It has four kinds of thread:

- **Orb thread.** Win32 message loop, COM STA and a DispatcherQueue. It owns the orb window and the Windows.UI.Composition tree. It handles drag, hover, hotkey, drop and fullscreen detection. It never touches the database or the WebView, so nothing can block it.
- **Shell UI thread.** The tao event loop, hosting only the panel window and its WebView. No blocking work is allowed here, and its invoke handler has only async commands.
- **Worker pool.** Database, images, speech to text and link previews.
- **Clipboard thread.** One dedicated thread with its own message-only window. It is the only place allowed to wait on another app. Copy returns at once.

**The Windows compositor (DWM)** runs the orb's and the morph's animations. Microsoft's description: composition animations "run directly in the compositor process, independent of the UI thread".

**The main app** keeps the tracker, the clipboard watcher, relay sync and the `/clipboard` page. It loses the overlay window and the fullscreen guard.

### 4.2 How each cause gets fixed

| Cause | Fix |
|---|---|
| 1. `EmptyClipboard` freeze | Runs on the clipboard thread; can't touch any UI thread. If the owner is busy the button says so instead of freezing |
| 2. One thread for everything | The overlay has its own process. A main-app freeze can't reach it |
| 3. Image stalls | Worker pool; skip re-encoding images that are already PNG; one decode instead of two |
| 4. Refresh storm | One coalesced `notes://changed` carrying a revision number; fetch only what changed; the tag list is cached against that revision |
| 5. Lost clicks | The orb is native, so input state is synchronous by construction |
| 6. Wrong window | `WS_POPUP`, tool window, no-activate. Exact size, no Alt-Tab entry, no focus theft |
| 7. Stuttery morph | No per-frame resize. Compositor springs on a fixed-size stage |
| 8. Smaller faults | Error boundary, real acrylic, no nested blur, retrying clipboard, durable outbox, slim entry page, panel stays mounted |

### 4.3 Data flow between the processes

The database stays the single source of truth, so neither process depends on the other being alive.

- **Reads.** The shell has its own small connection pool and reads directly, as the remote host already does.
- **Writes.** The shell writes directly, then signals. A new `clipboard_outbox` table holds pin, delete, tag and folder changes durably. Unsynced notes already have `synced = 0`.
- **Signals.** Two named events, one per direction. They only make things faster: a cheap revision check every 3 seconds with the panel open, or 30 seconds closed, covers a lost signal.
- **Sync status.** The main page writes a small status file on change; the panel reads it.
- **Copy loop.** The clipboard thread adds a private format to everything it writes, and the watcher skips anything carrying that format. This replaces today's 1.5 second ignore window, which can't work across processes.

### 4.4 What happens when things go wrong

| Failure | What you see |
|---|---|
| Main app freezes or crashes | Orb and panel keep working. New notes save locally. The pill says sync is paused, and it catches up later |
| Panel page crashes | Orb is untouched. The page reloads and an error boundary offers recovery |
| Notes shell dies | Main app restarts it within about 5 seconds. Nothing is lost |
| WebView2 won't start | The orb stays alive and the panel shows a native message with a link to the main window. Same heartbeat idea as 3.9.123 |
| Clipboard owner is busy | "Waiting for Unity…" on the button, nothing else affected |
| Power cut | SQLite WAL, plus drafts, position and size saved to the database, not localStorage |

## 5. Look and motion

The live prototype on the published plan page shows the intended feel. It is a browser simulation of what the native orb will do. The direction is deep-space glass from the app's own palette: dark frosted panel, aurora rim light in the accent colours, Sora for headings, Inter for text, JetBrains Mono for code.

### 5.1 The orb

| Moment | Behaviour |
|---|---|
| At rest | A small glass squircle with a soft rim. Draws nothing and costs nothing |
| Hover | Springs out 6 % and the rim brightens |
| Press | Squishes to 94 % in 40 ms, so every click answers at once |
| Drag | Follows the pointer natively, stretches slightly along its speed |
| Release | Keeps its momentum, flies to the nearest screen edge and settles with a spring |
| Idle by an edge | After 4 s, tucks 60 % behind the edge and dims. Hover brings it back |
| New note | A ripple runs round the rim, the count bumps, and a small peek card shows the first line for 1.6 s |
| Copy flight | A small spark travels from the cursor to the orb when you copy (optional) |
| Sync | Green steady, amber slow pulse while reconnecting, grey when off |
| Recording | Red rim while the mic is on |
| Fullscreen app | Fades away; returns when the app leaves |

### 5.2 The morph

Opening is a single continuous shape, about 320 ms:

1. The orb thread starts the spring immediately, before anything else happens.
2. A rounded-rectangle shape grows from the orb to the panel's rectangle on a compositor spring (damping about 0.82). `CompositionRoundedRectangleGeometry` animates its size, offset and corner radius inside Windows.
3. The real panel window is already in place underneath, hidden by the shape.
4. As the shape settles it fades out over 120 ms, revealing real acrylic. List rows rise in with an 18 ms stagger, capped at 8 rows.

If the WebView isn't ready yet, the shape holds with native skeleton rows until it is, so a cold open never shows a blank. Closing runs the same thing backwards with more damping, about 220 ms.

### 5.3 The panel

- **Material.** Real desktop acrylic (`DWMSBT_TRANSIENTWINDOW`) with the app's dark tint, plus native rounded corners and shadow from Windows. I tested exactly this and it looks right. While the panel doesn't have focus, Windows shows flat colour in place of blur, which is how every Windows 11 acrylic surface behaves.
- **List.** Virtualised, so 4,500 notes scroll like 40. Rows use plain layers with a 1 px light edge and a type stripe. No nested blur.
- **Modern CSS that WebView2 156 already has.** `corner-shape: squircle` for softer corners, `linear()` for spring curves, `interpolate-size` to animate to auto height, `field-sizing: content` for the composer, View Transitions for filter changes, `content-visibility` for offscreen work.
- **Touches.** Copy flips to a check with a soft ripple. Pinning lifts the card and lands it in the pinned group. Delete slides out with a short undo. Search highlights matches as you type.
- **Keyboard.** Up and Down move through notes, Enter copies and closes, Ctrl+P pins, Delete removes, and typing goes to search.
- **Reduced motion.** Follows the Windows setting: springs become 120 ms fades, no flight, no tuck.

### 5.4 Targets

| Measure | Target |
|---|---|
| Reaction to a click | Under 16 ms, native |
| Warm open, fully settled | Under 350 ms |
| Cold open, fully settled | Under 700 ms, skeleton from the first frame |
| Copy command returns | Under 5 ms whoever owns the clipboard |
| Shell UI thread p99 during a burst of 100 notes | Under 8 ms |
| Scrolling 4,500 notes | 60 fps |
| Idle CPU | About 0, no timers while resting |
| Memory, panel closed and released | Under 30 MB private |
| Memory, panel open | Under 200 MB private |

## 6. Feature parity

Everything the overlay does today stays.

| Feature today | In the new design |
|---|---|
| Bubble: tap to open, drag to move, position saved | Native orb; position stored as monitor, edge and offset |
| Pulse on a new note | Rim ripple and peek card |
| Hidden during fullscreen apps | Event-driven (`SHQueryUserNotificationState`), no polling |
| Header: close, title, live sync pill, drag | Same; drag through the OS window move |
| Composer: text, Enter to add, Shift+Enter, draft saved | Same; draft saved to the database |
| Paste an image, pick an image | Same, on workers |
| Voice: Sarvam or Web Speech fallback | Same, including its error messages |
| Edit a note, Save, Cancel, Esc | Same |
| Search notes and tags | Same; can later reach all history (Phase 5) |
| All, Text, Images filters | Same |
| Tag chips and content-type chips with counts | Same |
| Pinned group, infinite scroll, skeletons, empty state | Same, virtualised |
| Type-aware bodies: prose, links, code, JSON, logs, commands, paths | Same components |
| More and Less; image View | Same; full text loads on demand |
| Link previews and opening links | Same; opening moves off the UI thread |
| Copy, Edit, Tags, Share, Pin, Delete with confirm | Same |
| Tag picker with new-tag field | Same |
| Device name, relative time, image size, tag badges | Same |
| Resize from edges, size remembered, stays on screen | OS resize drag, saved to the database |
| Settings: Floating widget toggle, diagnostics | Same toggle; diagnostics gain the shell's log |

## 7. Worth adding, your call

These go beyond parity. Each is small once the base exists.

- **Global hotkey** to open the panel from anywhere, for example Ctrl+Shift+Space.
- **Paste back:** Enter copies, closes and returns focus to your previous app, like Win+V.
- **Drop onto the orb** to save a file or image. Because the app runs elevated, drops from Explorer need a window message filter and plain text drags won't work.
- **Search all history** with SQLite FTS5 instead of paging through 1,000 notes.
- **Exclude the orb from your phone stream** so it doesn't cover the screen remotely.

## 8. Database and sync changes

**Migration 29**, in one transaction. The equivalent rebuild took under a second on a copy of your notes.

- Rebuild `clipboard_items` with `text` as the last column, so metadata reads never walk through it.
- Add `preview` (the first 8 KB), `text_len` and `rev`.
- Add `clipboard_meta` with one revision counter, bumped by triggers so both processes stay honest.
- Add `clipboard_outbox` for pin, delete, tag and folder changes.

**Commands**, all async, in a new `notes` module with no Tauri dependency, so it can be unit tested:

- `notes_list` returns previews, never full text.
- `notes_text(id)` fetches full text on demand.
- `notes_changes(since_rev)` returns what changed.
- `notes_add`, `notes_update`, `notes_delete`, `notes_pin`, `notes_tags`, `notes_copy` and `notes_position` cover the rest.

**The main app** moves all `clipboard_*` commands to async, and `clipboardSync.ts` drains the outbox. This also fixes the offline drops.

**The phone and the relay don't change.** The wire format stays the same.

## 9. Migration and rollout

1. New setting `notes_shell_enabled`, default off in the first build. The old overlay stays as the fallback.
2. You try the new one. If it feels right, it becomes the default.
3. On first run, the old position, size and draft are copied into the database.
4. One release later, remove the old overlay: `ClipboardOverlay.tsx`, the `/clip-overlay` route, the fullscreen guard, `OVERLAY_LABEL` and every `emit_to` for it.

A new Vite entry, `notes.html`, keeps the panel slim, with a start-up budget of 250 KB of JavaScript. It gets its own capability file listing only what it uses, and a test will fail if code calls a window API that isn't granted. That is the guard against a repeat of 2.6.

## 10. Phases and how each is verified

Each step is committed once tested, so a power cut costs one step.

### Phase 0: stop the freezes (small, ships alone)

| Step | Change | Verified by |
|---|---|---|
| 0.1 | `clipboard_copy` and `open_external_link` become async | Busy-owner test: UI thread stays under 16 ms during a 5 s wait |
| 0.2 | All other `clipboard_*` commands become async | Stall meter during image sync |
| 0.3 | Remove the duplicate `emit_to`; coalesce refreshes; cache tags | Lab count: 1 refresh per note instead of 8 |
| 0.4 | Watcher closes the clipboard before encoding; retries on `OpenClipboard` | Test with a held clipboard |
| 0.5 | Fix `useWindowDrag`; set size at mount; grant `set-resizable` | The race test from 2.5 flips to a regression test |
| 0.6 | Production stall log, `ui-stalls.log`, naming the command that caused each stall over 250 ms | Forced stall appears in the log |

### Phase 1: foundations (no visible change)

| Step | Change | Verified by |
|---|---|---|
| 1.1 | `notes` module, migration 29, unit tests | Migration on a copy of your real database, including the 20 MB note; kill mid-migration and restart |
| 1.2 | Outbox in `clipboardSync.ts` | Offline pin and delete reach the phone after reconnect |
| 1.3 | `--notes-shell` path, supervision, signals, setting | Kill each process in turn; the others survive and restart it |
| 1.4 | Spike gates, see below | Written pass or fail, with a fallback for each |

Spike gates that must pass before Phase 2:

- Window to Visual mode with real typing, IME, selection, right-click, scrolling, mic permission and window drag. I couldn't test real input without taking over your desktop. If it fails, the panel uses normal hosting; process isolation doesn't depend on it.
- Windows.UI.Composition running in the elevated process, on the app's `windows` 0.58 bindings.
- The orb on both monitors, including the one at negative X, and across a DPI change.

### Phase 2: the native orb

| Step | Change | Verified by |
|---|---|---|
| 2.1 | Window, compositor tree, DPI handling | Exact pixel size on both monitors |
| 2.2 | Press, drag, throw, edge snap | Rust tests for the snap and physics; hand test with the mouse |
| 2.3 | Tuck, ripple, peek card (DirectWrite text) | Frozen-thread test; zero CPU at rest |
| 2.4 | Fullscreen rule, hotkey, drop | Borderless game, exclusive game, video player |
| 2.5 | Reduced motion and high contrast | Windows setting on and off |

### Phase 3: the panel

| Step | Change | Verified by |
|---|---|---|
| 3.1 | `notes.html`, slim root, error boundary, capability file | Bundle budget test; forced render error recovers |
| 3.2 | Shell window, acrylic, position logic, OS resize | Screenshots on both monitors and with a bubble in each corner |
| 3.3 | Virtualised list, new row design | 4,500 notes at 60 fps; UI thread under target |
| 3.4 | Composer, voice, search, filters, tags | Full parity checklist from section 6 |
| 3.5 | Morph handoff, warm and cold | Timed from click to settled |
| 3.6 | Keyboard control and accessibility | Keyboard-only run; screen reader smoke test |

### Phase 4: switch over

- Parity checklist signed off by you.
- A 50-cycle soak of open, close, drag and copy, plus reopen under a busy clipboard owner.
- Sleep and resume, Explorer restart, monitor unplug, and the power-cut check.
- Flip the default, then remove the old code one release later. `AGENTS.md` gets a new section.

### Phase 5: optional

Search with FTS5, paste back, phone stream exclusion, and later a move to full Visual hosting if the panel ever needs more.

### Regression tests that stay in the repo

- The clipboard wait test, ported from the lab as an ignored Rust test using a private window station.
- The frozen-thread test for the orb.
- The race test for input state.
- A capability test that compares window API calls with the granted permissions.
- The refresh-count test.

## 11. Risks

| Risk | Likelihood | Plan |
|---|---|---|
| Window to Visual breaks some input path | Medium | Gate in Phase 1; normal hosting is the fallback |
| Third process adds memory | Certain, bounded | Panel WebView released after 15 idle minutes; idle cost is the orb plus a small host |
| Windows.UI.Composition quirks from Rust | Medium | Spike first. DirectComposition, already used by the presence overlay, is the fallback |
| Acrylic goes flat without focus | Certain | Accepted Windows behaviour; the dark tint keeps it looking intentional |
| Two processes writing the same database | Low | Already the case with the remote host; short transactions on workers |
| Migration interrupted by a power cut | Low | Single transaction; tested by killing it |
| Updater and installer | Low | Same exe and same kill path as the remote host |
| Orb hidden behind a fullscreen remote stream | Low | Same fullscreen rule; hotkey still works |

## 12. Decisions for you

My default is in bold. Saying "go" accepts all of them.

1. **Direction:** build option D? **Yes.**
2. **Order:** ship Phase 0 first as its own update? **Yes**, because it stops the freezes now.
3. **Edge behaviour:** snap to edges and tuck when idle? **Yes**, with a setting to turn tuck off.
4. **Closing:** does clicking elsewhere close the panel? **No**, it stays open as it does today. Esc or the orb closes it.
5. **Hotkey:** add one? **Yes, Ctrl+Shift+Space**, changeable in Settings.
6. **Copy flight:** the spark from cursor to orb? **Off by default**, because you copy a lot.
7. **Warm panel:** keep the WebView ready after closing? **Yes, for 15 minutes**, then release its memory.

## Appendix: re-running the lab

`overlay-lab/` in the shared notes folder holds three small crates and the runner scripts:

- `lab`: a Tauri app with the same versions as GameTracker. `run_lab.sh` and `run_lab2.sh` run each experiment once and skip finished ones after a restart.
- `bubble`: the native orb spike.
- `cliplab`: the clipboard wait test in a private window station.

Sources for outside claims:

- [Windowed vs Visual hosting of WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/windowed-vs-visual-hosting)
- [Visual layer in desktop apps](https://learn.microsoft.com/en-us/windows/uwp/composition/visual-layer-in-desktop-apps)
- [IsHungAppWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-ishungappwindow)
- [OpenClipboard](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard)
- [DWM_SYSTEMBACKDROP_TYPE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type)
- [WebView2 process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)
- [Tauri: calling the frontend](https://v2.tauri.app/develop/calling-frontend/)
- [Raymond Chen on cross-process window trees](https://devblogs.microsoft.com/oldnewthing/20130412-00/?p=4683)
- [Wails PR 5380: Window to Visual under RDP](https://github.com/wailsapp/wails/pull/5380)
- [Zed for Windows](https://zed.dev/blog/zed-for-windows-is-here)
