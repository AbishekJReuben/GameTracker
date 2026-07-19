import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Search, Clipboard } from "lucide-react";
import { cn } from "@/lib/cn";
import { useClipboard, visibleClips, type ClipFilter } from "@/store/clipboard";
import { EmptyState } from "@/components/ui";
import { Composer } from "./Composer";
import { ClipboardList } from "./ClipboardList";

const FILTERS: ClipFilter[] = ["all", "text", "image"];

export function ClipboardPanel({
  compact,
  sttEnabled,
}: {
  compact?: boolean;
  sttEnabled: boolean;
}) {
  const s = useClipboard();
  const { pinned, rest } = visibleClips(s);

  useEffect(() => {
    s.load();
    const un = listen("clipboard://changed", () => s.refresh());
    return () => {
      un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <Composer onAddText={s.addText} onAddImage={s.addImage} sttEnabled={sttEnabled} />

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={s.search}
            onChange={(e) => s.setSearch(e.target.value)}
            placeholder="Search history"
            className="input w-full py-1.5 pl-8 text-xs"
          />
        </div>
        <div className="flex rounded-lg bg-white/[0.04] p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => s.setFilter(f)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] font-600 capitalize transition-colors",
                s.filter === f ? "bg-white/10 text-ink" : "text-ink-dim hover:text-ink-soft",
              )}
            >
              {f === "image" ? "Images" : f}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
        {pinned.length === 0 && rest.length === 0 && !s.loading ? (
          <EmptyState
            icon={<Clipboard className="h-6 w-6" />}
            title="Nothing here yet"
            message="Copy anything — or add it above. It stays here forever and syncs to your other devices."
          />
        ) : (
          <ClipboardList
            pinned={pinned}
            rest={rest}
            loading={s.loading}
            hasMore={s.hasMore}
            onCopy={s.copy}
            onDelete={s.remove}
            onTogglePin={s.togglePin}
            onLoadMore={s.loadMore}
            compact={compact}
          />
        )}
      </div>
    </div>
  );
}
