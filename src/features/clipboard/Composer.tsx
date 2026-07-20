import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Send, ImagePlus, Mic, Square, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { clip } from "@/lib/clip";

function blobToB64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export function Composer({
  onAddText,
  onAddImage,
  sttEnabled,
  transcribe,
  placeholder = "Type, paste text or an image…",
}: {
  onAddText: (text: string) => void;
  onAddImage: (b64: string, mime?: string) => void;
  sttEnabled: boolean;
  /** Platform-specific speech-to-text. Defaults to the desktop `clip.speechToText`
   *  (reads the key from settings); the companion injects its own runtime-keyed path. */
  transcribe?: (audioB64: string, mime: string) => Promise<string>;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = () => {
    if (!text.trim()) return;
    onAddText(text);
    setText("");
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const img = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (img) {
      e.preventDefault();
      const file = img.getAsFile();
      if (file) onAddImage(await blobToB64(file), file.type);
    }
  };

  const pickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onAddImage(await blobToB64(file), file.type);
    e.target.value = "";
  };

  const toggleMic = async () => {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.current.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        setTranscribing(true);
        try {
          const blob = new Blob(chunks.current, { type: "audio/webm" });
          const b64 = await blobToB64(blob);
          const out = transcribe
            ? await transcribe(b64, "audio/webm")
            : await clip.speechToText(b64, "audio/webm");
          if (out) setText((t) => (t ? `${t} ${out}` : out));
        } catch {
          /* transcription failed */
        } finally {
          setTranscribing(false);
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      /* mic denied */
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-2 backdrop-blur-sm focus-within:border-accent-3/40">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        placeholder={placeholder}
        className="max-h-40 min-h-[2.5rem] w-full resize-none bg-transparent px-2 py-1 text-sm text-ink outline-none placeholder:text-ink-faint"
      />
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <div className="flex items-center gap-1">
          <button
            onClick={() => fileInput.current?.click()}
            title="Add image"
            className="grid h-8 w-8 place-items-center rounded-lg text-ink-dim hover:bg-white/10 hover:text-ink"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={pickImage} />
          {sttEnabled && (
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={toggleMic}
              title={recording ? "Stop" : "Speak"}
              className={cn(
                "grid h-8 w-8 place-items-center rounded-lg",
                recording ? "bg-rose-500/90 text-white" : "text-ink-dim hover:bg-white/10 hover:text-ink",
              )}
            >
              {transcribing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : recording ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </motion.button>
          )}
          {recording && (
            <span className="text-[11px] font-600 text-rose-300">Recording… tap to stop</span>
          )}
        </div>
        <motion.button
          whileTap={{ scale: 0.94 }}
          onClick={submit}
          disabled={!text.trim()}
          className="btn-primary flex items-center gap-1.5 px-3 py-1.5 text-xs disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" /> Add
        </motion.button>
      </div>
    </div>
  );
}
