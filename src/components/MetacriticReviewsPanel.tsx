import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Star } from "lucide-react";
import { api, MetacriticReview } from "@/lib/api";
import { SectionTitle, Skeleton } from "@/components/ui";
import { ReviewCard } from "@/components/ReviewCard";

type Props = {
  gameId: string;
  gameName: string;
  metacriticSlug: string | null;
};

export function MetacriticReviewsPanel({ gameId, gameName, metacriticSlug }: Props) {
  const [reviews, setReviews] = useState<MetacriticReview[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState(metacriticSlug);

  useEffect(() => {
    setSlug(metacriticSlug);
  }, [metacriticSlug]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .fetchMetacriticReviews(gameId, slug)
      .then((r) => {
        setReviews(r);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [gameId, slug]);

  const pageUrl = slug ? `https://www.metacritic.com/game/${slug}/user-reviews/` : `https://www.metacritic.com/search/game/${encodeURIComponent(gameName)}/results/`;

  return (
    <div>
      <SectionTitle
        title="Metacritic reviews"
        subtitle="Recent user reviews"
        right={
          <a href={pageUrl} target="_blank" rel="noreferrer" className="btn btn-ghost h-8 text-xs">
            <ExternalLink className="h-3.5 w-3.5" /> Metacritic
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
        <p className="pt-2 text-sm text-ink-dim">Could not load Metacritic reviews for {gameName}.</p>
      ) : !reviews?.length ? (
        <p className="pt-2 text-sm text-ink-dim">No Metacritic user reviews returned.</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {reviews.map((r, i) => (
            <ReviewCard
              key={i}
              header={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {r.score != null && (
                    <span className="inline-flex items-center gap-1 font-800 text-emerald-400">
                      <Star className="h-3.5 w-3.5 fill-current" /> {r.score}
                    </span>
                  )}
                  <span className="font-700 text-ink-soft">{r.author}</span>
                  {r.date && <span>· {r.date}</span>}
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
