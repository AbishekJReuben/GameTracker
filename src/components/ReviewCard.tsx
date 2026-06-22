import { useState } from "react";
import { cn } from "@/lib/cn";

type Props = {
  header: React.ReactNode;
  text: string;
  clamp?: number;
  className?: string;
};

export function ReviewCard({ header, text, clamp = 5, className }: Props) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 180;

  return (
    <article className={cn("flex h-full flex-col rounded-xl border border-line bg-white/[0.03] p-4", className)}>
      <div className="mb-2 text-xs text-ink-dim">{header}</div>
      <p className={cn("flex-1 text-sm leading-relaxed text-ink-soft", !expanded && `line-clamp-${clamp}`)} style={!expanded ? { WebkitLineClamp: clamp, display: "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}>
        {text}
      </p>
      {long && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-2 self-start text-[11px] font-700 text-accent-3 hover:underline">
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </article>
  );
}
