import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Tag, Search, Star, Trophy, Clock, ArrowRight } from "lucide-react";
import { Page } from "@/components/Page";
import { Card, SectionTitle, EmptyState, Skeleton } from "@/components/ui";
import { LevelBar } from "@/components/RadialGauge";
import { MarqueeFX, MarqueeCard } from "@/components/MarqueeFX";
import { useGames, useTagAnalytics } from "@/lib/queries";
import { dur } from "@/lib/format";

export default function TagsPage() {
  const { data, isLoading } = useTagAnalytics();
  const { data: games } = useGames();
  const [q, setQ] = useState("");
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const list = data ?? [];
    if (!q.trim()) return list;
    const needle = q.toLowerCase();
    return list.filter((t) => t.tag.toLowerCase().includes(needle));
  }, [data, q]);

  const maxPlay = Math.max(1, ...(data ?? []).map((t) => t.activeSeconds));

  const openTag = (tag: string) => {
    navigate("/library", { state: { tag } });
  };

  return (
    <Page title="Tags" subtitle="Genres and labels across your library">
      <div className="space-y-6">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
          <input
            className="input w-full pl-10"
            placeholder="Filter tags…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-36 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Tag className="h-6 w-6" />}
            title={q ? "No matching tags" : "No tags yet"}
            message="Add tags when editing games, or fetch game info from Steam to import genres automatically."
          />
        ) : (
          <div className="relative overflow-hidden rounded-3xl">
            <MarqueeFX variant="drift" games={games ?? []} className="rounded-3xl" />
            <div className="relative z-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((t, i) => (
              <motion.button
                key={t.tag}
                type="button"
                onClick={() => openTag(t.tag)}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04, duration: 0.4 }}
                className="card group relative overflow-hidden p-4 text-left transition hover:-translate-y-0.5 hover:shadow-float"
              >
                <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-accent-violet/15 blur-2xl transition group-hover:bg-accent-cyan/20" />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-display text-lg font-800 text-ink">{t.tag}</div>
                    <div className="mt-1 text-xs text-ink-dim">
                      {t.gameCount} {t.gameCount === 1 ? "game" : "games"}
                      {t.completedCount > 0 && ` · ${t.completedCount} completed`}
                    </div>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint transition group-hover:text-accent-3" />
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-ink-soft">
                    <Clock className="h-3.5 w-3.5" />
                    {dur(t.activeSeconds)} played
                  </div>
                  <LevelBar value={t.activeSeconds} max={maxPlay} delay={i * 0.03} />
                  <div className="flex items-center justify-between text-[11px] text-ink-dim">
                    <span className="inline-flex items-center gap-1">
                      <Trophy className="h-3 w-3" />
                      {t.completedCount} done
                    </span>
                    {t.avgRating > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Star className="h-3 w-3 fill-amber text-amber" />
                        avg {t.avgRating.toFixed(0)}
                      </span>
                    )}
                  </div>
                </div>
              </motion.button>
            ))}
            </div>
          </div>
        )}

        <MarqueeCard variant="shader" games={games ?? []}>
          <SectionTitle title="Tip" subtitle="Tags power Collection analytics" />
          <p className="text-sm text-ink-soft">
            Tags appear on the{" "}
            <Link to="/collection" className="font-700 text-accent-3 hover:underline">
              Collection
            </Link>{" "}
            genre radar and breakdown charts. Use{" "}
            <span className="font-700 text-ink">Get game info</span> in Library to pull Steam genres, or add custom tags when editing any game.
          </p>
        </MarqueeCard>
      </div>
    </Page>
  );
}
