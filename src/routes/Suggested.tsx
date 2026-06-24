import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  Sparkles,
  RefreshCw,
  ThumbsUp,
  ThumbsDown,
  Clock,
  Calendar,
  Star,
  Gauge,
  Plus,
  Loader2,
  Wifi,
  Tag,
  Building2,
  Percent,
  X,
  EyeOff,
  RotateCcw,
} from "lucide-react";
import { Page } from "@/components/Page";
import { SectionTitle, EmptyState, Skeleton, Badge } from "@/components/ui";
import { Panel } from "@/components/Panel";
import { GameArt } from "@/components/GameArt";
import { useQueryClient } from "@tanstack/react-query";
import { useSuggestions as useSuggestionsQuery, useRefreshAll, useSettings, useGames } from "@/lib/queries";
import { useApp, useMotionEnabled } from "@/store/app";
import { api, GameSuggestion } from "@/lib/api";
import { cn } from "@/lib/cn";

function TasteChip({ label, value, icon, index }: { label: string; value: string; icon: React.ReactNode; index: number }) {
  const enabled = useMotionEnabled();
  return (
    <motion.div
      className="rounded-xl border border-line bg-white/[0.03] px-3 py-2"
      initial={enabled ? { opacity: 0, scale: 0.9 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: index * 0.05, type: "spring", stiffness: 380, damping: 24 }}
      whileHover={enabled ? { y: -2, boxShadow: "0 8px 24px -8px color-mix(in srgb, var(--accent-1) 40%, transparent)" } : undefined}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-800 uppercase tracking-wider text-ink-dim">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-display text-lg font-800 tabular-nums text-ink">{value}</div>
    </motion.div>
  );
}

function SuggestionCard({
  item,
  index,
  onAdd,
  adding,
}: {
  item: GameSuggestion;
  index: number;
  onAdd: () => void;
  adding: boolean;
}) {
  const enabled = useMotionEnabled();
  return (
    <motion.article
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.04, 0.35), duration: 0.4 }}
      whileHover={enabled ? { y: -4, boxShadow: "0 16px 40px -12px color-mix(in srgb, var(--accent-1) 35%, transparent)" } : undefined}
      className="card group overflow-hidden p-0"
    >
      <div className="flex flex-col sm:flex-row">
        <div className="relative aspect-[3/4] w-full shrink-0 overflow-hidden sm:w-36 md:w-40">
          <GameArt
            id={String(item.steamAppId)}
            name={item.name}
            cover={item.coverUrl}
            icon={item.headerImageUrl}
            steamAppId={item.steamAppId}
            className="absolute inset-0 h-full w-full"
            rounded="rounded-none"
            kenBurns
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent sm:bg-gradient-to-r" />
          <div className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-[11px] font-800 text-white backdrop-blur">
            <Percent className="h-3 w-3 text-accent-3" />
            {item.matchPercent}% match
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 sm:p-5">
          <div>
            <h3 className="font-display text-xl font-800 tracking-tight text-balance">{item.name}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-soft">
              {item.developer && <span>{item.developer}</span>}
              {item.releaseYear && (
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" /> {item.releaseYear}
                </span>
              )}
              {item.metacritic != null && (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <Gauge className="h-3.5 w-3.5" /> MC {item.metacritic}
                </span>
              )}
            </div>
          </div>
          {item.shortDescription && (
            <p className="line-clamp-2 text-sm leading-relaxed text-ink-dim">{item.shortDescription}</p>
          )}
          {item.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.genres.slice(0, 5).map((g) => (
                <Badge key={g} color="#7c5cff">
                  {g}
                </Badge>
              ))}
            </div>
          )}
          <ul className="space-y-1">
            {item.reasons.map((r) => (
              <li key={r} className="flex items-start gap-2 text-xs text-ink-soft">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-3" />
                {r}
              </li>
            ))}
          </ul>
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <button onClick={onAdd} disabled={adding} className="btn btn-primary h-9">
              {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add to backlog
            </button>
            <a
              href={`https://store.steampowered.com/app/${item.steamAppId}`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost h-9"
            >
              Steam store
            </a>
          </div>
        </div>
      </div>
    </motion.article>
  );
}

export default function SuggestedPage() {
  const { data: settings } = useSettings();
  const { data: libraryGames } = useGames();
  const online = settings?.online_metadata_enabled === "true";
  const qc = useQueryClient();
  const { data, isLoading, error, isFetching } = useSuggestionsQuery(online);
  const pushToast = useApp((s) => s.pushToast);
  const refreshAll = useRefreshAll();
  const navigate = useNavigate();
  const [addingId, setAddingId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (force = false) => {
    if (!online) {
      pushToast({ kind: "info", title: "Enable Online metadata in Settings first" });
      navigate("/settings");
      return;
    }
    setRefreshing(true);
    try {
      const result = await api.suggestGames(force);
      qc.setQueryData(["suggestions"], result);
    } catch (e) {
      pushToast({ kind: "info", title: e instanceof Error ? e.message : "Suggestion failed" });
    } finally {
      setRefreshing(false);
    }
  };

  const excludedTags = data?.excludedTags ?? [];

  const mutateExcluded = async (next: string[]) => {
    setRefreshing(true);
    try {
      await api.setSuggestedExcludedTags(next);
      const result = await api.suggestGames(true);
      qc.setQueryData(["suggestions"], result);
    } catch (e) {
      pushToast({ kind: "info", title: e instanceof Error ? e.message : "Couldn't update tags" });
    } finally {
      setRefreshing(false);
    }
  };

  const excludeTag = (tag: string) => {
    if (excludedTags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    pushToast({ kind: "info", title: `Muted “${tag}”`, message: "Refreshing picks without it" });
    mutateExcluded([...excludedTags, tag]);
  };

  const restoreTag = (tag: string) =>
    mutateExcluded(excludedTags.filter((t) => t.toLowerCase() !== tag.toLowerCase()));

  const addGame = async (item: GameSuggestion) => {
    setAddingId(item.steamAppId);
    try {
      const game = await api.addSuggestedGame({
        name: item.name,
        developer: item.developer,
        releaseYear: item.releaseYear,
        metacritic: item.metacritic,
        genres: item.genres,
        steamAppId: item.steamAppId,
      });
      refreshAll();
      pushToast({ kind: "success", title: `Added ${item.name}`, message: "Saved to your backlog" });
      navigate(`/game/${game.id}`);
    } catch {
      pushToast({ kind: "info", title: "Couldn't add game" });
    } finally {
      setAddingId(null);
    }
  };

  const busy = isLoading || isFetching || refreshing;

  return (
    <Page
      title="Suggested games"
      subtitle="Personal picks from your taste profile"
      actions={
        <button onClick={() => load(true)} disabled={busy || !online} className="btn btn-primary h-10">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {busy ? "Analyzing…" : "Refresh picks"}
        </button>
      }
    >
      {!online ? (
        <EmptyState
          icon={<Wifi className="h-6 w-6" />}
          title="Online discovery is off"
          message="Suggested games search Steam using your ratings, playtime, tags, and status. Enable Online metadata in Settings, then come back."
          action={
            <button onClick={() => navigate("/settings")} className="btn btn-primary">
              Open Settings
            </button>
          }
        />
      ) : isLoading && !data ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon={<Sparkles className="h-6 w-6" />}
          title="Couldn't build suggestions"
          message={error instanceof Error ? error.message : String(error)}
          action={
            <button onClick={() => load(true)} className="btn btn-primary">
              Try again
            </button>
          }
        />
      ) : data ? (
        <div className="space-y-6">
          <Panel panelKey="suggested.taste" games={libraryGames ?? []} className="overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-px bg-accent-sheen opacity-60" />
            <SectionTitle
              title="Your taste profile"
              subtitle={
                data.cached
                  ? "Cached results — refresh to search again"
                  : `Updated ${new Date(data.generatedAt).toLocaleString()}`
              }
            />
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              <TasteChip label="Loved" value={String(data.taste.lovedCount)} icon={<ThumbsUp className="h-3 w-3" />} index={0} />
              <TasteChip label="Disliked" value={String(data.taste.dislikedCount)} icon={<ThumbsDown className="h-3 w-3" />} index={1} />
              {data.taste.avgMyScore != null && (
                <TasteChip label="Avg my score" value={data.taste.avgMyScore.toFixed(0)} icon={<Star className="h-3 w-3" />} index={2} />
              )}
              {data.taste.avgMetacritic != null && (
                <TasteChip label="Avg MC" value={data.taste.avgMetacritic.toFixed(0)} icon={<Gauge className="h-3 w-3" />} index={3} />
              )}
              {data.taste.preferredHours != null && (
                <TasteChip label="Sweet spot" value={`${data.taste.preferredHours}h`} icon={<Clock className="h-3 w-3" />} index={4} />
              )}
              {data.taste.preferredYear != null && (
                <TasteChip label="Era" value={String(data.taste.preferredYear)} icon={<Calendar className="h-3 w-3" />} index={5} />
              )}
            </div>
            {(data.taste.topTags.length > 0 || data.taste.topDevelopers.length > 0) && (
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                {data.taste.topTags.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-800 uppercase tracking-wider text-ink-dim">
                      <Tag className="h-3.5 w-3.5" /> Top genres & tags
                      <span className="ml-1 normal-case font-600 tracking-normal text-ink-faint">— mute any to refine</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {data.taste.topTags.map((t) => (
                        <span
                          key={t.tag}
                          className={cn(
                            "pill group/tag border border-line bg-white/[0.04] text-ink-soft",
                            t.weight > 2 && "border-accent/30 text-ink"
                          )}
                        >
                          {t.tag}
                          <span className="ml-1 text-[10px] tabular-nums text-ink-dim">+{t.weight}</span>
                          <button
                            type="button"
                            onClick={() => excludeTag(t.tag)}
                            disabled={busy}
                            title={`Mute “${t.tag}” — hide it from suggestions`}
                            className="ml-1 grid h-4 w-4 place-items-center rounded-full text-ink-faint transition hover:bg-pink/20 hover:text-pink disabled:opacity-40"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {data.taste.topDevelopers.length > 0 && (
                  <div>
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-800 uppercase tracking-wider text-ink-dim">
                      <Building2 className="h-3.5 w-3.5" /> Studios you rate highly
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {data.taste.topDevelopers.map((d) => (
                        <span key={d.name} className="pill border border-line bg-white/[0.04] text-ink-soft">
                          {d.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {excludedTags.length > 0 && (
              <div className="mt-5">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-800 uppercase tracking-wider text-ink-dim">
                  <EyeOff className="h-3.5 w-3.5" /> Muted tags
                  <span className="ml-1 normal-case font-600 tracking-normal text-ink-faint">— excluded from your picks</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {excludedTags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => restoreTag(t)}
                      disabled={busy}
                      title={`Restore “${t}”`}
                      className="pill border border-line bg-pink/10 text-pink/90 transition hover:bg-pink/20 disabled:opacity-40"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <p className="mt-4 text-xs leading-relaxed text-ink-faint">
              Hybrid content-based recommendations: we weight your scores, hours played, completed vs dropped status, tags,
              developers, and critic alignment, then search Steam for matches. Inspired by research on weighted hybrid
              filtering for game libraries.
            </p>
          </Panel>

          {data.suggestions.length === 0 ? (
            <EmptyState
              title="No strong matches yet"
              message="Import more games, add tags via Get game info, and rate what you loved or dropped — then refresh."
            />
          ) : (
            <div className="space-y-4">
              <SectionTitle title={`${data.suggestions.length} suggestions`} subtitle="Ranked by taste overlap" />
              {data.suggestions.map((item, i) => (
                <SuggestionCard
                  key={item.steamAppId}
                  item={item}
                  index={i}
                  onAdd={() => addGame(item)}
                  adding={addingId === item.steamAppId}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          icon={<Sparkles className="h-6 w-6" />}
          title="Ready when you are"
          message="We'll analyze your library and search Steam for games that fit your taste."
          action={
            <button onClick={() => load(false)} className="btn btn-primary">
              Get suggestions
            </button>
          }
        />
      )}
    </Page>
  );
}
