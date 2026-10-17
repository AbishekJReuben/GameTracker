import appearanceSchema from "../shared/desktopAppearance.json";
/** Versioned client preferences. Deliberately independent of credentials, streamTune
 * and controlChrome: appearance resets must never alter the control/stream setup. */
export const REMOTE_PREF_EVENT = 'gt:remote-preferences';
export const ROTATION_KEY = 'gt.remote.rotation.v1';
export const LEGACY_ROTATION_KEY = 'gt.remote.rotationHoldMs';
export const IDENTITY_KEY = 'gt.remote.identity.v1';
export const APPEARANCE_KEY = 'gt.remote.appearance.v1';
export const VIEW_KEY = 'gt.remote.view.v1';
export const DEFAULT_ROTATION_MS = 1200;
export const ROTATION_DETENTS = [0, ...Array.from({ length: 27 }, (_, i) => 400 + i * 100)] as const;
export const DEFAULT_CONTROLLER_NAME = 'Remote User';

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const storage = (): PreferenceStorage | undefined => {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
};
function read(key: string, store = storage()): unknown {
  try { const raw = store?.getItem(key); return raw == null ? undefined : JSON.parse(raw); } catch { return undefined; }
}
function write(key: string, value: unknown, store = storage()) {
  try { store?.setItem(key, JSON.stringify(value)); } catch { /* memory state still works when storage is disabled/full */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REMOTE_PREF_EVENT, { detail: { key } }));
}
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function validateRotation(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && (value === 0 || value >= 400 && value <= 3000) ? value : DEFAULT_ROTATION_MS;
}
export function readRotation(store = storage()): number {
  let currentRaw: string | null | undefined;
  try { currentRaw = store?.getItem(ROTATION_KEY); } catch { return DEFAULT_ROTATION_MS; }
  const saved = read(ROTATION_KEY, store);
  // An explicit corrupt current document recovers to defaults; it must not revive
  // an obsolete legacy setting. Missing is different from Off (numeric zero).
  if (currentRaw != null) return record(saved).version === 1 ? validateRotation(record(saved).holdMs) : DEFAULT_ROTATION_MS;
  try {
    const legacy = store?.getItem(LEGACY_ROTATION_KEY);
    return legacy == null || legacy.trim() === '' ? DEFAULT_ROTATION_MS : validateRotation(Number(legacy));
  } catch { return DEFAULT_ROTATION_MS; }
}
export function saveRotation(value: number, store = storage()) { write(ROTATION_KEY, { version: 1, holdMs: validateRotation(value) }, store); }
export function rotationDetent(value: number): number {
  if (value === 0) return 0;
  return Math.max(1, Math.min(27, Math.round((validateRotation(value) - 400) / 100) + 1));
}
export function rotationFromDetent(index: number): number { return ROTATION_DETENTS[Math.max(0, Math.min(27, Math.round(Number.isFinite(index) ? index : 9)))]; }

export function normalizeControllerName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CONTROLLER_NAME;
  const clean = Array.from(value.slice(0,1024).replace(/[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/gu, ' ').trim()).slice(0, 48).join('').trim();
  return clean || DEFAULT_CONTROLLER_NAME;
}
export function readControllerName(store = storage()): string {
  const doc = record(read(IDENTITY_KEY, store));
  return doc.version === 1 ? normalizeControllerName(doc.displayName) : DEFAULT_CONTROLLER_NAME;
}
export function saveControllerName(value: string, store = storage()) { write(IDENTITY_KEY, { version: 1, displayName: normalizeControllerName(value) }, store); }

export interface DesktopAppearance {
  intensity: number;
  border: { thickness: number; opacity: number; glow: number; fade: number; cornerSoftness: number };
  aurora: { speed: number; ribbons: number; softness: number; reaction: number };
  palette: { primary: string; secondary: string; accent: string };
  tint: { strength: number; reach: number };
  halo: { enabled: boolean; radius: number; opacity: number; softness: number; response: number };
  ripples: { enabled: boolean; size: number; strength: number; thickness: number; duration: number };
  label: { size: number; placement: 'topCenter' | 'topLeft' | 'topRight'; backing: number; announcementSeconds: number };
  motion: 'system' | 'reduce';
}
export type AppearancePreset = 'Subtle' | 'Balanced' | 'Expressive' | 'Custom';
export interface AppearanceDocument { version: 1; preset: AppearancePreset; value: DesktopAppearance; lastCustom: DesktopAppearance | null }
// Proposed starting values, not claims of measured comfort or visual quality.
const SUBTLE = appearanceSchema.defaults as DesktopAppearance;

export function appearancePreset(preset: Exclude<AppearancePreset, 'Custom'>): DesktopAppearance {
  const value = structuredClone(SUBTLE);
  for(const [path,setting] of Object.entries(appearanceSchema.presets[preset])) {
    const [group,key]=path.split('.');
    if(key)(value[group as keyof DesktopAppearance] as unknown as Record<string,unknown>)[key]=setting;
    else (value as unknown as Record<string,unknown>)[group]=setting;
  }
  return value;
}
export const APPEARANCE_RANGES: Record<string, readonly number[]> = appearanceSchema.ranges;

export function validateAppearance(raw: unknown): DesktopAppearance {
  const value = appearancePreset('Subtle');
  const input = record(raw);
  for (const [path, [min, max]] of Object.entries(APPEARANCE_RANGES)) {
    const [group, key] = path.split('.');
    const n = key ? record(input[group])[key] : input[group];
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    if (key) (value[group as keyof DesktopAppearance] as unknown as Record<string, unknown>)[key] = Math.min(max, Math.max(min, n));
    else value.intensity = Math.min(max, Math.max(min, n));
  }
  for (const key of ['primary', 'secondary', 'accent'] as const) {
    const color = record(input.palette)[key];
    if (typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)) value.palette[key] = color.toLowerCase();
  }
  for (const key of ['halo', 'ripples'] as const) {
    const enabled = record(input[key]).enabled;
    if (typeof enabled === 'boolean') value[key].enabled = enabled;
  }
  const placement = record(input.label).placement;
  if (placement === 'topCenter' || placement === 'topLeft' || placement === 'topRight') value.label.placement = placement;
  if (input.motion === 'reduce') value.motion = 'reduce';
  return value;
}
export function readAppearance(store = storage()): AppearanceDocument {
  const doc = record(read(APPEARANCE_KEY, store));
  const preset = ['Subtle', 'Balanced', 'Expressive', 'Custom'].includes(String(doc.preset)) ? doc.preset as AppearancePreset : 'Subtle';
  return { version: 1, preset: doc.version === 1 ? preset : 'Subtle', value: validateAppearance(doc.version === 1 ? doc.value : undefined), lastCustom: doc.version === 1 && doc.lastCustom ? validateAppearance(doc.lastCustom) : null };
}
export function saveAppearance(doc: AppearanceDocument, store = storage()) {
  write(APPEARANCE_KEY, { version: 1, preset: doc.preset, value: validateAppearance(doc.value), lastCustom: doc.lastCustom ? validateAppearance(doc.lastCustom) : null }, store);
}
export function selectAppearancePreset(doc: AppearanceDocument, preset: AppearancePreset): AppearanceDocument {
  return { version: 1, preset, value: preset === 'Custom' ? validateAppearance(doc.lastCustom ?? doc.value) : appearancePreset(preset), lastCustom: doc.preset === 'Custom' ? validateAppearance(doc.value) : doc.lastCustom };
}
export function changeAppearance(doc: AppearanceDocument, value: DesktopAppearance): AppearanceDocument {
  const clean = validateAppearance(value);
  return { version: 1, preset: 'Custom', value: clean, lastCustom: structuredClone(clean) };
}
export function resetAppearanceGroup(doc: AppearanceDocument, group: keyof DesktopAppearance): AppearanceDocument {
  return changeAppearance(doc, { ...doc.value, [group]: appearancePreset('Subtle')[group] });
}
export interface SavedRemoteView { version: 1; mode: 'single' | 'all'; selectedDisplayId: string | null; zoom: number; panX: number; panY: number }
export function readView(store = storage()): SavedRemoteView {
  const doc = record(read(VIEW_KEY, store));
  const finite = (n: unknown, d: number, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
  return { version: 1, mode: doc.version === 1 && doc.mode === 'all' ? 'all' : 'single', selectedDisplayId: typeof doc.selectedDisplayId === 'string' ? doc.selectedDisplayId.slice(0, 256) : null, zoom: finite(doc.zoom, 1, .25, 10), panX: finite(doc.panX, 0, -100000, 100000), panY: finite(doc.panY, 0, -100000, 100000) };
}
export function saveView(value: SavedRemoteView, store = storage()) { write(VIEW_KEY, value, store); }
