// Renders a text note as whatever it actually is. Prose stays prose; code, JSON,
// logs, shell commands and paths each get a presentation that makes them
// readable at a glance — monospace, a quiet type badge, and horizontal scrolling
// instead of the word-wrapped mush a <p> makes of an 80-column stack trace.
import { forwardRef } from "react";
import { cn } from "@/lib/cn";
import { tokenizeCode, logSeverity, proseSegments, type ClipContent } from "@/lib/clipContent";
import { openExternalUrl } from "@/lib/linkPreview";

const TOKEN_CLASS: Record<string, string> = {
  plain: "",
  comment: "text-emerald-300/45 italic",
  string: "text-amber-200/85",
  number: "text-orange-300/85",
  keyword: "text-violet-300",
  punct: "text-ink-dim",
  meta: "text-cyan-300/80",
};

const SEVERITY_CLASS = {
  error: "text-rose-300",
  warn: "text-amber-300/90",
  info: "text-ink-dim",
  plain: "",
} as const;

/** Accent per block type — the stripe is the fastest "what is this" signal. */
const ACCENT: Record<string, string> = {
  code: "border-violet-400/35",
  json: "border-sky-400/35",
  log: "border-rose-400/35",
  command: "border-emerald-400/35",
  path: "border-cyan-400/30",
};

function CodeLines({ text }: { text: string }) {
  return (
    <>
      {tokenizeCode(text).map((t, i) => (
        <span key={i} className={TOKEN_CLASS[t.type]}>
          {t.text}
        </span>
      ))}
    </>
  );
}

/**
 * Prose with its URLs turned into real links — blue and underlined, the way a
 * link is supposed to look, whether it's the whole note or buried mid-sentence.
 * Opening goes through the same native handler the preview card uses, so it
 * works from the overlay WebView too.
 */
const MARK_CLASS = {
  bold: "font-700 text-ink",
  italic: "italic text-ink/90",
  strike: "line-through text-ink-dim",
  code: "rounded bg-white/[0.08] px-1 py-px font-mono text-[0.92em] text-cyan-100",
  bullet: "font-700 text-accent-2",
  quote: "border-l-2 border-white/15 pl-2 text-ink-dim",
} as const;

function ProseText({ text }: { text: string }) {
  const segments = proseSegments(text);
  if (segments.length === 1 && !segments[0].url && !segments[0].mark) return <>{text}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.url ? (
          <a
            key={i}
            href={seg.url}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void openExternalUrl(seg.url!);
            }}
            title={seg.url}
            className="cursor-pointer text-sky-400 underline decoration-sky-400/45 underline-offset-2 transition-colors hover:text-sky-300 hover:decoration-sky-300"
          >
            {seg.text}
          </a>
        ) : (
          <span key={i} className={seg.mark ? MARK_CLASS[seg.mark] : undefined}>
            {seg.text}
          </span>
        ),
      )}
    </>
  );
}

function LogLines({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <span key={i} className={cn("block", SEVERITY_CLASS[logSeverity(line)])}>
          {line || " "}
        </span>
      ))}
    </>
  );
}

export interface ClipBodyProps {
  text: string;
  content: ClipContent;
  expanded: boolean;
  /** Collapsed height budget, in text lines. */
  collapsedLines: number;
}

/**
 * The ref lands on the scrolling/clamping element so the caller can measure
 * whether the collapsed view is actually hiding anything.
 */
export const ClipBody = forwardRef<HTMLElement, ClipBodyProps>(function ClipBody(
  { text, content, expanded, collapsedLines },
  ref,
) {
  if (!content.mono) {
    // A third of all notes are a single short line — a name, a code, a reminder.
    // Setting those as a runt paragraph wastes them; at title weight they read
    // as the label they are, and the list gets a rhythm instead of a grey wall.
    const isTitle = !text.includes("\n") && text.trim().length <= 60;
    return (
      <p
        ref={ref as React.Ref<HTMLParagraphElement>}
        className={cn(
          // Prose wants a little more air and a slightly softer ink than UI text:
          // these notes are read, not scanned. `break-words` (not `break-all`)
          // keeps words whole and only breaks the 300-character tracking URLs.
          "m-0 whitespace-pre-wrap break-words text-[13.5px] leading-[1.65] tracking-[0.006em] text-ink/95",
          "[hyphens:auto] [overflow-wrap:anywhere]",
          expanded ? "max-h-[52vh] overflow-y-auto pr-1" : "overflow-hidden",
          // Last, so these win the merge against the prose defaults above.
          isTitle && "text-[15px] font-600 leading-snug tracking-normal text-ink",
        )}
        style={
          expanded
            ? undefined
            : ({ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: collapsedLines } as React.CSSProperties)
        }
      >
        <ProseText text={text || "(empty)"} />
      </p>
    );
  }

  // A shell command is one line by definition — give it the prompt treatment
  // rather than a block, so it reads as something you run.
  if (content.kind === "command") {
    return (
      <code
        ref={ref as React.Ref<HTMLElement>}
        className="flex items-center gap-2 overflow-x-auto rounded-lg border-l-2 border-emerald-400/40 bg-black/25 px-2.5 py-1.5 font-mono text-[12.5px] text-emerald-100 [scrollbar-width:thin]"
      >
        <span className="select-none text-emerald-400/70">$</span>
        <span className="whitespace-pre">{text}</span>
      </code>
    );
  }

  if (content.kind === "path") {
    return (
      <code
        ref={ref as React.Ref<HTMLElement>}
        className="block overflow-x-auto rounded-lg border-l-2 border-cyan-400/30 bg-black/20 px-2.5 py-1.5 font-mono text-[12px] text-cyan-100/90 [scrollbar-width:thin]"
      >
        <span className="whitespace-pre">{text}</span>
      </code>
    );
  }

  // Code / JSON / log: a real block. Not line-clamped — `-webkit-line-clamp`
  // can't clamp a scrolling <pre> without eating its horizontal scroll — so the
  // collapsed state is a max-height in em, which keeps long lines intact.
  return (
    <div className={cn("relative overflow-hidden rounded-lg border-l-2 bg-black/25", ACCENT[content.kind])}>
      {content.label && (
        <span className="pointer-events-none absolute right-1.5 top-1 z-10 rounded bg-black/45 px-1.5 py-px text-[9px] font-700 uppercase tracking-wider text-ink-faint backdrop-blur-sm">
          {content.label}
        </span>
      )}
      <pre
        ref={ref as React.Ref<HTMLPreElement>}
        className={cn(
          "m-0 overflow-auto px-2.5 py-2 font-mono text-[12px] leading-[1.55] text-ink [scrollbar-width:thin]",
          expanded ? "max-h-[52vh]" : "",
        )}
        style={expanded ? undefined : { maxHeight: `${collapsedLines * 1.55}em` }}
      >
        {content.kind === "log" ? <LogLines text={text} /> : <CodeLines text={text} />}
      </pre>
    </div>
  );
});
