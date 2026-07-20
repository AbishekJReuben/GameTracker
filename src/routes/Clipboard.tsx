import { useNavigate } from "react-router-dom";
import { Trash2, Settings2, ClipboardList } from "lucide-react";
import { Page } from "@/components/Page";
import { Panel } from "@/components/Panel";
import { EmptyState } from "@/components/ui";
import { useSettings } from "@/lib/queries";
import { useClipboard } from "@/store/clipboard";
import { ClipboardPanel } from "@/features/clipboard/ClipboardPanel";

export default function ClipboardPage() {
  const { data: settings } = useSettings();
  const navigate = useNavigate();
  const enabled = settings?.clipboard_enabled === "true";
  const stt = settings?.clipboard_stt_enabled === "true";
  const clearAll = useClipboard((s) => s.clearAll);

  return (
    <Page
      title="Clipboard"
      subtitle="Your synced, end-to-end-encrypted clipboard history"
      width="max-w-3xl"
      actions={
        enabled ? (
          <button
            onClick={() => {
              if (confirm("Delete the entire clipboard history? This can't be undone.")) clearAll();
            }}
            className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear all
          </button>
        ) : undefined
      }
    >
      {enabled ? (
        <Panel
          panelKey="clipboard.page"
          games={[]}
          className="flex min-h-[60vh] flex-col p-3"
          bodyClassName="flex min-h-0 flex-1 flex-col"
        >
          <ClipboardPanel sttEnabled={stt} />
        </Panel>
      ) : (
        <EmptyState
          icon={<ClipboardList className="h-6 w-6" />}
          title="Shared clipboard is off"
          message="Turn it on to capture text & images and sync them across your PC and phone."
          action={
            <button onClick={() => navigate("/settings")} className="btn-primary flex items-center gap-2 px-4 py-2 text-sm">
              <Settings2 className="h-4 w-4" /> Open settings
            </button>
          }
        />
      )}
    </Page>
  );
}
