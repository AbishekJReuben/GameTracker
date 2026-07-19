import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Layers, Zap, Mic } from "lucide-react";
import { api } from "@/lib/api";
import { clip } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";
import { useSettings } from "@/lib/queries";
import { Toggle } from "@/components/ui";
import { ClipboardIntro } from "./ClipboardIntro";

function Row({
  icon,
  title,
  desc,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl px-2 py-3 transition hover:bg-white/[0.02]">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-ink-soft">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-700">{title}</div>
        <div className="text-xs text-ink-dim">{desc}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Self-contained Settings section for the shared clipboard. */
export function ClipboardSettings() {
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const [intro, setIntro] = useState(false);

  const enabled = settings?.clipboard_enabled === "true";
  const overlay = settings?.clipboard_overlay_enabled === "true";
  const auto = settings?.clipboard_auto_capture !== "false";
  const stt = settings?.clipboard_stt_enabled === "true";

  const refresh = () => qc.invalidateQueries({ queryKey: ["settings"] });

  const setMaster = async (on: boolean) => {
    if (on && !enabled) {
      setIntro(true);
      return;
    }
    await clip.configure(on, overlay, auto);
    if (on) await clipSync.restart();
    else clipSync.stop();
    refresh();
  };

  const setOverlay = async (v: boolean) => {
    await clip.configure(enabled, v, auto);
    refresh();
  };
  const setAuto = async (v: boolean) => {
    await clip.configure(enabled, overlay, v);
    refresh();
  };
  const setStt = async (v: boolean) => {
    await api.setSetting("clipboard_stt_enabled", v ? "true" : "false");
    refresh();
  };

  return (
    <div className="space-y-1">
      <Row
        icon={<ClipboardList className="h-4 w-4" />}
        title="Shared clipboard"
        desc="A floating widget + a permanent, end-to-end-encrypted history that syncs across your PC and phone."
      >
        <Toggle checked={enabled} onChange={setMaster} />
      </Row>

      {enabled && (
        <>
          <Row icon={<Layers className="h-4 w-4" />} title="Floating widget" desc="Show the draggable bubble on top of every window.">
            <Toggle checked={overlay} onChange={setOverlay} />
          </Row>
          <Row icon={<Zap className="h-4 w-4" />} title="Auto-capture copies" desc="Automatically save everything you copy on this PC.">
            <Toggle checked={auto} onChange={setAuto} />
          </Row>
          <Row icon={<Mic className="h-4 w-4" />} title="Voice to text" desc="Add a mic button that transcribes speech (Sarvam).">
            <Toggle checked={stt} onChange={setStt} />
          </Row>
        </>
      )}

      {intro && <ClipboardIntro onClose={() => setIntro(false)} onEnabled={refresh} />}
    </div>
  );
}
