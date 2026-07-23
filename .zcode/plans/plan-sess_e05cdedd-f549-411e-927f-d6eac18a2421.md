## Fix: tappable links when preview is off + lag-free floating Notes dock

Both changes are in **one file**: `scripts/android-templates/ClipboardService.java` (the Android floating "keyboard"/Notes dock — single source of truth, applied to `gen/android` by `patch-android.mjs`).

---

### Part A — Links clickable when "Preview off" (tap-to-open in the body)

Root cause (`ClipboardService.java:2622-2623`): the clickable link card (`addLinkPreview`) is added *only* when `dockShowLinkPreviews` is true. When it's off there is no clickable target. The body `TextView` also has `setTextIsSelectable(true)` (line 2619), and Android's selection mode is mutually exclusive with link-click handling — so links were never openable from the body either.

Fix (in a new `configureBody(TextView body, String text)` helper used by the row builder/binder):
- When `dockShowLinkPreviews == false` **and** the note contains an http link:
  - `Linkify.addLinks(body, Linkify.WEB_URLS)` + `body.setMovementMethod(LinkMovementMethod.getInstance())` + `body.setLinkTextColor(0xFF67E8F9)`.
  - Do **not** set `setTextIsSelectable(true)` on these rows (it conflicts with `LinkMovementMethod` and would swallow the tap).
  - Net effect: a single tap on the URL opens the browser.
- Notes **without** a link: keep `setTextIsSelectable(true)` exactly as today (selection still works).
- When preview is **on**: unchanged — selectable body + the existing clickable preview card.

This fully delivers "when preview is off, links should be clickable" with reliable single-tap-open. (I'm deliberately not doing the fragile dual movement-method "long-press to select on link rows" dance — it's unreliable in overlay windows; the explicit **Copy** button already covers copying for link rows, and selection remains intact on all non-link notes.)

---

### Part B — Full view recycling (the real fix for the lag)

Root cause (`renderPanel`, line 140): every refresh calls `panelList.removeAllViews()` then `renderList()` **fully re-inflates every visible row** — ~10 View objects × 30 rendered rows ≈ 300 allocations (`View`, `LayoutParams`, `GradientDrawable`, lambdas) per refresh, immediately GC'd. Refreshes fire constantly: each relay notice (741/760), every thumbnail decode (820), pin/delete toggles (1045/2854), plus the 48 ms coalesced re-render.

Fix — reuse `View` instances by id instead of re-inflating:

1. **Add a `RowHolder` + pools + a live-rows map** (new fields):
   - `static final class RowHolder { ClipEntry entry; TextView body; ImageView image; LinearLayout metaRow; TextView expand; View linkCard; Button pinBtn, folderBtn; String linkUrl; boolean linkPreviewOn; boolean expanded; }`
   - `HashMap<String,View> liveRows` (id → row currently built) and two `ArrayList<View>` pools keyed by kind (`"text"` / `"image"`), capped (~20 each).
2. **Listeners capture the holder, not the entry.** Every per-row listener (`Copy`, `✎`, folder, pin, share, delete, image-row share, long-press expand) reads `holder.entry` at click time. Because a `ClipEntry`'s `kind` is `final` and ids are stable, a pooled row's listeners are set **once** in `buildRow` and never need rebinding — eliminating per-bind lambda allocation and stale-capture bugs.
3. **Split `renderList` into `buildRow(kind)` + `bindRow(holder, entry)`:**
   - `buildRow(kind)` — constructs the views once (or pops a pooled row), wires listeners to the holder.
   - `bindRow(holder, entry)` — updates only visual state: body text + `configureBody`, row background (pinned stroke / pending-delete red), pin glyph + colour, folder-button colour, meta time/tag text, image thumb (from cache, else kick `fetchImageThumb`), expand visibility/label. No new listeners, no new views.
4. **New recycled render path** (replaces the body of `renderList` for history mode):
   - Compute `snapshot = filteredLocked()` (ordered, capped at `renderLimit`) — order is unchanged, so `sortItemsLocked` correctness is preserved.
   - Recycle any `liveRows` id not in the desired set → detach, push to pool (drop if pool full).
   - `panelList.removeAllViews()` (clears section headers + detaches rows; rows stay alive via `liveRows`).
   - Walk the snapshot in order, re-adding section labels/dividers (tiny, rebuilt as today) and, for each entry: reuse `liveRows.get(id)` or `obtainRow(kind)` (pool → `buildRow`), then `bindRow`, then `addView`. 
   - Result: after the first render, subsequent refreshes only build rows for **genuinely new** ids; everything else is a cheap `bindRow`. Allocation/GC churn drops to near zero.
5. **Link-card reconciliation in `bindRow`:** track `holder.linkUrl`/`holder.linkPreviewOn`. Only remove + re-add the preview card when the URL or the preview toggle actually changed (so a normal refresh doesn't churn the card). `addLinkPreview` is changed to insert at the right index (before `metaRow`) instead of appending, so the body→card→meta→expand order stays correct. The existing `linkPreviewCache` makes a re-added card for the same URL instant (no re-fetch).
6. **Folder-chooser mode** (`renderFolderChooser`) stays a direct (non-recycled) render — it's small and rarely shown; `removeAllViews` before it naturally clears recycled rows, and returning to history reuses the `liveRows` cache.

Also folded in (same hot path, trivial): cache `DisplayMetrics.density` once instead of `dp()` calling `getResources().getDisplayMetrics()` ~98× per render.

All existing invariants are preserved: order follows `sortItemsLocked`; catch-up echoes still dedupe by id; pinned-first ordering, two-tap delete, pin/folder/share all behave identically — just without re-inflating the world each refresh.

---

### Verify
- Review the template carefully for Java correctness (matching the file's existing style).
- Run `node scripts/patch-android.mjs` to confirm it still applies cleanly (substitutes `__PACKAGE__`).
- The human should build the APK (`npm run companion:android`) / let CI build to confirm it compiles + test on device: toggle Preview off → tap a link in a note → opens browser; open the dock, copy several notes from PC (rapid refreshes) and confirm smooth/no jank; pin/delete/thumb-load should update rows in place without flicker.

Not included (per the chosen scope): the separate "micro-opts only" bucket beyond the density cache.