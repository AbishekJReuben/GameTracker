import { useEffect, useState } from "react";
import { ThumbsUp, ThumbsDown, ExternalLink } from "lucide-react";
import { api, SteamReview } from "@/lib/api";
import { SectionTitle, Skeleton } from "@/components/ui";
import { ReviewCard } from "@/components/ReviewCard";

type Props = {
  steamAppId: number | null;
  gameName: string;
};

export function SteamReviewsPanel({ steamAppId, gameName }: Props) {
  const [reviews, setReviews] = useState<SteamReview[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!steamAppId) return;
    setLoading(true);
    setError(null);
    api
      .fetchSteamReviews(steamAppId)
      .then(setReviews)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [steamAppId]);

  if (!steamAppId) return null;

  const storeUrl = `https://store.steampowered.com/app/${steamAppId}/`;

  return (
    <div>
      <SectionTitle
        title="Steam reviews"
        subtitle="Recent player reviews"
        right={
          <a href={storeUrl} target="_blank" rel="noreferrer" className="btn btn-ghost h-8 text-xs">
            <ExternalLink className="h-3.5 w-3.5" /> Store page
          </a>
        }
      />
      {loading ? (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : error ? (
        <p className="pt-2 text-sm text-ink-dim">Could not load reviews for {gameName}.</p>
      ) : !reviews?.length ? (
        <p className="pt-2 text-sm text-ink-dim">No reviews returned from Steam.</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {reviews.map((r, i) => (
            <ReviewCard
              key={i}
              header={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {r.votedUp ? (
                    <span className="inline-flex items-center gap-1 text-emerald-400">
                      <ThumbsUp className="h-3.5 w-3.5" /> Recommended
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-rose-400">
                      <ThumbsDown className="h-3.5 w-3.5" /> Not recommended
                    </span>
                  )}
                  <span>· {r.votesUp} found helpful</span>
                </span>
              }
              text={r.text}
            />
          ))}
        </div>
      )}
    </div>
  );
}
