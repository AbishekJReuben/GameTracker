import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Gamepad2, Minus, Square, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/tauri";

function WinBtn({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn("grid h-9 w-11 place-items-center text-ink-dim transition hover:bg-white/[0.06] hover:text-ink", className)}
    >
      {children}
    </button>
  );
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  const syncMaximized = useCallback(async () => {
    try {
      setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      /* browser preview */
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    syncMaximized();
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onResized(() => syncMaximized())
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, [syncMaximized]);

  const minimize = () => getCurrentWindow().minimize().catch(() => {});
  const toggleMaximize = () => getCurrentWindow().toggleMaximize().catch(() => {});
  const close = () => getCurrentWindow().close().catch(() => {});

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-bg-900/80 backdrop-blur-xl select-none"
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <div className="grid h-5 w-5 place-items-center rounded-md bg-accent-sheen">
          <Gamepad2 className="h-3 w-3 text-white" />
        </div>
        <span className="truncate text-[12px] font-700 tracking-[0.18em] text-ink-dim">TRACKER</span>
        <span className="rounded bg-white/[0.06] px-1.5 py-px text-[9px] font-800 tracking-wide text-accent-3">v3</span>
      </div>

      <div className="flex items-center">
        <WinBtn label="Minimize" onClick={minimize}>
          <Minus className="h-3.5 w-3.5" strokeWidth={2.25} />
        </WinBtn>
        <WinBtn label={maximized ? "Restore" : "Maximize"} onClick={toggleMaximize}>
          {maximized ? <Copy className="h-3 w-3" strokeWidth={2.25} /> : <Square className="h-3 w-3" strokeWidth={2.25} />}
        </WinBtn>
        <WinBtn label="Close" onClick={close} className="hover:bg-red-500/85 hover:text-white">
          <X className="h-3.5 w-3.5" strokeWidth={2.25} />
        </WinBtn>
      </div>
    </header>
  );
}
