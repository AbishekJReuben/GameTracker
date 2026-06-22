import { useEffect, useRef, useState } from "react";
import { Film } from "lucide-react";
import { assetUrl } from "@/lib/api";
import { Card, SectionTitle } from "@/components/ui";
import { cn } from "@/lib/cn";

type Props = {
  url: string;
  poster?: string | null;
  name: string;
  className?: string;
  onPlayingChange?: (playing: boolean) => void;
};

/**
 * Inline game trailer (Steam-hosted mp4, streamed straight from the CDN — never
 * downloaded). Autoplays with sound when scrolled into view; pauses when it leaves.
 * Notifies the parent so the theme player can duck while the trailer runs.
 */
export function TrailerPanel({ url, poster, name, className, onPlayingChange }: Props) {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const notify = (playing: boolean) => onPlayingChange?.(playing);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: 0.5 }
    );
    io.observe(video);
    return () => io.disconnect();
  }, [url]);

  if (failed) return null;

  const posterUrl = assetUrl(poster) ?? undefined;
  const isWebm = /\.webm(\?|$)/i.test(url);
  const fallback = url.includes("movie_max") ? url.replace("movie_max", "movie480") : null;

  return (
    <Card className={cn(className)}>
      <SectionTitle
        title="Trailer"
        subtitle={`${name} — plays with sound when in view`}
        right={
          <span className="pill inline-flex items-center gap-1 border border-line bg-white/[0.06] text-ink-soft">
            <Film className="h-3 w-3" /> Steam
          </span>
        }
      />
      <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-black shadow-card">
        <video
          ref={videoRef}
          key={url}
          className="aspect-video w-full"
          controls
          loop
          preload="metadata"
          poster={posterUrl}
          playsInline
          onPlay={() => notify(true)}
          onPause={() => notify(false)}
          onEnded={() => notify(false)}
          onError={() => setFailed(true)}
        >
          <source src={url} type={isWebm ? "video/webm" : "video/mp4"} />
          {fallback && <source src={fallback} type="video/mp4" />}
        </video>
      </div>
    </Card>
  );
}
