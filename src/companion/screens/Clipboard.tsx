import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  NotebookPen,
  ClipboardPaste,
  ImageDown,
  Check,
  Layers,
  BatteryCharging,
  Bell,
  Power,
  Search,
  Trash2,
} from "lucide-react";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/cn";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { EmptyState } from "@/components/ui";
import { Composer, type ComposerEdit } from "@/features/clipboard/Composer";
import { ClipboardList as ClipList } from "@/features/clipboard/ClipboardList";
import { TagChips, TypeChips } from "@/features/clipboard/ClipboardPanel";
import { classifyClip, type ClipContentKind } from "@/lib/clipContent";
import { useCompanionClip, companionTranscribe, LS_SARVAM_KEY } from "../clipboardCompanion";
import type { ClipItem } from "@/lib/clip";

type Filter = "all" | "text" | "image";
const FILTERS: Filter[] = ["all", "text", "image"];

function PermRow({
  icon,
  title,
  desc,
  granted,
  onGrant,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  granted: boolean;
  onGrant: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-accent-3">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-700 text-ink">{title}</div>
        <div className="text-[11px] text-ink-dim">{desc}</div>
      </div>
      {granted ? (
        <span className="flex items-center gap-1 text-xs font-700 text-emerald-400">
          <Check className="h-4 w-4" /> On
        </span>
      ) : (
        <button onClick={onGrant} className="btn-primary px-3 py-1.5 text-xs">
          Grant
        </button>
      )}
    </div>
  );
}

export default function ClipboardScreen() {
  const s = useCompanionClip();
  const [perms, setPerms] = useState({ overlay: true, battery: true, notif: true });
  const [pasted, setPasted] = useState<"" | "text" | "image" | "none">("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<ClipContentKind | null>(null);
  const [editing, setEditing] = useState<ComposerEdit | null>(null);
  const android = isTauri();
  // Sarvam mic is available whenever a key is saved on this device; the Composer
  // also offers the browser's built-in recognition when present.
  const sttEnabled = !!(localStorage.getItem(LS_SARVAM_KEY) || "").trim();

  const refreshPerms = async () => {
    if (!android) return;
    try {
      const [overlay, battery, notif] = await Promise.all([
        invoke<boolean>("clipboard_overlay_status"),
        invoke<boolean>("clipboard_battery_status"),
        invoke<boolean>("clipboard_notif_status"),
      ]);
      setPerms({ overlay, battery, notif });
    } catch {
      /* not android / bridge missing */
    }
  };

  useEffect(() => {
    s.init();
    refreshPerms();
    const onFocus = () => refreshPerms();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startWidget = async () => {
    if (!android) return;
    const secret = localStorage.getItem("gt.remote.secret") || "";
    const signalUrl = localStorage.getItem("gt.remote.signal") || DEFAULT_SIGNAL_URL;
    await invoke("clipboard_service_start", {
      enabled: true,
      secret,
      deviceId: s.deviceId,
      signalUrl,
      sarvamKey: (localStorage.getItem(LS_SARVAM_KEY) || "").trim(),
    }).catch(() => {});
    refreshPerms();
  };

  const flashPasted = (kind: "text" | "image" | "none") => {
    setPasted(kind);
    setTimeout(() => setPasted(""), 1400);
  };

  /** Paste TEXT from the OS clipboard as a note (deduped against the newest note). */
  const pasteText = async () => {
    const t = (await s.captureClipboard()).trim();
    if (!t) {
      flashPasted("none");
      return;
    }
    const newest = s.items.find((i) => i.kind === "text");
    if (newest?.text === t) {
      flashPasted("text"); // already the latest note — treat as done, no dupe
      return;
    }
    await s.addText(t, tagFilter ? [tagFilter] : []);
    flashPasted("text");
  };

  /** Paste an IMAGE from the OS clipboard. */
  const pasteImage = async () => {
    const dataUrl = await s.captureClipboardImage();
    if (!dataUrl) {
      flashPasted("none");
      return;
    }
    await s.addImage(dataUrl, tagFilter ? [tagFilter] : []);
    flashPasted("image");
  };

  const tags = s.tags;

  const q = search.trim().toLowerCase();
  const match = (i: ClipItem) => {
    if (filter !== "all" && i.kind !== filter) return false;
    if (tagFilter !== null && !(i.tags ?? []).some((t) => t.toLowerCase() === tagFilter.toLowerCase())) return false;
    if (typeFilter !== null && (i.kind !== "text" || classifyClip(i.text).kind !== typeFilter)) return false;
    if (!q) return true;
    return (i.text ?? "").toLowerCase().includes(q) ||
      (i.deviceName ?? "").toLowerCase().includes(q) ||
      (i.tags ?? []).some((tag) => tag.toLowerCase().includes(q));
  };
  const pinned = s.items.filter((i) => i.pinned && match(i));
  const rest = s.items.filter((i) => !i.pinned && match(i));
  const needsSetup = android && (!perms.overlay || !perms.battery || !perms.notif);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent-sheen text-white">
          <NotebookPen className="h-4 w-4" />
        </span>
        <div>
          <div className="text-base font-800 text-ink">Notes</div>
          <div className="text-[11px] text-ink-dim">
            {s.ready
              ? s.connected
                ? `Synced · ${new Set(s.items.map((i) => i.deviceId)).size || 1} device${new Set(s.items.map((i) => i.deviceId)).size === 1 ? "" : "s"}`
                : "Connecting…"
              : "Set your key in More → Remote to sync"}
          </div>
        </div>
      </div>

      {needsSetup && (
        <div className="space-y-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-2.5">
          <div className="px-1 text-[11px] font-700 text-ink-soft">Finish setup — keeps sync running in the background</div>
          <PermRow
            icon={<Layers className="h-4 w-4" />}
            title="Draw over apps"
            desc="The floating notes dock on top of everything."
            granted={perms.overlay}
            onGrant={() => invoke("clipboard_request_overlay")}
          />
          <PermRow
            icon={<BatteryCharging className="h-4 w-4" />}
            title="Keep running"
            desc="Battery exemption so sync survives Doze."
            granted={perms.battery}
            onGrant={() => invoke("clipboard_request_battery")}
          />
          <PermRow
            icon={<Bell className="h-4 w-4" />}
            title="Notifications"
            desc="Shows the always-on service badge."
            granted={perms.notif}
            onGrant={() => invoke("clipboard_request_notif")}
          />
          <button onClick={startWidget} className="btn-primary flex w-full items-center justify-center gap-2 py-2 text-sm">
            <Power className="h-4 w-4" /> Turn on floating widget
          </button>
        </div>
      )}

      <Composer
        onAddText={(t) => void s.addText(t, tagFilter ? [tagFilter] : [])}
        onAddImage={(b64) => void s.addImage(b64, tagFilter ? [tagFilter] : [])}
        sttEnabled={sttEnabled}
        transcribe={companionTranscribe}
        draftKey="gt.clip.draft.companion"
        editing={editing}
        onSaveEdit={(id, text) => void s.editText(id, text)}
        onCancelEdit={() => setEditing(null)}
      />

      <div className="flex items-center gap-1.5">
        <button
          onClick={pasteText}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] py-1.5 text-[11px] font-600 text-ink-soft active:scale-[0.98]"
        >
          {pasted === "text" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <ClipboardPaste className="h-3.5 w-3.5" />}
          {pasted === "text" ? "Added" : pasted === "none" ? "Clipboard empty" : "Paste text"}
        </button>
        <button
          onClick={pasteImage}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] py-1.5 text-[11px] font-600 text-ink-soft active:scale-[0.98]"
        >
          {pasted === "image" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <ImageDown className="h-3.5 w-3.5" />}
          {pasted === "image" ? "Added" : "Paste image"}
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes"
            className="input w-full py-1 pl-6 text-[11px]"
          />
        </div>
        <div className="flex shrink-0 rounded-lg bg-white/[0.04] p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[10px] font-600 capitalize transition-colors",
                filter === f ? "bg-white/10 text-ink" : "text-ink-dim hover:text-ink-soft",
              )}
            >
              {f === "image" ? "Images" : f}
            </button>
          ))}
        </div>
      </div>

      <TagChips tags={tags} active={tagFilter} onPick={setTagFilter} />
      <TypeChips items={s.items} active={typeFilter} onPick={setTypeFilter} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {pinned.length === 0 && rest.length === 0 ? (
          <EmptyState
            icon={<NotebookPen className="h-6 w-6" />}
            title={s.items.length === 0 ? "Nothing here yet" : "No matches"}
            message={
              s.items.length === 0
                ? "Copy on your PC and it appears here, or jot a note above."
                : "Try a different search or filter."
            }
          />
        ) : (
          <ClipList
            pinned={pinned}
            rest={rest}
            loading={false}
            hasMore={false}
            onCopy={s.copy}
            onDelete={s.remove}
            onTogglePin={s.togglePin}
            onEdit={(item) => item.kind === "text" && setEditing({ id: item.id, text: item.text ?? "" })}
            onSetTags={(id, tags) => void s.setTags(id, tags)}
            knownTags={tags}
            onLoadMore={() => {}}
            compact
            showHistory
          />
        )}
      </div>

      {s.items.length > 0 && (
        <button
          onClick={() => {
            if (confirm("Clear this device's notes view? (Other devices keep theirs.)")) {
              for (const it of [...s.items]) void s.remove(it.id);
            }
          }}
          className="flex items-center justify-center gap-1.5 rounded-xl py-1.5 text-[11px] font-600 text-ink-faint active:scale-[0.99]"
        >
          <Trash2 className="h-3.5 w-3.5" /> Clear history
        </button>
      )}
    </div>
  );
}
