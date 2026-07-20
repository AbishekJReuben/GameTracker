import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClipboardList, ClipboardPaste, Check, Layers, BatteryCharging, Bell, Power, Search, Trash2 } from "lucide-react";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/cn";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { EmptyState } from "@/components/ui";
import { Composer } from "@/features/clipboard/Composer";
import { ClipboardList as ClipList } from "@/features/clipboard/ClipboardList";
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
  const [captured, setCaptured] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const android = isTauri();
  // Mic is available whenever a Sarvam key is saved on this device (synced from the
  // PC or entered in Settings). Matches the desktop's key-gated voice-to-text.
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
    // Capture the current clipboard when the screen opens (only readable while the
    // app is foregrounded — this is what the bubble-tap flow relies on).
    void s.captureClipboard().then((t) => {
      if (t) return s.addText(t);
    });
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

  const captureNow = async () => {
    const t = await s.captureClipboard();
    if (t) {
      await s.addText(t);
      setCaptured(true);
      setTimeout(() => setCaptured(false), 1200);
    }
  };

  const q = search.trim().toLowerCase();
  const match = (i: ClipItem) => {
    if (filter !== "all" && i.kind !== filter) return false;
    if (!q) return true;
    return (i.text ?? "").toLowerCase().includes(q) || (i.deviceName ?? "").toLowerCase().includes(q);
  };
  const pinned = s.items.filter((i) => i.pinned && match(i));
  const rest = s.items.filter((i) => !i.pinned && match(i));
  const needsSetup = android && (!perms.overlay || !perms.battery || !perms.notif);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-accent-sheen text-white">
          <ClipboardList className="h-4 w-4" />
        </span>
        <div>
          <div className="text-base font-800 text-ink">Clipboard</div>
          <div className="text-[11px] text-ink-dim">
            {s.ready ? (s.connected ? `Synced${new Set(s.items.map(i => i.deviceId)).size > 0 ? ` · ${new Set(s.items.map(i => i.deviceId)).size} device${new Set(s.items.map(i => i.deviceId)).size === 1 ? "" : "s"}` : ""}` : "Connecting…") : "Set your key in More → Remote to sync"}
          </div>
        </div>
      </div>

      {needsSetup && (
        <div className="space-y-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-2.5">
          <div className="px-1 text-[11px] font-700 text-ink-soft">Finish setup — keeps sync running in the background</div>
          <PermRow
            icon={<Layers className="h-4 w-4" />}
            title="Draw over apps"
            desc="The floating bubble on top of everything."
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
        onAddText={s.addText}
        onAddImage={(b64) => s.addImage(b64)}
        sttEnabled={sttEnabled}
        transcribe={companionTranscribe}
      />

      <button
        onClick={captureNow}
        className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] py-2 text-sm font-600 text-ink-soft active:scale-[0.99]"
      >
        {captured ? <Check className="h-4 w-4 text-emerald-400" /> : <ClipboardPaste className="h-4 w-4" />}
        {captured ? "Added" : "Add from clipboard"}
      </button>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search history"
            className="input w-full py-1.5 pl-8 text-xs"
          />
        </div>
        <div className="flex rounded-lg bg-white/[0.04] p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] font-600 capitalize transition-colors",
                filter === f ? "bg-white/10 text-ink" : "text-ink-dim hover:text-ink-soft",
              )}
            >
              {f === "image" ? "Images" : f}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {pinned.length === 0 && rest.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="h-6 w-6" />}
            title={s.items.length === 0 ? "Nothing here yet" : "No matches"}
            message={
              s.items.length === 0
                ? "Copy on your PC and it appears here, or add something above."
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
            onLoadMore={() => {}}
            compact
          />
        )}
      </div>

      {s.items.length > 0 && (
        <button
          onClick={() => {
            if (confirm("Clear this device's clipboard history view? (Other devices keep theirs.)")) {
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
