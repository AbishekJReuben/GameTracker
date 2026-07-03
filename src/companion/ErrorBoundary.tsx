import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

/**
 * Catches render/runtime errors anywhere in the companion screen tree so a crash
 * shows a readable message (with the error + a reload) instead of a blank
 * black/grey/white webview — React unmounts the whole tree on an uncaught error,
 * which on the phone looks like the app "went blank". The error text is also kept
 * so it can be shown/copied for debugging.
 */
interface State {
  error: Error | null;
  info: string | null;
}

export class ScreenErrorBoundary extends Component<{ label?: string; children: ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the remote console / logcat and keep the component stack for the UI.
    // eslint-disable-next-line no-console
    console.error(`[companion] screen crashed${this.props.label ? ` (${this.props.label})` : ""}:`, error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  private reset = () => this.setState({ error: null, info: null });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid min-h-[60vh] place-items-center p-6">
        <div className="w-full max-w-sm text-center">
          <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-amber/15 text-amber">
            <AlertTriangle className="h-7 w-7" />
          </span>
          <h2 className="font-display text-lg font-800">This screen hit an error</h2>
          <p className="mt-1 text-sm text-ink-dim">
            It was caught so the rest of the app keeps working. You can retry this screen.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-xl border border-line bg-black/30 p-3 text-left text-[11px] leading-relaxed text-amber/90">
            {error.message}
            {info ? `\n${info.split("\n").slice(0, 6).join("\n")}` : ""}
          </pre>
          <div className="mt-4 flex gap-2">
            <button onClick={this.reset} className="btn btn-primary h-11 flex-1 gap-2">
              <RotateCw className="h-4 w-4" /> Retry
            </button>
            <button onClick={() => window.location.reload()} className="btn btn-ghost h-11 flex-1 text-ink-dim">
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
