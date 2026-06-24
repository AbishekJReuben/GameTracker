import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2 } from "lucide-react";
import { api, type GogValidateResult } from "@/lib/api";
import { Modal } from "./Modal";

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: (result: GogValidateResult) => void;
}

/** GOG OAuth via system browser — paste the redirect URL back (in-app webview shows a blank page). */
export function GogLoginModal({ open, onClose, onSuccess }: Props) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setInput("");
      setError(null);
      setBusy(false);
      return;
    }
    api
      .gogLoginUrl()
      .then((url) => {
        setLoginUrl(url);
        return openUrl(url);
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  const reopenBrowser = () => {
    if (!loginUrl) return;
    openUrl(loginUrl).catch((e) => setError(String(e)));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.gogLoginFinish(input);
      onSuccess(res);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Sign in with GOG" className="max-w-md">
      <div className="space-y-4 p-5">
        <p className="text-sm text-ink-dim">
          Your browser should open to GOG&apos;s sign-in page. After you approve access, copy the
          full address bar URL from the success page and paste it below.
        </p>

        <button type="button" className="btn btn-subtle h-9 w-full" onClick={reopenBrowser} disabled={!loginUrl}>
          <ExternalLink className="h-4 w-4" />
          Open GOG sign-in again
        </button>

        <label className="block space-y-1.5">
          <span className="text-xs font-600 text-ink-soft">Redirect URL or code</span>
          <textarea
            className="input min-h-[88px] resize-y font-mono text-xs"
            placeholder="https://embed.gog.com/on_login_success?origin=client&code=…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p className="text-xs text-pink">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !input.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Complete sign-in
          </button>
        </div>
      </div>
    </Modal>
  );
}
