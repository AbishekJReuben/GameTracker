import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { Download, FileJson, Moon, Zap, Clock } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Page } from "@/components/Page";
import { GameArt } from "@/components/GameArt";
import { Card, Toggle, EmptyState, Skeleton, Segmented } from "@/components/ui";
import { useSessions, useGames } from "@/lib/queries";
import { useApp, useMotionEnabled } from "@/store/app";
import { api, EntryKind, SessionFilter } from "@/lib/api";
import { dur, dateLabel, timeLabel } from "@/lib/format";

export default function SessionsPage() {
  const { data: games } = useGames();
  const pushToast = useApp((s) => s.pushToast);
  const use24 = useApp((s) => s.prefs.timeFormat === "24h");
  const enabled = useMotionEnabled();
  const [gameId, setGameId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [minMinutes, setMinMinutes] = useState("");
  const [excludeIdle, setExcludeIdle] = useState(false);
  const [kind, setKind] = useState<EntryKind>("game");

  const filteredGames = useMemo(() => (games ?? []).filter((g) => g.kind === kind), [games, kind]);

  const filter: SessionFilter = useMemo(
    () => ({
      kind,
      gameId: gameId || null,
      fromUtc: from ? new Date(from).toISOString() : null,
      toUtc: to ? new Date(to + "T23:59:59").toISOString() : null,
      minSeconds: minMinutes ? parseInt(minMinutes, 10) * 60 : null,
      excludeIdleEnded: excludeIdle,
    }),
    [kind, gameId, from, to, minMinutes, excludeIdle]
  );

  const { data: sessions, isLoading } = useSessions(filter);

  const totals = useMemo(() => {
    const runtime = sessions?.reduce((a, s) => a + s.runtimeSeconds, 0) ?? 0;
    const active = sessions?.reduce((a, s) => a + s.activeSeconds, 0) ?? 0;
    return { runtime, active };
  }, [sessions]);

  const exportCsv = async () => {
    const path = await save({ defaultPath: "tracker-sessions.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    const n = await api.exportSessionsCsv(path);
    pushToast({ kind: "success", title: `Exported ${n} sessions` });
  };
  const exportJson = async () => {
    const path = await save({ defaultPath: "tracker-data.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    await api.exportDataJson(path);
    pushToast({ kind: "success", title: "Exported full data" });
  };

  return (
    <Page
      title="Sessions"
      subtitle={sessions ? `${sessions.length} sessions · ${dur(totals.active)} active` : "Your play log"}
      actions={
        <>
          <button onClick={exportJson} className="btn btn-ghost h-10">
            <FileJson className="h-4 w-4" /> JSON
          </button>
          <button onClick={exportCsv} className="btn btn-primary h-10">
            <Download className="h-4 w-4" /> Export CSV
          </button>
        </>
      }
    >
      <Card className="mb-5 p-4">
        <div className="mb-4">
          <Segmented
            value={kind}
            onChange={(v) => { setKind(v); setGameId(""); }}
            options={[
              { value: "game" as const, label: "Games" },
              { value: "app" as const, label: "Apps" },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Filter label={kind === "game" ? "Game" : "App"}>
            <select className="input" value={gameId} onChange={(e) => setGameId(e.target.value)}>
              <option value="">{kind === "game" ? "All games" : "All apps"}</option>
              {filteredGames.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.displayName}
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="From">
            <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Filter>
          <Filter label="To">
            <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </Filter>
          <Filter label="Min minutes">
            <input className="input w-28" inputMode="numeric" placeholder="0" value={minMinutes} onChange={(e) => setMinMinutes(e.target.value.replace(/\D/g, ""))} />
          </Filter>
          <div className="pb-2">
            <Toggle checked={excludeIdle} onChange={setExcludeIdle} label="Hide AFK-ended" />
          </div>
        </div>
      </Card>

      <Card className="p-0">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : sessions && sessions.length > 0 ? (
          <div className="overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b border-line px-5 py-3 text-[11px] font-800 uppercase tracking-wider text-ink-dim">
              <span>Game</span>
              <span className="w-32 text-right">When</span>
              <span className="w-20 text-right">Active</span>
              <span className="w-20 text-right">Runtime</span>
            </div>
            <div className="max-h-[60vh] divide-y divide-line overflow-y-auto">
              {sessions.map((s, i) => (
                <motion.div
                  key={s.id}
                  className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-5 py-2.5 transition hover:bg-white/[0.02]"
                  initial={enabled ? { opacity: 0, x: -12 } : false}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Link to={`/game/${s.gameId}`} className="flex min-w-0 items-center gap-3">
                    <GameArt id={s.gameId} name={s.gameName} cover={s.coverPath} icon={s.iconPath} accent={s.accentColor} className="h-8 w-8" rounded="rounded-lg" />
                    <span className="truncate text-sm font-700">{s.gameName}</span>
                    {s.wasIdleEnded && <Moon className="h-3.5 w-3.5 shrink-0 text-amber" />}
                  </Link>
                  <div className="w-32 text-right text-xs text-ink-dim">
                    {dateLabel(s.startUtc)}
                    <div className="text-[11px] text-ink-faint">{timeLabel(s.startUtc, use24)}</div>
                  </div>
                  <span className="flex w-20 items-center justify-end gap-1 text-right text-sm font-800 tabular-nums">
                    <Zap className="h-3 w-3 text-green" />
                    {dur(s.activeSeconds)}
                  </span>
                  <span className="flex w-20 items-center justify-end gap-1 text-right text-sm tabular-nums text-ink-soft">
                    <Clock className="h-3 w-3 text-ink-faint" />
                    {dur(s.runtimeSeconds)}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-4">
            <EmptyState title="No sessions match" message="Adjust your filters or play a tracked game." />
          </div>
        )}
      </Card>
    </Page>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[11px] font-700 text-ink-dim">{label}</div>
      {children}
    </label>
  );
}
