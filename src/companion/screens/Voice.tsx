import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AudioLines, BellOff, ChevronLeft, FastForward, KeyRound, Pause, Play, Radio, SkipForward, Zap } from "lucide-react";
import { DEFAULT_SIGNAL_URL } from "@/lib/remoteConfig";
import { deviceId } from "../device";

// Voice: Claude Code on the PC, read aloud. All playing happens in the native
// VoiceService (it keeps going with the app closed); this screen only shows the
// feed and sends controls. It polls the service while visible, and the service
// answers `{"ver":n}` alone when nothing changed, so an idle screen costs next to
// nothing.

const LS_ON = "gt.voice.on";
const LS_SECRET = "gt.remote.secret";
const LS_SIGNAL = "gt.remote.signal";
const POLL_MS = 700;

interface VoiceItem {
  id: string;
  kind: "reply" | "thinking" | "action" | "output" | "question" | "summary";
  text: string;
  title: string;
  project: string;
  skip: boolean;
  played: boolean;
  ready: boolean;
}

interface Snapshot {
  ver?: number;
  running?: boolean;
  connected?: boolean;
  paused?: boolean;
  speed?: number;
  playing?: string | null;
  items?: VoiceItem[];
}

const KIND: Record<VoiceItem["kind"], { label: string; cls: string }> = {
  reply: { label: "Reply", cls: "text-accent-3 border-accent-3/30" },
  thinking: { label: "Thinking", cls: "text-violet-300 border-violet-300/30" },
  action: { label: "Action", cls: "text-sky-300 border-sky-300/30" },
  output: { label: "Output", cls: "text-emerald-300 border-emerald-300/30" },
  question: { label: "Question", cls: "text-amber-300 border-amber-300/40" },
  summary: { label: "Summary", cls: "text-ink-dim border-line" },
};

const SPEEDS = [1, 1.25, 1.5, 2];

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export default function VoiceScreen({ onHome }: { onHome?: () => void }) {
  const [secret, setSecret] = useState(() => localStorage.getItem(LS_SECRET) || "");
  const [on, setOn] = useState(() => readBool(LS_ON));
  const [snap, setSnap] = useState<Snapshot>({});
  const [error, setError] = useState<string | null>(null);
  const [notifOk, setNotifOk] = useState(true);
  const [keyDraft, setKeyDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const ver = useRef(-1);

  const start = useCallback(
    async (enabled: boolean, key = secret) => {
      try {
        await invoke("voice_service_start", {
          enabled,
          secret: key,
          deviceId: deviceId(),
          signalUrl: localStorage.getItem(LS_SIGNAL) || DEFAULT_SIGNAL_URL,
        });
        localStorage.setItem(LS_ON, enabled ? "1" : "0");
        setOn(enabled);
        setError(null);
        ver.current = -1;
      } catch (e) {
        setError(String(e));
      }
    },
    [secret],
  );

  // Keep the service running with the current key whenever Voice is on (it's
  // idempotent: an already-running service just re-reads its config).
  useEffect(() => {
    if (on && secret) void start(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    invoke<boolean>("clipboard_notif_status").then(setNotifOk).catch(() => {});
  }, []);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const raw = await invoke<string>("voice_snapshot", { ver: ver.current });
          const s = JSON.parse(raw) as Snapshot;
          if (alive && (s.items || s.running === false)) {
            if (typeof s.ver === "number") ver.current = s.ver;
            setSnap(s);
          }
        } catch {
          /* service restarting */
        }
      }
      if (alive) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [on]);

  const control = (action: string, arg?: string) => {
    void invoke("voice_control", { action, arg: arg ?? null }).catch(() => {});
    ver.current = -1; // the next poll brings the new state
  };

  const saveKey = () => {
    const k = keyDraft.trim();
    if (!k) return;
    localStorage.setItem(LS_SECRET, k);
    setSecret(k);
    setKeyDraft("");
    void start(true, k);
  };

  const items = snap.items ?? [];
  const playing = snap.playing ?? null;

  return (
    <div className="flex h-[100dvh] flex-col bg-bg-base text-ink">
      <header
        className="flex items-center gap-2 border-b border-line px-3 py-3"
        style={{ paddingTop: "max(0.75rem, calc(env(safe-area-inset-top) + 0.5rem))" }}
      >
        {onHome && (
          <button onClick={onHome} className="btn btn-ghost h-9 w-9 p-0" title="Home">
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        <AudioLines className="h-5 w-5 text-accent-3" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-800">Voice</div>
          <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <Radio className={`h-3 w-3 ${snap.connected ? "text-emerald-400" : ""}`} />
            {!on ? "Off" : snap.connected ? "Listening to your PC" : "Connecting…"}
          </div>
        </div>
        {secret && (
          <button
            onClick={() => void start(!on)}
            className={`btn h-9 px-3 ${on ? "btn-ghost" : "btn-primary"}`}
          >
            {on ? "Turn off" : "Turn on"}
          </button>
        )}
      </header>

      {!secret ? (
        <div className="space-y-3 p-4">
          <div className="card space-y-3 p-4">
            <div className="flex items-center gap-2 font-700">
              <KeyRound className="h-4 w-4 text-accent-3" /> Link this phone once
            </div>
            <p className="text-sm text-ink-dim">
              Voice is encrypted with your PC's permanent key. Connect with <b>Remote desktop</b> once (the key
              arrives automatically), or paste the key from the PC's Remote page.
            </p>
            <input
              className="input w-full"
              placeholder="Permanent key"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button className="btn btn-primary w-full" onClick={saveKey} disabled={!keyDraft.trim()}>
              Save and turn on
            </button>
          </div>
        </div>
      ) : (
        <>
          {on && (
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <button
                className="btn btn-primary h-10 w-10 p-0"
                onClick={() => control(snap.paused ? "play" : "pause")}
                title={snap.paused ? "Play" : "Pause"}
              >
                {snap.paused ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
              </button>
              <button className="btn btn-ghost h-10 w-10 p-0" onClick={() => control("skip")} title="Skip this line">
                <SkipForward className="h-5 w-5" />
              </button>
              <button className="btn btn-ghost h-10 px-3" onClick={() => control("live")} title="Jump to the newest line">
                <FastForward className="h-4 w-4" /> Live
              </button>
              <div className="ml-auto flex gap-1">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    onClick={() => control("speed", String(s))}
                    className={`rounded-lg px-2 py-1.5 text-xs font-700 ${
                      Math.abs((snap.speed ?? 1) - s) < 0.01 ? "bg-accent/20 text-accent-3" : "text-ink-dim"
                    }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>
          )}

          {!notifOk && on && (
            <button
              className="mx-3 mt-2 flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-left text-xs text-amber-200"
              onClick={() => void invoke("clipboard_request_notif").catch(() => {})}
            >
              <BellOff className="h-4 w-4 shrink-0" />
              Allow notifications so the playback controls show on your lock screen.
            </button>
          )}
          {error && <div className="mx-3 mt-2 text-xs text-rose-300">{error}</div>}

          <main className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {!on ? (
              <div className="py-16 text-center text-sm text-ink-dim">
                <Zap className="mx-auto mb-3 h-8 w-8 text-accent-3" />
                Turn on Voice to hear everything Claude Code does on your PC, even with this app closed.
                <div className="mt-2 text-xs text-ink-faint">Voice must also be on in GameTracker on the PC.</div>
              </div>
            ) : items.length === 0 ? (
              <div className="py-16 text-center text-sm text-ink-dim">
                Waiting for Claude Code on your PC…
              </div>
            ) : (
              <ul className="space-y-1.5">
                {items.map((it) => {
                  const k = KIND[it.kind] ?? KIND.reply;
                  const isPlaying = it.id === playing;
                  const expanded = open === it.id;
                  return (
                    <li
                      key={it.id}
                      className={`rounded-xl border px-3 py-2 transition-colors ${
                        isPlaying ? "border-accent-3/60 bg-accent/10" : "border-line bg-bg-900/40"
                      } ${it.played && !isPlaying ? "opacity-60" : ""}`}
                      onClick={() => setOpen(expanded ? null : it.id)}
                    >
                      <div className="mb-1 flex items-center gap-2 text-[10px] font-700 uppercase tracking-wide">
                        <span className={`rounded-md border px-1.5 py-0.5 ${k.cls}`}>{k.label}</span>
                        <span className="truncate text-ink-faint">{it.project || it.title}</span>
                        {it.skip && <span className="text-ink-faint normal-case">condensed</span>}
                        {!it.ready && !it.skip && !it.played && <span className="text-ink-faint normal-case">…</span>}
                        <button
                          className="ml-auto rounded-md px-1.5 py-0.5 text-ink-dim"
                          onClick={(e) => {
                            e.stopPropagation();
                            control("replay", it.id);
                          }}
                          title="Play this line"
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className={`text-sm leading-snug ${expanded ? "" : "line-clamp-3"} ${it.skip ? "line-through decoration-ink-faint/50" : ""}`}>
                        {it.text}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </main>
        </>
      )}
    </div>
  );
}
