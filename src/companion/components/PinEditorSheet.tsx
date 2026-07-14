/**
 * Per-pinned-button editor sheet — size, shape, chrome, theme, press feel.
 * Opens from Pin mode (gear / long-press). Shared APK / web / Quest.
 *
 * Fully uncontrolled after open: draft lives only in local state. Parent
 * ControlScreen re-renders at pointer/stats rate; we must NOT sync from
 * `initial` on those renders or sliders/chips snap back mid-edit.
 */

import { useState } from "react";
import { motion } from "motion/react";
import { X, RotateCcw } from "lucide-react";
import {
  PIN_STYLE_DEFAULTS,
  PIN_THEME_PRESETS,
  normalizePinStyle,
  type PinStyle,
  type ButtonShape,
  type ButtonChrome,
  type PressAnim,
  type LabelMode,
} from "../controlChrome";

const SHAPES: { id: ButtonShape; label: string }[] = [
  { id: "rounded", label: "Round" },
  { id: "pill", label: "Pill" },
  { id: "square", label: "Square" },
  { id: "capsule", label: "Capsule" },
];
const CHROMES: { id: ButtonChrome; label: string }[] = [
  { id: "keycap", label: "Keycap" },
  { id: "flat", label: "Flat" },
  { id: "glass", label: "Glass" },
  { id: "solid", label: "Solid" },
  { id: "outline", label: "Line" },
];
const ANIMS: { id: PressAnim; label: string }[] = [
  { id: "spring", label: "Spring" },
  { id: "sink", label: "Sink" },
  { id: "glow", label: "Glow" },
  { id: "ripple", label: "Ripple" },
  { id: "bounce", label: "Bounce" },
  { id: "hard", label: "Hard" },
];
const LABELS: { id: LabelMode; label: string }[] = [
  { id: "keys+label", label: "Both" },
  { id: "keys", label: "Keys" },
  { id: "label", label: "Label" },
  { id: "icon", label: "Icon" },
];

function clampNum(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-800 uppercase tracking-wider text-ink-faint">{label}</div>
      {children}
    </div>
  );
}

function ChipGroup<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onChange(o.id);
          }}
          className={`rounded-lg px-2 py-1 text-[10px] font-800 ${
            value === o.id ? "bg-accent-3 text-white" : "bg-white/[0.06] text-ink-dim"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[10px] font-700">
        <span className="text-ink-faint">{label}</span>
        <span className="tabular-nums text-white">{fmt(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(Number(e.target.value))}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
        className="w-full accent-accent-3"
      />
    </div>
  );
}

export function PinEditorSheet({
  pinId,
  title,
  initial,
  onSave,
  onClose,
  onReset,
  onUnpin,
}: {
  pinId: string;
  title: string;
  /** Frozen snapshot from when the sheet opened — must stay referentially stable. */
  initial: PinStyle;
  onSave: (style: PinStyle) => void;
  onClose: () => void;
  onReset: () => void;
  onUnpin: () => void;
}) {
  // Lazy init only — remount via parent `key={pinId}` when switching pins.
  // Never sync from props after mount (that was resetting sliders/chips).
  const [draft, setDraft] = useState<PinStyle>(() => normalizePinStyle(initial));

  const patch = (p: Partial<PinStyle>) => {
    setDraft((d) => {
      const next: PinStyle = {
        ...d,
        ...p,
        scale: p.scale != null ? clampNum(p.scale, 0.25, 10) : d.scale,
        w: p.w != null ? clampNum(p.w, 0.25, 10) : d.w,
        h: p.h != null ? clampNum(p.h, 0.25, 10) : d.h,
        opacity: p.opacity != null ? clampNum(p.opacity, 0.35, 1) : d.opacity,
        theme: p.theme !== undefined ? { ...p.theme } : d.theme,
        customLabel:
          p.customLabel !== undefined
            ? p.customLabel
              ? p.customLabel.slice(0, 24)
              : undefined
            : d.customLabel,
      };
      return next;
    });
  };

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
        className="max-h-[78vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-white/10 bg-bg-900/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-float"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-display text-base font-800 text-white">Edit pin</div>
            <div className="truncate text-[11px] text-ink-faint">{title}</div>
          </div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.06] text-ink-soft">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <Row label="Size">
            <SliderRow label="Scale" value={draft.scale} min={0.25} max={10} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ scale: v })} />
            <SliderRow label="Width" value={draft.w} min={0.25} max={10} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => patch({ w: v })} />
            <SliderRow label="Height" value={draft.h} min={0.25} max={10} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => patch({ h: v })} />
            <SliderRow label="Opacity" value={draft.opacity} min={0.35} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ opacity: v })} />
          </Row>

          <Row label="Shape">
            <ChipGroup options={SHAPES} value={draft.shape} onChange={(shape) => patch({ shape })} />
          </Row>
          <Row label="Style">
            <ChipGroup options={CHROMES} value={draft.chrome} onChange={(chrome) => patch({ chrome })} />
          </Row>
          <Row label="Press feel">
            <ChipGroup options={ANIMS} value={draft.anim} onChange={(anim) => patch({ anim })} />
          </Row>
          <Row label="Label">
            <ChipGroup options={LABELS} value={draft.labelMode} onChange={(labelMode) => patch({ labelMode })} />
            <input
              value={draft.customLabel ?? ""}
              onChange={(e) => patch({ customLabel: e.target.value || undefined })}
              placeholder="Custom label (optional)"
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-ink-faint focus:border-accent-3"
            />
          </Row>
          <Row label="Theme">
            <div className="flex flex-wrap gap-1.5">
              {PIN_THEME_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  title={p.label}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    patch({ theme: { ...p.theme } });
                  }}
                  className="h-8 w-8 rounded-full border border-white/20"
                  style={{
                    background: p.theme.bg || "rgba(255,255,255,0.08)",
                    boxShadow: p.theme.accent ? `0 0 0 2px ${p.theme.accent}` : undefined,
                  }}
                />
              ))}
            </div>
          </Row>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft({ ...PIN_STYLE_DEFAULTS, theme: {} });
              onReset();
            }}
            className="btn btn-ghost h-11 flex-1 gap-1.5 text-xs"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset look
          </button>
          <button type="button" onClick={onUnpin} className="btn btn-ghost h-11 flex-1 text-xs text-red">
            Unpin
          </button>
          <button
            type="button"
            onClick={() => {
              onSave(normalizePinStyle(draft));
              onClose();
            }}
            className="btn btn-primary h-11 flex-[1.4] text-xs"
          >
            Done
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
