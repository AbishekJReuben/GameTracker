import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { Gamepad2, Activity, BarChart3, Trophy, FileSpreadsheet, Plus, Sparkles, ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { useApp, useMotionEnabled } from "@/store/app";
import { useRefreshAll } from "@/lib/queries";
import { runCsvImport } from "@/lib/bulkTasks";
import { useProgress } from "@/store/progress";
import { ctaPulse, springSoft } from "@/lib/motion";

const FEATURES = [
  { icon: Activity, title: "Automatic tracking", text: "Runs in the background and logs every session — runtime and active focus time." },
  { icon: BarChart3, title: "Living analytics", text: "Heatmaps, streaks, a horizontal timeline and per-game breakdowns that make habits click." },
  { icon: Trophy, title: "Your collection", text: "Curate completed games with scores, then see how your taste stacks against the critics." },
];

function OnboardingIllustration() {
  const enabled = useMotionEnabled();
  return (
    <svg viewBox="0 0 320 180" className="mx-auto h-36 w-full max-w-sm text-accent-3" aria-hidden>
      <defs>
        <linearGradient id="ob-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--accent-1)" stopOpacity="0.9" />
          <stop offset="50%" stopColor="var(--accent-3)" stopOpacity="0.8" />
          <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0.7" />
        </linearGradient>
      </defs>
      <motion.rect
        x="24" y="40" width="272" height="120" rx="16"
        fill="none" stroke="url(#ob-grad)" strokeWidth="1.5" strokeOpacity="0.35"
        animate={enabled ? { strokeOpacity: [0.25, 0.55, 0.25] } : undefined}
        transition={{ duration: 3, repeat: Infinity }}
      />
      <motion.path
        d="M48 130 Q 100 60, 160 95 T 272 75"
        fill="none" stroke="url(#ob-grad)" strokeWidth="2.5" strokeLinecap="round"
        initial={{ pathLength: 0, opacity: 0.4 }}
        animate={enabled ? { pathLength: 1, opacity: [0.5, 1, 0.5] } : { pathLength: 1, opacity: 0.7 }}
        transition={{ pathLength: { duration: 1.8, ease: "easeOut" }, opacity: { duration: 3, repeat: Infinity } }}
      />
      {[72, 128, 184, 240].map((cx, i) => (
        <motion.circle
          key={cx}
          cx={cx}
          cy={i % 2 === 0 ? 88 : 108}
          r="6"
          fill="url(#ob-grad)"
          animate={enabled ? { cy: [88, 78, 88], opacity: [0.6, 1, 0.6] } : undefined}
          transition={{ duration: 2 + i * 0.3, repeat: Infinity, delay: i * 0.15 }}
        />
      ))}
      <motion.rect
        x="130" y="28" width="60" height="36" rx="8"
        fill="url(#ob-grad)" fillOpacity="0.2" stroke="url(#ob-grad)" strokeWidth="1"
        animate={enabled ? { y: [28, 24, 28] } : undefined}
        transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <text x="160" y="50" textAnchor="middle" fill="currentColor" fontSize="11" fontWeight="700" opacity="0.85">NOW PLAYING</text>
    </svg>
  );
}

export function Onboarding() {
  const qc = useQueryClient();
  const refresh = useRefreshAll();
  const pushToast = useApp((s) => s.pushToast);
  const openGameModal = useApp((s) => s.openGameModal);
  const enabled = useMotionEnabled();
  const csvBusy = useProgress((s) => s.isKindBusy("csv-import"));
  const [csv, setCsv] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    api.defaultCsvPath().then(setCsv).catch(() => {});
  }, []);

  const finish = async () => {
    await api.completeOnboarding();
    qc.invalidateQueries({ queryKey: ["settings"] });
  };

  const importCsv = async () => {
    try {
      let path = csv;
      if (!path) {
        const sel = await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
        if (typeof sel !== "string") return;
        path = sel;
      }
      await runCsvImport(path, refresh, pushToast);
      await finish();
    } catch {
      pushToast({ kind: "info", title: "CSV import failed" });
    }
  };

  const addGame = async () => {
    await finish();
    openGameModal({ mode: "track" });
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-bg-base/85 p-6 backdrop-blur-xl"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={springSoft}
        className="hud-panel relative w-full max-w-3xl overflow-hidden rounded-[28px]"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-[color-mix(in_srgb,var(--accent-1)_22%,transparent)] to-transparent" />
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-accent-3/15 blur-[110px]" />

        <div className="relative px-9 pb-9 pt-10">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <motion.div
                initial={{ rotate: -12, scale: 0.8 }}
                animate={{ rotate: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 12, delay: 0.1 }}
                className="grid h-14 w-14 place-items-center rounded-2xl bg-accent-sheen shadow-glow"
              >
                <Gamepad2 className="h-7 w-7 text-white" />
              </motion.div>
              <span className="pill bg-white/[0.06] text-ink-soft">
                <Sparkles className="h-3.5 w-3.5 text-accent-3" /> Welcome · v2
              </span>
            </div>
            <div className="flex gap-1.5">
              {[0, 1].map((i) => (
                <motion.span
                  key={i}
                  className="h-1.5 rounded-full"
                  animate={{
                    width: step === i ? 20 : 6,
                    backgroundColor: step === i ? "var(--accent-3)" : "rgba(255,255,255,0.15)",
                  }}
                  transition={{ duration: 0.3 }}
                />
              ))}
            </div>
          </div>

          <AnimatePresence mode="wait">
            {step === 0 ? (
              <motion.div
                key="intro"
                initial={enabled ? { opacity: 0, x: -20 } : false}
                animate={{ opacity: 1, x: 0 }}
                exit={enabled ? { opacity: 0, x: 20 } : undefined}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="mt-6">
                  <OnboardingIllustration />
                </div>
                <h1 className="mt-4 max-w-xl font-display text-4xl font-800 leading-[1.05] tracking-tight text-balance">
                  Track every hour you play. <span className="accent-text">Beautifully.</span>
                </h1>
                <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-ink-soft">
                  Tracker quietly records your sessions and turns them into a living dashboard — from
                  real-time now-playing to year-long heatmaps and your completed-games hall of fame.
                </p>

                <div className="mt-7 grid gap-3 sm:grid-cols-3">
                  {FEATURES.map((f, i) => (
                    <motion.div
                      key={f.title}
                      initial={{ opacity: 0, y: 14 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.15 + i * 0.08 }}
                      className="rounded-2xl border border-line bg-white/[0.02] p-4"
                    >
                      <f.icon className="h-5 w-5 text-accent-3" />
                      <div className="mt-2.5 text-sm font-700">{f.title}</div>
                      <div className="mt-1 text-[12.5px] leading-snug text-ink-dim">{f.text}</div>
                    </motion.div>
                  ))}
                </div>

                <div className="mt-8">
                  <motion.button
                    onClick={() => setStep(1)}
                    className="btn btn-primary"
                    {...(enabled ? ctaPulse : {})}
                  >
                    Get started <ArrowRight className="h-4 w-4" />
                  </motion.button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="actions"
                initial={enabled ? { opacity: 0, x: 20 } : false}
                animate={{ opacity: 1, x: 0 }}
                exit={enabled ? { opacity: 0, x: -20 } : undefined}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                <h2 className="mt-6 font-display text-2xl font-800 tracking-tight">How would you like to begin?</h2>
                <p className="mt-2 max-w-md text-[15px] text-ink-soft">
                  Import your completed-games list, add a game to track, or explore the app first — you can always do this later.
                </p>

                <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <motion.button
                    onClick={importCsv}
                    disabled={csvBusy}
                    className="btn btn-primary"
                    {...(enabled ? ctaPulse : {})}
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    {csv ? "Import my completed games" : "Import a games CSV"}
                  </motion.button>
                  <button onClick={addGame} className="btn btn-ghost">
                    <Plus className="h-4 w-4" /> Add a game manually
                  </button>
                  <button onClick={finish} className="btn btn-subtle sm:ml-auto">
                    Skip for now <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
                {csv && (
                  <p className="mt-3 text-[12px] text-ink-faint">
                    Found your list at <span className="text-ink-dim">{csv}</span>
                  </p>
                )}
                <button onClick={() => setStep(0)} className="mt-6 text-sm font-600 text-ink-dim transition hover:text-ink">
                  ← Back
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}
