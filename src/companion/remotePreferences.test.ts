import { describe, expect, it } from 'vitest';
import { APPEARANCE_KEY, DEFAULT_ROTATION_MS, IDENTITY_KEY, LEGACY_ROTATION_KEY, ROTATION_DETENTS, ROTATION_KEY, appearancePreset, changeAppearance, normalizeControllerName, readAppearance, readControllerName, readRotation, resetAppearanceGroup, rotationDetent, rotationFromDetent, saveAppearance, saveRotation, selectAppearancePreset, validateAppearance } from './remotePreferences';
function memory(values: Record<string,string> = {}) {
  const data = new Map(Object.entries(values));
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
describe('independent remote preferences', () => {
  it('distinguishes absent, Off and every existing valid saved timing', () => {
    expect(readRotation(memory())).toBe(1200);
    expect(readRotation(memory({[LEGACY_ROTATION_KEY]: '0'}))).toBe(0);
    for (let ms = 400; ms <= 3000; ms += 1) expect(readRotation(memory({[LEGACY_ROTATION_KEY]:String(ms)}))).toBe(ms);
    const store = memory(); saveRotation(0,store);
    expect(readRotation(store)).toBe(0);
    expect(JSON.parse(store.getItem(ROTATION_KEY)!)).toEqual({version:1,holdMs:0});
  });
  it('keeps corrupt or out-of-range settings away from native rendering', () => {
    for (const bad of ['', 'NaN', 'null', '-1','100','3001','Infinity','{}']) expect(readRotation(memory({[LEGACY_ROTATION_KEY]:bad}))).toBe(DEFAULT_ROTATION_MS);
    expect(readRotation(memory({[ROTATION_KEY]:'{bad', [LEGACY_ROTATION_KEY]:'2300'}))).toBe(1200);
    expect(readRotation(memory({[ROTATION_KEY]:'{"version":2,"holdMs":0}'}))).toBe(1200);
  });
  it('has a distinct Off detent without unintended 100/200/300ms positions', () => {
    expect(ROTATION_DETENTS).toHaveLength(28);
    expect(ROTATION_DETENTS.slice(0,3)).toEqual([0,400,500]);
    ROTATION_DETENTS.forEach((ms,i) => { expect(rotationFromDetent(i)).toBe(ms); expect(rotationDetent(ms)).toBe(i); });
    expect(rotationFromDetent(NaN)).toBe(1200);
  });
  it('preserves Unicode text and keeps device identity out of the chosen name', () => {
    expect(readControllerName(memory())).toBe('Remote User');
    expect(normalizeControllerName('  அருள் 👩🏽‍💻  ')).toBe('அருள் 👩🏽‍💻');
    expect(normalizeControllerName('\n\u0000\u202e')).toBe('Remote User');
    expect(Array.from(normalizeControllerName('😀'.repeat(100)))).toHaveLength(48);
    expect(readControllerName(memory({[IDENTITY_KEY]:JSON.stringify({version:1,displayName:'  Hana\nK  '})}))).toBe('Hana K');
  });
  it('validates all numeric and palette controls and falls back for non-finite values', () => {
    const a = validateAppearance({intensity: Infinity,border:{thickness:500,opacity:NaN,fade:-5},palette:{primary:'url(evil)',secondary:'#ABCDEF'},halo:{enabled:false},motion:'reduce'});
    expect(a.intensity).toBe(.45); expect(a.border.thickness).toBe(8); expect(a.border.fade).toBe(8); expect(a.border.opacity).toBe(.42);
    expect(a.palette.primary).toBe('#20d9c6'); expect(a.palette.secondary).toBe('#abcdef'); expect(a.halo.enabled).toBe(false); expect(a.motion).toBe('reduce');
  });
  it('keeps the last custom configuration across presets and scoped resets', () => {
    let doc = readAppearance(memory());
    expect(doc.preset).toBe('Subtle');
    doc = changeAppearance(doc,{...doc.value, intensity:.77, halo:{...doc.value.halo,radius:44}});
    doc = selectAppearancePreset(doc,'Expressive');
    doc = selectAppearancePreset(doc,'Balanced');
    doc = selectAppearancePreset(doc,'Custom');
    expect(doc.value.intensity).toBe(.77); expect(doc.value.halo.radius).toBe(44);
    doc = resetAppearanceGroup(doc,'halo');
    expect(doc.value.halo).toEqual(appearancePreset('Subtle').halo); expect(doc.value.intensity).toBe(.77);
    const store = memory({'gt.remote.streamTune':'untouched', secret:'untouched'}); saveAppearance(doc,store);
    expect(readAppearance(store)).toEqual(doc); expect(store.data.get('secret')).toBe('untouched'); expect(store.data.get('gt.remote.streamTune')).toBe('untouched');
    expect(store.data.has(APPEARANCE_KEY)).toBe(true);
  });
});
