import { useCallback, useEffect, useState } from "react";
import { AudioLines, Cpu, Download, Lock, Play, Radio, Smartphone } from "lucide-react";
import { Page } from "@/components/Page";
import { Panel } from "@/components/Panel";
import { SectionTitle, Skeleton, Toggle } from "@/components/ui";
import { api, type VoiceLine, type VoiceStatus, type VoiceVoices } from "@/lib/api";
import { useDocumentVisible } from "@/lib/useVisible";
import { useApp } from "@/store/app";

// Kokoro v1.0's English speakers (sherpa-onnx speaker ids).
const VOICES: { sid: number; name: string }[] = [
  { sid: 3, name: "Heart · US female" },
  { sid: 2, name: "Bella · US female" },
  { sid: 6, name: "Nicole · US female, soft" },
  { sid: 9, name: "Sarah · US female" },
  { sid: 7, name: "Nova · US female" },
  { sid: 5, name: "Kore · US female" },
  { sid: 10, name: "Sky · US female" },
  { sid: 0, name: "Alloy · US female" },
  { sid: 1, name: "Aoede · US female" },
  { sid: 4, name: "Jessica · US female" },
  { sid: 8, name: "River · US female" },
  { sid: 16, name: "Michael · US male" },
  { sid: 11, name: "Adam · US male" },
  { sid: 15, name: "Liam · US male" },
  { sid: 13, name: "Eric · US male" },
  { sid: 12, name: "Echo · US male" },
  { sid: 14, name: "Fenrir · US male" },
  { sid: 17, name: "Onyx · US male" },
  { sid: 18, name: "Puck · US male" },
  { sid: 21, name: "Emma · UK female" },
  { sid: 22, name: "Isabella · UK female" },
  { sid: 20, name: "Alice · UK female" },
  { sid: 23, name: "Lily · UK female" },
  { sid: 26, name: "George · UK male" },
  { sid: 27, name: "Lewis · UK male" },
  { sid: 24, name: "Daniel · UK male" },
  { sid: 25, name: "Fable · UK male" },
];

const KINDS: { key: keyof VoiceVoices; label: string; hint: string; fallback: number }[] = [
  { key: "reply", label: "Replies", hint: "What Claude writes to you, and its questions", fallback: 3 },
  { key: "thinking", label: "Thinking", hint: "When the transcript carries it", fallback: 6 },
  { key: "action", label: "Actions", hint: "\"Running the tests\", \"Editing lib.rs\"", fallback: 16 },
  { key: "output", label: "Output", hint: "Command and tool results", fallback: 26 },
];

const CAPS = [
  { v: 400, label: "Short (~25 s)" },
  { v: 800, label: "Medium (~50 s)" },
  { v: 2000, label: "Long (~2 min)" },
  { v: 0, label: "Everything" },
];

const KIND_COLOR: Record<VoiceLine["kind"], string> = {
  reply: "text-accent-3",
  thinking: "text-violet-300",
  action: "text-sky-300",
  output: "text-emerald-300",
  question: "text-amber-300",
  summary: "text-ink-dim",
};

export default function VoicePage() {
  const pushToast = useApp((s) => s.pushToast);
  const visible = useDocumentVisible();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceVoices>({});
  const [cap, setCap] = useState(800);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.voiceStatus());
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const map = s as unknown as Record<string, string>;
        try {
          setVoices(JSON.parse(map.voice_voices || "{}"));
        } catch {
          /* defaults */
        }
        const c = Number(map.voice_output_max_chars);
        if (Number.isFinite(c)) setCap(c);
      })
      .catch(() => {});
  }, []);

  // Live while on screen; nothing in the tray.
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const id = setInterval(() => void refresh(), 1000);
    return () => clearInterval(id);
  }, [refresh, visible]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      setStatus(await api.voiceSetEnabled(on));
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't change Voice", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = async (next: VoiceVoices, nextCap: number) => {
    setVoices(next);
    setCap(nextCap);
    try {
      await api.voiceSetSettings(next, nextCap);
    } catch (e) {
      pushToast({ kind: "info", title: "Couldn't save", message: String(e) });
    }
  };

  const test = async (kind: string) => {
    try {
      await api.voiceTest(kind);
    } catch (e) {
      pushToast({ kind: "info", title: "Voice isn't running", message: String(e) });
    }
  };

  const on = status?.enabled ?? false;
  const stateLine = !status
    ? ""
    : status.installing
      ? `${status.progressLabel || "Downloading"} · ${Math.round(status.progress * 100)}%`
      : !on
        ? "Off"
        : status.running
          ? status.relay === "connected"
            ? status.phoneListening
              ? "Phone listening"
              : "Waiting for the phone"
            : status.relay.startsWith("offline")
              ? "Discovery server unreachable, retrying"
              : "Connecting"
          : "Starting";

  return (
    <Page title="Voice" subtitle="Hear everything Claude Code does on this PC, on your phone">
      {!status ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <Panel panelKey="voice.toggle" className="mb-5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span
                  className="grid h-12 w-12 place-items-center rounded-2xl"
                  style={{
                    background: on ? "color-mix(in srgb, var(--accent-1) 22%, transparent)" : "rgba(255,255,255,0.05)",
                    color: on ? "var(--accent-1)" : "var(--ink-dim)",
                  }}
                >
                  <AudioLines className="h-6 w-6" />
                </span>
                <div>
                  <div className="font-display text-lg font-800">Claude Code narration</div>
                  <div className="flex items-center gap-2 text-sm text-ink-dim">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{
                        background: status.phoneListening ? "#34d399" : on ? "#fbbf24" : "#64748b",
                        boxShadow: status.phoneListening ? "0 0 10px #34d399" : undefined,
                      }}
                    />
                    {stateLine}
                    {status.running && status.backlogSecs > 5 && <> · {Math.round(status.backlogSecs)} s queued</>}
                  </div>
                </div>
              </div>
              <Toggle checked={on} onChange={(v) => !busy && toggle(v)} label={on ? "On" : "Off"} />
            </div>
            {status.installing && (
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5">
                <div className="h-full bg-accent-sheen transition-[width]" style={{ width: `${Math.round(status.progress * 100)}%` }} />
              </div>
            )}
            {status.error && <p className="mt-3 text-sm text-rose-300">{status.error}</p>}
            <div className="mt-4 grid gap-2 text-xs text-ink-faint sm:grid-cols-3">
              <div className="flex items-start gap-2">
                <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0" /> The voice (Kokoro) runs on this PC. No AI service, no per-use cost.
                {!status.installed && " One-time 370 MB download when you turn it on."}
              </div>
              <div className="flex items-start gap-2">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" /> End-to-end encrypted with your permanent key through your discovery server.
              </div>
              <div className="flex items-start gap-2">
                <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" /> On the phone: open GameTracker → Voice → Turn on. It keeps playing with the app closed.
              </div>
            </div>
          </Panel>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <Panel panelKey="voice.voices" className="p-5">
              <SectionTitle title="Voices" subtitle="A different voice for each kind of line" />
              <div className="space-y-3">
                {KINDS.map((k) => (
                  <div key={k.key} className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-700">{k.label}</div>
                      <div className="truncate text-xs text-ink-faint">{k.hint}</div>
                    </div>
                    <select
                      className="input h-9 w-48"
                      value={voices[k.key] ?? k.fallback}
                      onChange={(e) => {
                        const sid = Number(e.target.value);
                        const next: VoiceVoices = { ...voices, [k.key]: sid };
                        // Questions follow replies; summaries follow actions.
                        if (k.key === "reply") next.question = sid;
                        if (k.key === "action") next.summary = sid;
                        void save(next, cap);
                      }}
                    >
                      {VOICES.map((v) => (
                        <option key={v.sid} value={v.sid}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn btn-ghost h-9 w-9 p-0"
                      title="Play a sample on the phone"
                      disabled={!status.running}
                      onClick={() => void test(k.key)}
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-5">
                <div className="mb-1.5 text-sm font-700">Command output</div>
                <div className="flex flex-wrap gap-1.5">
                  {CAPS.map((c) => (
                    <button
                      key={c.v}
                      onClick={() => void save(voices, c.v)}
                      className={`rounded-lg px-2.5 py-1.5 text-xs font-700 ${
                        cap === c.v ? "bg-accent/20 text-accent-3" : "bg-white/5 text-ink-dim"
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-ink-faint">
                  How much of each result is read. When the phone falls behind, older actions and results are merged into
                  one line; replies and questions are always read.
                </p>
              </div>
            </Panel>

            <Panel panelKey="voice.feed" className="p-5">
              <SectionTitle
                title="Live"
                subtitle={status.running ? "Newest first, from every Claude Code session" : "Turn Voice on to follow your sessions"}
                right={<Radio className="h-4 w-4" />}
              />
              {status.recent.length === 0 ? (
                <div className="py-10 text-center text-sm text-ink-dim">
                  {status.running ? "Waiting for Claude Code…" : status.installed ? "Voice is off." : (
                    <span className="inline-flex items-center gap-2">
                      <Download className="h-4 w-4" /> Turning it on downloads the voices once.
                    </span>
                  )}
                </div>
              ) : (
                <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
                  {status.recent.map((l) => (
                    <li key={l.id} className={`rounded-xl bg-white/[0.03] px-3 py-2 ${l.played ? "opacity-60" : ""}`}>
                      <div className="mb-0.5 flex items-center gap-2 text-[10px] font-700 uppercase tracking-wide">
                        <span className={KIND_COLOR[l.kind]}>{l.kind}</span>
                        <span className="truncate text-ink-faint">{l.project}</span>
                        <span className="ml-auto normal-case text-ink-faint">
                          {l.audio === "skipped" ? "condensed" : l.audio === "pending" && !l.played ? "…" : ""}
                        </span>
                      </div>
                      <div className={`line-clamp-3 text-sm ${l.audio === "skipped" ? "line-through decoration-ink-faint/50" : ""}`}>
                        {l.text}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </Page>
  );
}
