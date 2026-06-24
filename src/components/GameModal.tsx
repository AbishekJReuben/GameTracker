import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FileCode2, Image as ImageIcon, Trash2, Loader2, MousePointerSquareDashed, Search } from "lucide-react";
import { GameInput, GameStatus, GameSearchResult, api } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { useApp } from "@/store/app";
import { useSaveGame, useDeleteGame } from "@/lib/queries";
import { Modal } from "./Modal";
import { Segmented, Toggle } from "./ui";
import { springSoft } from "@/lib/motion";

const STATUSES: { value: GameStatus; label: string }[] = [
  { value: "playing", label: "Playing" },
  { value: "backlog", label: "Backlog" },
  { value: "on_hold", label: "On Hold" },
  { value: "completed", label: "Completed" },
  { value: "dropped", label: "Dropped" },
  { value: "watched", label: "Watched" },
];

const empty: GameInput = {
  displayName: "",
  exePaths: [],
  installFolder: "",
  status: "backlog",
  rating: null,
  developer: "",
  releaseYear: null,
  startedYear: null,
  startedMonth: null,
  startedDay: null,
  completedYear: null,
  completedMonth: null,
  completedDay: null,
  metacritic: null,
  notes: "",
  manualPlaytimeSeconds: 0,
  tags: [],
};

function num(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export function GameModal() {
  const { gameModal, closeGameModal } = useApp();
  const droppedPath = useApp((s) => s.droppedPath);
  const setDroppedPath = useApp((s) => s.setDroppedPath);
  const save = useSaveGame();
  const del = useDeleteGame();
  const [mode, setMode] = useState<"track" | "catalog">("track");
  const [form, setForm] = useState<GameInput>(empty);
  const [exe, setExe] = useState("");
  const [folder, setFolder] = useState("");
  const [tagText, setTagText] = useState("");
  const [coverSrc, setCoverSrc] = useState<string | null>(null);
  const [manualHours, setManualHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [steamAppId, setSteamAppId] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<GameSearchResult[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  // Skip the next auto-search after the title is set programmatically (pick/edit).
  const suppressSearch = useRef(false);

  const editing = !!gameModal.game;
  const isApp = (gameModal.game?.kind ?? gameModal.kind) === "app";
  const trackMode = isApp ? true : mode === "track";

  useEffect(() => {
    if (!gameModal.open) return;
    setMode(gameModal.mode);
    if (gameModal.game) {
      const g = gameModal.game;
      setForm({
        id: g.id,
        displayName: g.displayName,
        installFolder: g.installFolder ?? "",
        exePaths: g.exePaths,
        status: g.status,
        rating: g.rating,
        developer: g.developer ?? "",
        releaseYear: g.releaseYear,
        startedYear: g.startedYear,
        startedMonth: g.startedMonth,
        startedDay: g.startedDay,
        completedYear: g.completedYear,
        completedMonth: g.completedMonth,
        completedDay: g.completedDay,
        metacritic: g.metacritic,
        notes: g.notes ?? "",
        manualPlaytimeSeconds: g.manualPlaytimeSeconds,
        tags: g.tags,
        countBackground: g.countBackground,
      });
      setManualHours(g.manualPlaytimeSeconds > 0 ? String(Math.round((g.manualPlaytimeSeconds / 3600) * 10) / 10) : "");
      setExe(g.exePaths[0] ?? "");
      setFolder(g.installFolder ?? "");
      setTagText(g.tags.join(", "));
    } else {
      const creatingApp = gameModal.kind === "app";
      setForm({
        ...empty,
        status: gameModal.mode === "catalog" ? "completed" : "playing",
        kind: creatingApp ? "app" : undefined,
        countBackground: creatingApp ? true : undefined,
      });
      setExe("");
      setFolder("");
      setTagText("");
      setManualHours("");
    }
    setCoverSrc(null);
    setSteamAppId(null);
    setSuggestions([]);
    setShowSuggest(false);
    suppressSearch.current = !!gameModal.game;
  }, [gameModal.open, gameModal.game, gameModal.mode]);

  // Debounced online title autosuggest (new games only; not for apps/edits).
  useEffect(() => {
    if (!isTauri() || editing || isApp || !gameModal.open) return;
    if (suppressSearch.current) {
      suppressSearch.current = false;
      return;
    }
    const q = form.displayName.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const results = await api.searchGamesOnline(q);
        setSuggestions(results);
        setShowSuggest(results.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [form.displayName, editing, isApp, gameModal.open]);

  // A path dropped onto the window while this modal is open fills the form.
  useEffect(() => {
    if (!gameModal.open || !droppedPath) return;
    const path = droppedPath;
    const base = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
    if (/\.exe$/i.test(path)) {
      setExe(path);
      if (!form.displayName) {
        suppressSearch.current = true;
        set({ displayName: base.replace(/\.exe$/i, "") });
      }
    } else {
      setFolder(path);
      if (!form.displayName) {
        suppressSearch.current = true;
        set({ displayName: base });
      }
    }
    if (!isApp) setMode("track");
    setDroppedPath(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droppedPath, gameModal.open]);

  const set = (patch: Partial<GameInput>) => setForm((f) => ({ ...f, ...patch }));

  const pickSuggestion = (s: GameSearchResult) => {
    suppressSearch.current = true;
    set({ displayName: s.name });
    setSteamAppId(s.steamAppId);
    setSuggestions([]);
    setShowSuggest(false);
  };

  const browseExe = async () => {
    const sel = await open({ multiple: false, filters: [{ name: "Executable", extensions: ["exe"] }] });
    if (typeof sel === "string") {
      setExe(sel);
      if (!form.displayName) {
        const base = sel.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") ?? "";
        set({ displayName: base });
      }
    }
  };
  const browseFolder = async () => {
    const sel = await open({ directory: true });
    if (typeof sel === "string") setFolder(sel);
  };
  const browseCover = async () => {
    const sel = await open({ multiple: false, filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    if (typeof sel === "string") setCoverSrc(sel);
  };

  const submit = async () => {
    if (!form.displayName.trim()) return;
    setBusy(true);
    try {
      const manualSecs = manualHours.trim() ? Math.round(parseFloat(manualHours) * 3600) : 0;
      const payload: GameInput = {
        ...form,
        kind: gameModal.game?.kind ?? gameModal.kind,
        manualPlaytimeSeconds: Number.isFinite(manualSecs) ? manualSecs : 0,
        tags: tagText.split(",").map((t) => t.trim()).filter(Boolean),
        exePaths: trackMode && exe.trim() ? [exe.trim()] : [],
        installFolder: trackMode && folder.trim() ? folder.trim() : null,
        steamAppId: steamAppId,
      };
      const saved = await save.mutateAsync(payload);
      if (coverSrc) await api.setGameCover(saved.id, coverSrc);
      closeGameModal();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!form.id) return;
    await del.mutateAsync(form.id);
    closeGameModal();
  };

  return (
    <Modal open={gameModal.open} onClose={closeGameModal} title={editing ? (isApp ? "Edit app" : "Edit game") : isApp ? "Add an app" : "Add a game"}>
      <motion.div
        key={gameModal.game?.id ?? gameModal.mode}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={springSoft}
        className="space-y-4 p-5"
      >
        {!isApp && (
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "track", label: "Track playtime" },
              { value: "catalog", label: "Catalog entry" },
            ]}
          />
        )}

        <Field label={isApp ? "App name" : "Title"} hint={!isApp && !editing ? "Type to search — we'll fetch the cover & details" : undefined}>
          <div className="relative">
            <input
              className="input focus-ring"
              placeholder={isApp ? "Application name" : "Start typing a game name…"}
              value={form.displayName}
              onChange={(e) => {
                setSteamAppId(null);
                set({ displayName: e.target.value });
              }}
              onFocus={() => suggestions.length > 0 && setShowSuggest(true)}
              onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              autoFocus
            />
            <AnimatePresence>
              {showSuggest && suggestions.length > 0 && (
                <motion.ul
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={springSoft}
                  className="card absolute z-20 mt-1 max-h-72 w-full overflow-auto p-1 shadow-float"
                >
                  {suggestions.map((s) => (
                    <li key={`${s.source}-${s.steamAppId ?? s.name}`}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickSuggestion(s)}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.05]"
                      >
                        {s.coverUrl ? (
                          <img src={s.coverUrl} alt="" className="h-10 w-[4.5rem] shrink-0 rounded object-cover" loading="lazy" />
                        ) : (
                          <span className="grid h-10 w-[4.5rem] shrink-0 place-items-center rounded bg-white/[0.04]">
                            <Search className="h-4 w-4 text-ink-faint" />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-600 text-ink">{s.name}</span>
                          <span className="text-[11px] text-ink-faint">{s.source}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>
        </Field>

        {trackMode && (
          <>
            {!editing && (
              <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-line bg-white/[0.02] px-3 py-2.5 text-ink-dim">
                <MousePointerSquareDashed className="h-4 w-4 shrink-0 text-accent" />
                <span className="text-[12px]">
                  Tip: drag a game's <span className="font-600 text-ink-soft">.exe</span> or folder onto the window to fill these in.
                </span>
              </div>
            )}
            <Field label="Executable" hint="The game's .exe — used to detect when it's running.">
              <div className="flex gap-2">
                <input className="input focus-ring" placeholder="C:\…\game.exe" value={exe} onChange={(e) => setExe(e.target.value)} />
                <button onClick={browseExe} className="btn btn-subtle shrink-0 px-3" title="Browse">
                  <FileCode2 className="h-4 w-4" />
                </button>
              </div>
            </Field>
            <Field label="Install folder" hint="Optional — matches any exe inside this folder.">
              <div className="flex gap-2">
                <input className="input focus-ring" placeholder="C:\…\Game" value={folder} onChange={(e) => setFolder(e.target.value)} />
                <button onClick={browseFolder} className="btn btn-subtle shrink-0 px-3" title="Browse">
                  <FolderOpen className="h-4 w-4" />
                </button>
              </div>
            </Field>
          </>
        )}

        {isApp && trackMode && editing && (
          <Toggle
            checked={form.countBackground ?? true}
            onChange={(v) => set({ countBackground: v })}
            label="Also count background time"
          />
        )}

        {!isApp && (
          <Field label="Status">
            <Segmented value={form.status as GameStatus} onChange={(v) => set({ status: v })} options={STATUSES} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label={isApp ? "Publisher" : "Developer"}>
            <input className="input focus-ring" value={form.developer ?? ""} onChange={(e) => set({ developer: e.target.value })} />
          </Field>
          <Field label="Tags" hint="comma separated">
            <input className="input focus-ring" placeholder={isApp ? "productivity, design" : "rpg, co-op"} value={tagText} onChange={(e) => setTagText(e.target.value)} />
          </Field>
          <Field label="Release year">
            <input className="input focus-ring" inputMode="numeric" value={form.releaseYear ?? ""} onChange={(e) => set({ releaseYear: num(e.target.value) })} />
          </Field>
        </div>

        {!isApp && (
          <div className="rounded-xl border border-line bg-white/[0.02] p-3">
            <div className="mb-2 text-[11px] font-700 uppercase tracking-wider text-ink-dim">Started playing</div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Year">
                <input className="input focus-ring" inputMode="numeric" placeholder="YYYY" value={form.startedYear ?? ""} onChange={(e) => set({ startedYear: num(e.target.value) })} />
              </Field>
              <Field label="Month">
                <input className="input focus-ring" inputMode="numeric" placeholder="1–12" value={form.startedMonth ?? ""} onChange={(e) => set({ startedMonth: num(e.target.value) })} />
              </Field>
              <Field label="Day">
                <input className="input focus-ring" inputMode="numeric" placeholder="1–31" value={form.startedDay ?? ""} onChange={(e) => set({ startedDay: num(e.target.value) })} />
              </Field>
            </div>
          </div>
        )}

        {!isApp && (
          <div className="rounded-xl border border-line bg-white/[0.02] p-3">
            <div className="mb-2 text-[11px] font-700 uppercase tracking-wider text-ink-dim">Completed</div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Year">
                <input className="input focus-ring" inputMode="numeric" placeholder="YYYY" value={form.completedYear ?? ""} onChange={(e) => set({ completedYear: num(e.target.value) })} />
              </Field>
              <Field label="Month">
                <input className="input focus-ring" inputMode="numeric" placeholder="1–12" value={form.completedMonth ?? ""} onChange={(e) => set({ completedMonth: num(e.target.value) })} />
              </Field>
              <Field label="Day">
                <input className="input focus-ring" inputMode="numeric" placeholder="1–31" value={form.completedDay ?? ""} onChange={(e) => set({ completedDay: num(e.target.value) })} />
              </Field>
            </div>
          </div>
        )}

        {!isApp && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Metacritic">
              <input className="input focus-ring" inputMode="numeric" placeholder="0–100" value={form.metacritic ?? ""} onChange={(e) => set({ metacritic: num(e.target.value) })} />
            </Field>
            <Field label="My score">
              <input className="input focus-ring" inputMode="numeric" placeholder="0–100" value={form.rating ?? ""} onChange={(e) => set({ rating: num(e.target.value) })} />
            </Field>
          </div>
        )}

        <Field label="Manual playtime (hours)" hint="Added on top of tracked sessions — for imports or pre-tracking history.">
          <input className="input focus-ring" inputMode="decimal" placeholder="e.g. 42.5" value={manualHours} onChange={(e) => setManualHours(e.target.value.replace(/[^\d.]/g, ""))} />
        </Field>

        <Field label="Notes">
          <textarea className="input focus-ring min-h-[72px] resize-none" value={form.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} />
        </Field>

        <Field label="Cover image">
          <button onClick={browseCover} className="btn btn-subtle w-full justify-start">
            <ImageIcon className="h-4 w-4" />
            {coverSrc ? coverSrc.split(/[\\/]/).pop() : "Choose a cover image (optional)"}
          </button>
        </Field>
      </motion.div>

      <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-4">
        {editing ? (
          <button onClick={remove} className="btn btn-ghost text-pink hover:text-pink">
            <Trash2 className="h-4 w-4" /> Remove
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button onClick={closeGameModal} className="btn btn-ghost" disabled={busy}>
            Cancel
          </button>
          <motion.button
            onClick={submit}
            disabled={busy || !form.displayName.trim()}
            className="btn btn-primary min-w-[7.5rem]"
            whileTap={{ scale: 0.97 }}
          >
            <AnimatePresence mode="wait" initial={false}>
              {busy ? (
                <motion.span
                  key="loading"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  className="inline-flex items-center gap-2"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </motion.span>
              ) : (
                <motion.span
                  key="idle"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                >
                  {editing ? "Save changes" : isApp ? "Add app" : "Add game"}
                </motion.span>
              )}
            </AnimatePresence>
          </motion.button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-700 text-ink-soft">{label}</span>
        {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
