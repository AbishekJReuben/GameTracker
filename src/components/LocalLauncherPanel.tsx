import { useEffect, useMemo, useState } from "react";
import { Check, Download, FolderOpen, Loader2, Search } from "lucide-react";
import { api, type LocalLauncherGame } from "@/lib/api";
import { useRefreshAll } from "@/lib/queries";
import { useApp } from "@/store/app";
import { isTauri } from "@/lib/tauri";

const PLATFORM_LABELS: Record<string, string> = {
  epic: "Epic Games",
  riot: "Riot Games",
  ubisoft: "Ubisoft Connect",
  rockstar: "Rockstar Games",
};

function capLabel(v: string) {
  if (v === "online") return "Online";
  if (v === "local") return "Local install";
  return "Not available";
}

export function LocalLauncherPanel({
  platform,
  library,
  playtime,
  achievements,
  notes,
}: {
  platform: string;
  library: string;
  playtime: string;
  achievements: string;
  notes: string;
}) {
  const label = PLATFORM_LABELS[platform] ?? platform;
  const pushToast = useApp((s) => s.pushToast);
  const refresh = useRefreshAll();
  const [games, setGames] = useState<LocalLauncherGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  const load = () => {
    if (!isTauri()) return;
    setLoading(true);
    api
      .localLauncherLibrary(platform)
      .then((list) => {
        setGames(list);
        setPicked(new Set(list.filter((g) => !g.imported).map((g) => g.name)));
      })
      .catch(() => setGames([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (expanded) load();
  }, [expanded, platform]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games.filter((g) => !q || g.name.toLowerCase().includes(q));
  }, [games, query]);

  const toggle = (name: string, imported: boolean) => {
    if (imported) return;
    setPicked((s) => {
      const next = new Set(s);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const importSelected = async () => {
    const names = [...picked];
    if (names.length === 0) return;
    setImporting(true);
    try {
      const [added, updated] = await api.localLauncherImport(platform, names);
      refresh();
      load();
      pushToast({
        kind: "success",
        title: `${label} import`,
        message: `Added ${added} · updated ${updated}`,
      });
    } catch (e) {
      pushToast({ kind: "info", title: "Import failed", message: String(e) });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/8 bg-base-900/40 p-4">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div>
          <h3 className="font-700 text-ink">{label}</h3>
          <p className="mt-1 text-xs text-ink-dim">
            Library: {capLabel(library)} · Playtime: {capLabel(playtime)} · Achievements:{" "}
            {capLabel(achievements)}
          </p>
        </div>
        <span className="pill text-xs text-ink-faint">{expanded ? "Hide" : "Show"}</span>
      </button>
      <p className="mt-2 text-sm text-ink-dim">{notes}</p>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-white/8 pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-ink-dim">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning installs…
            </div>
          ) : games.length === 0 ? (
            <p className="text-sm text-ink-faint">No installed titles detected on this PC.</p>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                <input
                  className="input w-full pl-9"
                  placeholder="Filter…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {filtered.map((g) => {
                  const selected = picked.has(g.name);
                  return (
                    <li
                      key={`${g.name}-${g.installFolder ?? ""}`}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                        g.imported ? "opacity-60" : selected ? "bg-accent/10" : "hover:bg-base-850"
                      }`}
                      onClick={() => toggle(g.name, g.imported)}
                    >
                      <div
                        className={`flex h-4 w-4 items-center justify-center rounded border ${
                          selected ? "border-accent bg-accent text-base" : "border-white/20"
                        }`}
                      >
                        {selected && <Check className="h-2.5 w-2.5" />}
                      </div>
                      <span className="min-w-0 flex-1 truncate font-500">{g.name}</span>
                      {g.installFolder && (
                        <span title={g.installFolder}>
                          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                        </span>
                      )}
                      {g.imported && <span className="text-xs text-accent">Imported</span>}
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                className="btn btn-subtle h-9"
                disabled={picked.size === 0 || importing}
                onClick={importSelected}
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Import {picked.size} selected
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
