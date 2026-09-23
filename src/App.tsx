import { Suspense, useEffect, useRef } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "motion/react";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { AmbientShell, LottieIdle, PageTransitionFX } from "./components/animations";
import { AnimatedOutlet } from "./components/AnimatedOutlet";
import { Toasts } from "./components/Toasts";
import { ProgressDock } from "./components/ProgressDock";
import { JukeboxEngine } from "./components/JukeboxEngine";
import { JukeboxFloater } from "./components/JukeboxFloater";
import { RemoteHostManager } from "./components/RemoteHostManager";
import { RemoteApprovalModal } from "./components/RemoteApprovalModal";
import { Onboarding } from "./components/Onboarding";
import { SplashScreen } from "./components/SplashScreen";
import { GameModal } from "./components/GameModal";
import { DropZone } from "./components/DropZone";
import { useTauriBridge } from "./lib/bridge";
import { useSettings, useRemoteOnly } from "./lib/queries";
import { routeAllowed } from "./lib/setupMode";
import { useApp } from "./store/app";
// The landing screen stays eager; every other screen is its own chunk, warmed in
// the background once the app is idle (see lazyRoute.ts).
import Dashboard from "./routes/Dashboard";
import { lazyRoute, preloadWhenIdle } from "./lib/lazyRoute";
const LibraryPage = lazyRoute(() => import("./routes/Library"));
const AppsPage = lazyRoute(() => import("./routes/Apps"));
const SystemsPage = lazyRoute(() => import("./routes/Systems"));
const GameDetail = lazyRoute(() => import("./routes/GameDetail"));
const TimelinePage = lazyRoute(() => import("./routes/Timeline"));
const MusicPage = lazyRoute(() => import("./routes/Music"));
const RemotePage = lazyRoute(() => import("./routes/Remote"));
const CollectionPage = lazyRoute(() => import("./routes/Collection"));
const TagsPage = lazyRoute(() => import("./routes/Tags"));
const SuggestedPage = lazyRoute(() => import("./routes/Suggested"));
const SettingsPage = lazyRoute(() => import("./routes/Settings"));
const ClipboardPage = lazyRoute(() => import("./routes/Clipboard"));
const SharePage = lazyRoute(() => import("./routes/Share"));
// Its own window: loading it lazily keeps that window from parsing the whole app.
const ClipboardOverlay = lazyRoute(() => import("./features/clipboard/ClipboardOverlay"));
const ROUTE_CHUNKS = [
  RemotePage,
  LibraryPage,
  GameDetail,
  TimelinePage,
  SystemsPage,
  SettingsPage,
  ClipboardPage,
  CollectionPage,
  MusicPage,
  AppsPage,
  TagsPage,
  SuggestedPage,
  SharePage,
];
import { ClipSyncEngine } from "./features/clipboard/ClipSyncEngine";
import { ShareHostManager } from "./components/ShareHostManager";

let didLanding = false;

function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: settings } = useSettings();
  const onboarded = settings?.onboarded === "true";
  const landing = useApp((s) => s.prefs.landing);
  const remoteOnly = useRemoteOnly();
  const onceRef = useRef(false);

  // One-time: honor the "default landing page" pref on launch. Remote-only mode
  // has no landing choice — the guard below parks it on /remote.
  useEffect(() => {
    if (onceRef.current || didLanding || !settings) return;
    if (remoteOnly) return;
    onceRef.current = true;
    didLanding = true;
    if (location.pathname === "/" && landing && landing !== "/") {
      navigate(landing, { replace: true });
    }
  }, [landing, location.pathname, navigate, remoteOnly, settings]);

  // Warm the other screens' chunks once startup has settled.
  useEffect(() => preloadWhenIdle(ROUTE_CHUNKS), []);

  // Hiding nav isn't enough on its own: a stale landing pref, an in-app link, or
  // a route left behind when the mode flips would still render a hidden page.
  // Bounce anything outside the allowed set back to Remote.
  useEffect(() => {
    if (remoteOnly && !routeAllowed(location.pathname, true)) {
      navigate("/remote", { replace: true });
    }
  }, [remoteOnly, location.pathname, navigate]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <TitleBar />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <AmbientShell />
        <Sidebar />
        <main className="relative isolate min-w-0 flex-1 overflow-hidden">
          <AnimatedOutlet />
          <PageTransitionFX />
        </main>
      </div>

      <Toasts />
      <ProgressDock />
      <JukeboxEngine />
      <JukeboxFloater />
      <RemoteHostManager />
      <ClipSyncEngine />
      <ShareHostManager />
      <RemoteApprovalModal />
      <GameModal />
      <DropZone />
      {settings && !onboarded && <Onboarding />}
      <AnimatePresence>
        {!settings && (
          <motion.div
            key="shell-loading"
            className="fixed inset-0 z-[100] grid place-items-center bg-bg-base/75 backdrop-blur-md"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex flex-col items-center gap-3">
              <LottieIdle src="/lottie/loading-dots.json" className="h-14 w-14" speed={0.9} />
              <span className="text-[11px] font-700 uppercase tracking-[0.2em] text-ink-dim">Loading</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {import.meta.env?.DEV && (
        <span data-testid="route-path" className="sr-only">
          {location.pathname}
        </span>
      )}
      <SplashScreen />
    </div>
  );
}

export default function App() {
  useTauriBridge();

  return (
    <Routes>
      {/* Bare, transparent floating overlay window — no app shell. */}
      <Route
        path="/clip-overlay"
        element={
          <Suspense fallback={null}>
            <ClipboardOverlay />
          </Suspense>
        }
      />
      <Route element={<AppShell />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/apps" element={<AppsPage />} />
        <Route path="/system" element={<SystemsPage />} />
        <Route path="/game/:id" element={<GameDetail />} />
        <Route path="/timeline" element={<TimelinePage />} />
        {/* Replay merged into Timeline (logs) + Music (playlists) — keep old links working. */}
        <Route path="/sessions" element={<Navigate to="/timeline" replace />} />
        <Route path="/music" element={<MusicPage />} />
        <Route path="/remote" element={<RemotePage />} />
        <Route path="/collection" element={<CollectionPage />} />
        {/* Insights merged into Collection — keep old links working. */}
        <Route path="/insights" element={<Navigate to="/collection" replace />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/suggested" element={<SuggestedPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/clipboard" element={<ClipboardPage />} />
        <Route path="/share" element={<SharePage />} />
      </Route>
    </Routes>
  );
}
