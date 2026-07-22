import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Send, ImagePlus, Mic, Square, Loader2, Check, X } from "lucide-react";
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

/** An item being edited in place (notes). */
export interface ComposerEdit {
  id: string;
  text: string;
}

type SpeechRecognitionCtor = new () => {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

/** Browser-native speech recognition, when the platform ships one (Chrome/web). */
function nativeSpeech(): SpeechRecognitionCtor | null {
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function Composer({
  onAddText,
  onAddImage,
  sttEnabled,
  transcribe,
  placeholder = "Type a note, paste text or an image…",
  draftKey,
  editing,
  onSaveEdit,
  onCancelEdit,
  compact = false,
}: {
  onAddText: (text: string) => void;
  onAddImage: (b64: string, mime?: string) => void;
  sttEnabled: boolean;
  /** Platform-specific speech-to-text. Defaults to the desktop `clip.speechToText`
   *  (reads the key from settings); the companion injects its own runtime-keyed path. */
  transcribe?: (audioB64: string, mime: string) => Promise<string>;
  placeholder?: string;
  /** Persist unsent text under this localStorage key so a draft survives the
   *  panel/window closing (parity with the Android dock's draft). */
  draftKey?: string;
  /** Non-null → the composer edits this note in place (Save/Cancel replace Add). */
  editing?: ComposerEdit | null;
  onSaveEdit?: (id: string, text: string) => void;
  onCancelEdit?: () => void;
  /** Floating panels start as a one-line composer, then claim full width once typed. */
  compact?: boolean;
}) {
  const [text, setText] = useState(() =>
    draftKey ? localStorage.getItem(draftKey) ?? "" : "",
  );
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const speech = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const chunks = useRef<Blob[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const sttErrorTimer = useRef<number | undefined>(undefined);

  // Web Speech is the built-in fallback (and an option even when Sarvam is set).
  const builtinAvailable = !!nativeSpeech();
  const micAvailable = sttEnabled || builtinAvailable;

  // A note starts as a compact, single-line affordance and only claims vertical
  // space when its actual content needs it. Measuring after React commits keeps
  // typing responsive and avoids a layout animation for every keystroke.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "0px";
    area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
    area.style.overflowY = area.scrollHeight > 160 ? "auto" : "hidden";
  }, [text]);

  // Draft persistence: mirror unsent text (not edits) to localStorage.
  useEffect(() => {
    if (!draftKey || editing) return;
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  }, [text, draftKey, editing]);

  // Entering edit mode swaps the buffer to the note's text (draft is already
  // saved above); leaving restores the draft.
  const prevEditId = useRef<string | null>(null);
  useEffect(() => {
    const id = editing?.id ?? null;
    if (id === prevEditId.current) return;
    prevEditId.current = id;
    if (editing) {
      setText(editing.text);
      areaRef.current?.focus();
    } else {
      setText(draftKey ? localStorage.getItem(draftKey) ?? "" : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  const showSttError = (msg: string) => {
    setSttError(msg);
    window.clearTimeout(sttErrorTimer.current);
    sttErrorTimer.current = window.setTimeout(() => setSttError(null), 5000);
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (editing) {
      onSaveEdit?.(editing.id, t);
      onCancelEdit?.();
    } else {
      onAddText(t);
      if (draftKey) localStorage.removeItem(draftKey);
    }
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

  const appendTranscript = (out: string) => {
    if (out) setText((t) => (t ? `${t} ${out}` : out));
  };

  /** Built-in (browser) speech recognition — no API key needed. */
  const startBuiltin = () => {
    const Ctor = nativeSpeech();
    if (!Ctor) return false;
    try {
      const rec = new Ctor();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (e) => {
        const out = Array.from({ length: e.results.length }, (_, i) => e.results[i]?.[0]?.transcript ?? "")
          .join(" ")
          .trim();
        appendTranscript(out);
      };
      rec.onerror = (e) => {
        setRecording(false);
        if (e.error !== "aborted" && e.error !== "no-speech") {
          showSttError(`Speech recognition failed${e.error ? ` (${e.error})` : ""}`);
        }
      };
      rec.onend = () => {
        setRecording(false);
        speech.current = null;
      };
      speech.current = rec;
      rec.start();
      setRecording(true);
      return true;
    } catch {
      return false;
    }
  };

  /** Recorded-audio path (Sarvam). Falls back to built-in on failure. */
  const startRecorded = async () => {
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
          if (out) appendTranscript(out);
          else showSttError("No speech detected — try again closer to the mic");
        } catch (e) {
          showSttError(e instanceof Error ? e.message : "Transcription failed");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
      return true;
    } catch {
      showSttError("Microphone unavailable or permission denied");
      return false;
    }
  };

  const toggleMic = async () => {
    setSttError(null);
    if (recording) {
      recorder.current?.stop();
      speech.current?.stop();
      return;
    }
    if (transcribing) return;
    // Prefer the keyed engine (Sarvam) when configured; otherwise built-in.
    if (sttEnabled) {
      if (await startRecorded()) return;
      if (startBuiltin()) return;
    } else if (startBuiltin()) {
      return;
    }
    showSttError("No speech engine available on this device");
  };

  useEffect(
    () => () => {
      window.clearTimeout(sttErrorTimer.current);
      try {
        recorder.current?.stop();
        speech.current?.stop();
      } catch {
        /* ignore */
      }
    },
    [],
  );

  return (
    <div
      className={cn(
        "rounded-2xl border bg-white/[0.03] p-2 backdrop-blur-sm transition-colors",
        compact && !text ? "flex items-center gap-1" : "",
        editing ? "border-accent-2/50" : "border-white/10 focus-within:border-accent-3/40",
      )}
    >
      <AnimatePresence initial={false}>
        {editing && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-700 uppercase tracking-wide text-accent-2">
              Editing note
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <textarea
        ref={areaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape" && editing) onCancelEdit?.();
        }}
        rows={1}
        placeholder={placeholder}
        className={cn(
          "max-h-40 min-h-[2.5rem] resize-none bg-transparent px-2 py-1 text-sm leading-6 text-ink outline-none placeholder:text-ink-faint",
          compact && !text ? "min-w-0 flex-1" : "w-full",
        )}
      />
      <div className={cn("flex items-center justify-between gap-1.5 px-0.5", compact && !text ? "shrink-0 pt-0" : "pt-1")}>
        <div className="flex min-w-0 items-center gap-0.5">
          {!editing && (
            <>
              <button
                onClick={() => fileInput.current?.click()}
                title="Add image"
                className="grid h-7 w-7 place-items-center rounded-lg text-ink-dim hover:bg-white/10 hover:text-ink"
              >
                <ImagePlus className="h-3.5 w-3.5" />
              </button>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={pickImage} />
            </>
          )}
          {micAvailable && (
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={toggleMic}
              title={recording ? "Stop" : transcribing ? "Transcribing…" : "Speak"}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-lg",
                recording
                  ? "bg-rose-500/90 text-white"
                  : "text-ink-dim hover:bg-white/10 hover:text-ink",
              )}
            >
              {transcribing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : recording ? (
                <Square className="h-3 w-3" />
              ) : (
                <Mic className="h-3.5 w-3.5" />
              )}
            </motion.button>
          )}
          {recording ? (
            <span className="truncate text-[10px] font-600 text-rose-300">Listening… tap to stop</span>
          ) : transcribing ? (
            <span className="truncate text-[10px] font-600 text-ink-dim">Transcribing…</span>
          ) : sttError ? (
            <span className="truncate text-[10px] font-600 text-amber-300" title={sttError}>
              {sttError}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing && (
            <motion.button
              whileTap={{ scale: 0.94 }}
              onClick={() => onCancelEdit?.()}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-600 text-ink-dim hover:bg-white/10 hover:text-ink"
            >
              <X className="h-3 w-3" /> Cancel
            </motion.button>
          )}
          <motion.button
            whileTap={{ scale: 0.94 }}
            onClick={submit}
            disabled={!text.trim()}
            className="btn-primary flex items-center gap-1 px-2.5 py-1 text-[11px] disabled:opacity-40"
          >
            {editing ? <Check className="h-3 w-3" /> : <Send className="h-3 w-3" />}
            {editing ? "Save" : "Add"}
          </motion.button>
        </div>
      </div>
    </div>
  );
}
