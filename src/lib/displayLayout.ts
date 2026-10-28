/** Physical-desktop geometry shared by viewing, presence and absolute input.
 * All native rectangles use physical pixels and half-open [x,x+w) bounds.
 * Frame-normalized endpoints map to the first/last physical pixel. */
export interface PhysicalRect { x: number; y: number; width: number; height: number }
export interface DisplayInfo extends PhysicalRect {
  id: string; index: number; name: string; rotation: number; isPrimary: boolean;
  selected: boolean; layoutRevision: number;
}
export interface DisplaySnapshot { revision: number; bounds: PhysicalRect; displays: DisplayInfo[] }
export type CaptureViewMode = 'single' | 'all';
export interface AppliedCaptureView {
  epoch: number; layoutRevision: number; mode: CaptureViewMode; selectedDisplayId: string;
  source: PhysicalRect; width: number; height: number; displays: DisplayInfo[];
}
export interface Point { x: number; y: number }
export interface VideoViewport { width: number; height: number; zoom: number; panX: number; panY: number }
export function validRect(r: PhysicalRect): boolean {
  return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
}
export function desktopBounds(displays: readonly PhysicalRect[]): PhysicalRect | null {
  const rects = displays.filter(validRect);
  if (!rects.length) return null;
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
}
export function displayAt(displays: readonly DisplayInfo[], p: Point): DisplayInfo | undefined {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
  return displays.find(d => p.x >= d.x && p.y >= d.y && p.x < d.x + d.width && p.y < d.y + d.height);
}
export function frameToDesktop(source: PhysicalRect, p: Point): Point | null {
  if (!validRect(source) || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return null;
  return { x: source.x + Math.round(p.x * (source.width - 1)), y: source.y + Math.round(p.y * (source.height - 1)) };
}
export function desktopToFrame(source: PhysicalRect, p: Point): Point {
  return { x: (p.x - source.x) / Math.max(1, source.width - 1), y: (p.y - source.y) / Math.max(1, source.height - 1) };
}
/** Contain-fit frame rectangle in client coordinates, including the existing
 * center-relative zoom and pixel pan. Caller subtracts the element's origin. */
export function videoContentRect(frameWidth: number, frameHeight: number, view: VideoViewport): PhysicalRect {
  const scale = Math.min(view.width / frameWidth, view.height / frameHeight) * view.zoom;
  const width = frameWidth * scale, height = frameHeight * scale;
  return { x: (view.width - width) / 2 + view.panX, y: (view.height - height) / 2 + view.panY, width, height };
}
export function clientToFrame(point: Point, content: PhysicalRect): Point | null {
  if (!validRect(content)) return null;
  const x = (point.x - content.x) / content.width, y = (point.y - content.y) / content.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
export function visibleDisplayIds(view: AppliedCaptureView, content: PhysicalRect, viewport: PhysicalRect): string[] {
  if (!validRect(content) || !validRect(view.source) || !validRect(viewport)) return [];
  return view.displays.filter(d => {
    const x = content.x + (d.x - view.source.x) / view.source.width * content.width;
    const y = content.y + (d.y - view.source.y) / view.source.height * content.height;
    const w = d.width / view.source.width * content.width, h = d.height / view.source.height * content.height;
    return Math.min(x + w, viewport.x + viewport.width) - Math.max(x, viewport.x) > 1e-6
      && Math.min(y + h, viewport.y + viewport.height) - Math.max(y, viewport.y) > 1e-6;
  }).map(d => d.id);
}
/** The part of the desktop the viewer can actually see (viewport ∩ frame), in
 * physical desktop pixels. Feeds the PC's viewing-area lens; null when nothing
 * of the frame is on screen. */
export function visibleDesktopRect(view: AppliedCaptureView, content: PhysicalRect, viewport: PhysicalRect): PhysicalRect | null {
  if (!validRect(content) || !validRect(view.source) || !validRect(viewport)) return null;
  const left = Math.max(content.x, viewport.x), top = Math.max(content.y, viewport.y);
  const right = Math.min(content.x + content.width, viewport.x + viewport.width), bottom = Math.min(content.y + content.height, viewport.y + viewport.height);
  if (right - left < 1 || bottom - top < 1) return null;
  const sx = view.source.width / content.width, sy = view.source.height / content.height;
  const x = Math.round(view.source.x + (left - content.x) * sx), y = Math.round(view.source.y + (top - content.y) * sy);
  const r = Math.round(view.source.x + (right - content.x) * sx), b = Math.round(view.source.y + (bottom - content.y) * sy);
  return { x, y, width: Math.max(1, r - x), height: Math.max(1, b - y) };
}
/** Uniformly fit encoder/decoder limits; limits apply to the combined image. */
export function fitCaptureSize(source: PhysicalRect, maxWidth: number, maxHeight = 4096, maxPixels = 8_294_400): { width: number; height: number } {
  if (!validRect(source)) return { width: 32, height: 32 };
  const scale = Math.min(1, Math.max(32, maxWidth) / source.width, Math.max(32, maxHeight) / source.height, Math.sqrt(Math.max(1024, maxPixels) / (source.width * source.height)));
  return { width: Math.max(32, Math.floor(source.width * scale / 2) * 2), height: Math.max(32, Math.floor(source.height * scale / 2) * 2) };
}
export function sameView(a: AppliedCaptureView | null, b: AppliedCaptureView | null): boolean {
  return !!a && !!b && a.epoch === b.epoch && a.layoutRevision === b.layoutRevision;
}
