import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Layers, Zap, Mic, Stethoscope, Check, KeyRound } from "lucide-react";
import { api } from "@/lib/api";
import { clip } from "@/lib/clip";
import { clipSync } from "@/lib/clipboardSync";
import { useSettings } from "@/lib/queries";
import { Toggle } from "@/components/ui";
import { ClipboardIntro } from "./ClipboardIntro";

/** Build a single diagnostics report (Rust runtime log + JS sync state). */
async function buildClipReport(): Promise<string> {
  const lines: string[] = [];
  lines.push("=== GameTracker shared-clipboard diagnostics ===");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`App: ${typeof window !== "undefined" ? window.location.href : "(no window)"}`);
  lines.push("");
  lines.push("--- Rust runtime log (watcher + overlay window + apply_settings) ---");
  try {
    const rust = await clip.diagnostics();
    if (rust.length === 0) lines.push("(empty — feature was never toggled on this session)");
    else lines.push(...rust);
  } catch (e) {
    lines.push(`(failed to read Rust log: ${e instanceof Error ? e.message : String(e)})`);
  }
  lines.push("");
  lines.push("--- Sync engine state (webview) ---");
  for (const [k, v] of Object.entries(clipSync.diagnostics())) {
    lines.push(`${k}: ${v}`);
  }
  return lines.join("\n");
}

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
  const [copiedLogs, setCopiedLogs] = useState(false);

  const enabled = settings?.clipboard_enabled === "true";
  const overlay = settings?.clipboard_overlay_enabled === "true";
  const auto = settings?.clipboard_auto_capture !== "false";
  const stt = settings?.clipboard_stt_enabled === "true";

  const [keyInput, setKeyInput] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  useEffect(() => {
    setKeyInput(settings?.clipboard_sarvam_key ?? "");
  }, [settings?.clipboard_sarvam_key]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["settings"] });

  const saveKey = async () => {
    await api.setSetting("clipboard_sarvam_key", keyInput.trim());
    setKeySaved(true);
    setTimeout(() => setKeySaved(false), 1500);
    refresh();
  };

  const setMaster = async (on: boolean) => {
    if (on && !enabled) {
      setIntro(true);
      return;
    }
    try {
      await clip.configure(on, overlay, auto);
      if (on) await clipSync.restart();
      else clipSync.stop();
    } catch (e) {
      console.error("[clipboard] configure failed", e);
      alert(`Couldn't change the clipboard settings: ${e instanceof Error ? e.message : String(e)}`);
    }
    refresh();
  };

  const setOverlay = async (v: boolean) => {
    try {
      await clip.configure(enabled, v, auto);
    } catch (e) {
      console.error("[clipboard] overlay toggle failed", e);
      alert(`Couldn't toggle the floating widget: ${e instanceof Error ? e.message : String(e)}`);
    }
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

  const copyLogs = async () => {
    try {
      const report = await buildClipReport();
      await navigator.clipboard.writeText(report);
      setCopiedLogs(true);
      setTimeout(() => setCopiedLogs(false), 1500);
    } catch (e) {
      alert(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
    }
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
          {stt && (
            <div className="ml-[3.25rem] mr-2 mb-1 space-y-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
              <div className="flex items-center gap-1.5 text-[11px] font-700 text-ink-soft">
                <KeyRound className="h-3.5 w-3.5" /> Sarvam API key
              </div>
              <p className="text-[11px] text-ink-faint">
                Paste your key from sarvam.ai. Stored locally; overrides any key baked at build time and works on all your devices' mics.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="sk_…"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="input flex-1 py-1.5 text-xs"
                />
                <button
                  type="button"
                  onClick={saveKey}
                  className="btn btn-subtle flex items-center gap-1.5 px-3 py-1.5 text-xs"
                >
                  {keySaved ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : "Save"}
                </button>
              </div>
            </div>
          )}
          <Row
            icon={<Stethoscope className="h-4 w-4" />}
            title="Diagnostics"
            desc="Copy the watcher, overlay, and sync-engine state to debug issues."
          >
            <button
              type="button"
              onClick={copyLogs}
              className="btn btn-subtle flex items-center gap-1.5 px-3 py-1.5 text-xs"
              title="Copy a diagnostics report"
            >
              {copiedLogs ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" /> Copied
                </>
              ) : (
                "Copy logs"
              )}
            </button>
          </Row>
        </>
      )}

      {/* Portal to document.body: this section lives inside a transformed, clipped
          Settings <Panel>, where a position:fixed modal would be trapped and its
          bottom buttons cut off. Escaping the panel makes the overlay cover the
          viewport as intended (same pattern as Modal/Captures). */}
      {intro &&
        createPortal(
          <ClipboardIntro onClose={() => setIntro(false)} onEnabled={refresh} />,
          typeof document !== "undefined" ? document.body : (undefined as never),
        )}
    </div>
  );
}
