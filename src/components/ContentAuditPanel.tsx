import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Search, Download, AlertCircle, CheckCircle2, MinusCircle, Wrench } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@/lib/tauri";
import { api, type ContentAuditRow, type RepairSummary } from "@/lib/api";
import { Card, SectionTitle } from "@/components/ui";
import { useApp } from "@/store/app";
import { useRefreshAll } from "@/lib/queries";

const PROBE_ORDER = ["cover", "steam", "metacritic", "hltb", "trailer", "theme", "website", "steamReviews"];

function statusIcon(status: string) {
  if (status === "available" || status === "stored") return <CheckCircle2 className="h-3.5 w-3.5 text-green" />;
  if (status === "missing" || status === "error") return <AlertCircle className="h-3.5 w-3.5 text-pink" />;
  return <MinusCircle className="h-3.5 w-3.5 text-ink-faint" />;
}

function toCsv(rows: ContentAuditRow[]): string {
  const headers = ["name", "kind", ...PROBE_ORDER];
  const lines = [headers.join(",")];
  for (const row of rows) {
    const byKey = Object.fromEntries(row.probes.map((p) => [p.key, p]));
    const cells = [
      `"${row.displayName.replace(/"/g, '""')}"`,
      row.kind,
      ...PROBE_ORDER.map((k) => {
        const p = byKey[k];
        const val = p ? `${p.status}${p.detail ? `: ${p.detail}` : ""}` : "";
        return `"${val.replace(/"/g, '""')}"`;
      }),
    ];
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

type AuditProgress = { done: number; total: number; name: string };
type BusyMode = "audit" | "repair" | null;

export function ContentAuditPanel() {
  const pushToast = useApp((s) => s.pushToast);
  const refresh = useRefreshAll();
  const [busy, setBusy] = useState<BusyMode>(null);
  const [progress, setProgress] = useState<AuditProgress | null>(null);
  const [rows, setRows] = useState<ContentAuditRow[] | null>(null);
  const [missingOnly, setMissingOnly] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const unsubs: Array<() => void> = [];
    void (async () => {
      unsubs.push(
        await listen<AuditProgress>("audit://progress", (e) => {
          setProgress(e.payload);
        })
      );
      unsubs.push(
        await listen<ContentAuditRow[]>("audit://complete", (e) => {
          const result = e.payload;
          setRows(result);
          setBusy(null);
          setProgress(null);
          const missing = result.reduce(
            (n, r) => n + r.probes.filter((p) => p.status === "missing" || p.status === "error").length,
            0
          );
          pushToast({ kind: "success", title: `Audited ${result.length} entries`, message: `${missing} gaps found` });
        })
      );
      unsubs.push(
        await listen<string>("audit://error", (e) => {
          setBusy(null);
          setProgress(null);
          pushToast({ kind: "info", title: "Audit failed", message: e.payload });
        })
      );
      unsubs.push(
        await listen<AuditProgress>("repair://progress", (e) => {
          setProgress(e.payload);
        })
      );
      unsubs.push(
        await listen<RepairSummary[]>("repair://complete", async (e) => {
          const summaries = e.payload;
          const fixed = summaries.filter((s) => s.fixes.length > 0).length;
          const changes = summaries.reduce((n, s) => n + s.fixes.length, 0);
          refresh();
          pushToast({
            kind: "success",
            title: `Repaired ${fixed} entries`,
            message: changes > 0 ? `${changes} fields updated — re-auditing…` : "Nothing needed updating",
          });
          if (changes > 0) {
            setBusy("audit");
            setProgress({ done: 0, total: 0, name: "Re-auditing…" });
            try {
              await api.auditOnlineContent();
            } catch (err) {
              setBusy(null);
              setProgress(null);
              pushToast({ kind: "info", title: "Re-audit failed", message: String(err) });
            }
          } else {
            setBusy(null);
            setProgress(null);
          }
        })
      );
      unsubs.push(
        await listen<string>("repair://error", (e) => {
          setBusy(null);
          setProgress(null);
          pushToast({ kind: "info", title: "Repair failed", message: e.payload });
        })
      );
    })();
    return () => unsubs.forEach((u) => u());
  }, [pushToast, refresh]);

  const run = async () => {
    setBusy("audit");
    setProgress({ done: 0, total: 0, name: "Starting…" });
    try {
      await api.auditOnlineContent();
    } catch (e) {
      setBusy(null);
      setProgress(null);
      pushToast({ kind: "info", title: "Audit failed", message: String(e) });
    }
  };

  const repair = async () => {
    setBusy("repair");
    setProgress({ done: 0, total: 0, name: "Starting…" });
    try {
      await api.repairLibraryContent();
    } catch (e) {
      setBusy(null);
      setProgress(null);
      pushToast({ kind: "info", title: "Repair failed", message: String(e) });
    }
  };

  const exportCsv = async () => {
    if (!rows?.length || !isTauri()) return;
    const path = await save({ defaultPath: "tracker-content-audit.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    await api.writeTextFile(path, toCsv(rows));
    pushToast({ kind: "success", title: "Audit exported" });
  };

  const filtered = useMemo(() => {
    if (!rows) return null;
    if (!missingOnly) return rows;
    return rows.filter((r) => r.probes.some((p) => p.status === "missing" || p.status === "error"));
  }, [rows, missingOnly]);

  const summary = useMemo(() => {
    if (!rows) return null;
    let ok = 0;
    let miss = 0;
    for (const r of rows) {
      for (const p of r.probes) {
        if (p.status === "n/a") continue;
        if (p.status === "available" || p.status === "stored") ok++;
        else miss++;
      }
    }
    return { ok, miss, total: rows.length };
  }, [rows]);

  const progressLabel =
    progress && progress.total > 0
      ? `${progress.done + 1}/${progress.total} · ${progress.name}`
      : progress?.name ?? "Testing…";

  return (
    <Card className="mt-4">
      <SectionTitle
        title="Online content audit"
        subtitle="Probe every game & app for covers, Steam, Metacritic, HLTB, trailers, themes & websites. Repair re-fetches bad Steam IDs, Metacritic slugs, trailers & websites."
        right={
          <div className="flex flex-wrap items-center gap-2">
            {rows && (
              <button type="button" onClick={() => setMissingOnly((v) => !v)} className="btn btn-ghost h-8 text-xs">
                {missingOnly ? "Show all" : "Gaps only"}
              </button>
            )}
            {rows && isTauri() && (
              <button type="button" onClick={exportCsv} className="btn btn-subtle h-8 text-xs">
                <Download className="h-3.5 w-3.5" /> Export CSV
              </button>
            )}
            <button
              type="button"
              onClick={repair}
              disabled={!!busy || !isTauri()}
              className="btn btn-subtle h-8 text-xs"
              title="Re-resolve Steam app IDs, Metacritic slugs, trailers, websites & themes"
            >
              {busy === "repair" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
              {busy === "repair" ? progressLabel : "Repair library"}
            </button>
            <button type="button" onClick={run} disabled={!!busy || !isTauri()} className="btn btn-primary h-8 text-xs">
              {busy === "audit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              {busy === "audit" ? progressLabel : "Run audit"}
            </button>
          </div>
        }
      />
      {!isTauri() && <p className="mt-3 text-xs text-ink-dim">Available in the desktop app only.</p>}
      {busy && progress && (
        <p className="mt-3 text-xs text-ink-dim">
          {busy === "repair" ? "Repairing" : "Probing"}{" "}
          <span className="font-700 text-ink-soft">{progressLabel}</span> — app stays responsive
        </p>
      )}
      {summary && (
        <p className="mt-3 text-xs text-ink-dim">
          <span className="font-700 text-green">{summary.ok}</span> sources found ·{" "}
          <span className="font-700 text-pink">{summary.miss}</span> gaps across{" "}
          <span className="font-700 text-ink-soft">{summary.total}</span> entries
        </p>
      )}
      {filtered && filtered.length > 0 && (
        <div className="mt-4 max-h-[420px] overflow-auto rounded-xl border border-line">
          <table className="w-full min-w-[640px] text-left text-[11px]">
            <thead className="sticky top-0 bg-bg-850/95 text-ink-dim backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-700">Name</th>
                <th className="px-3 py-2 font-700">Kind</th>
                {PROBE_ORDER.map((k) => (
                  <th key={k} className="px-2 py-2 font-600 capitalize">
                    {k === "steamReviews" ? "Reviews" : k === "hltb" ? "HLTB" : k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const byKey = Object.fromEntries(row.probes.map((p) => [p.key, p]));
                return (
                  <tr key={row.gameId} className="border-t border-line/60 hover:bg-white/[0.02]">
                    <td className="px-3 py-2">
                      <Link to={`/game/${row.gameId}`} className="font-700 text-ink-soft hover:text-ink">
                        {row.displayName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-ink-dim">{row.kind}</td>
                    {PROBE_ORDER.map((k) => {
                      const p = byKey[k];
                      if (!p) return <td key={k} className="px-2 py-2 text-ink-faint">—</td>;
                      return (
                        <td key={k} className="px-2 py-2" title={p.detail ?? undefined}>
                          <span className="inline-flex items-center gap-1">
                            {statusIcon(p.status)}
                            <span className={p.status === "missing" ? "text-pink" : p.status === "n/a" ? "text-ink-faint" : "text-ink-soft"}>
                              {p.status}
                            </span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {filtered && filtered.length === 0 && (
        <p className="mt-4 text-xs text-ink-dim">No gaps — everything probed looks good.</p>
      )}
    </Card>
  );
}
