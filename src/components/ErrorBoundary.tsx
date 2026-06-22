import { Component, ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-pink/15 text-pink">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div>
            <h2 className="font-display text-lg font-700 text-ink">Something went wrong</h2>
            <p className="mt-1 max-w-md text-sm text-ink-dim">
              {this.state.error.message || "This page failed to render."}
            </p>
          </div>
          <Link to="/library" className="btn btn-primary">
            Back to library
          </Link>
        </div>
      );
    }
    return this.props.children;
  }
}
