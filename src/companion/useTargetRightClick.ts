import { useRef, useState, type PointerEvent } from "react";

/** One-shot context-click targeting for headsets with only a primary trigger.
 * Consumes the entire gesture so Control never sends a matching left down/up. */
export function useTargetRightClick(move: (x: number, y: number) => void, click: () => void) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const target = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const consumed = useRef(new Set<number>());
  const arm = (value: boolean) => { armedRef.current = value; setArmed(value); };
  return {
    armed,
    toggle: () => arm(!armedRef.current),
    cancel: () => { arm(false); target.current = null; consumed.current.clear(); },
    onPointerDown: (e: PointerEvent) => {
      if (!armedRef.current && consumed.current.size === 0) return false;
      e.preventDefault();
      consumed.current.add(e.pointerId);
      e.currentTarget.setPointerCapture?.(e.pointerId);
      if (consumed.current.size === 1 && e.button === 0) {
        target.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      } else target.current = null; // multi-touch is not a context click
      return true;
    },
    onPointerMove: (e: PointerEvent) => {
      if (!consumed.current.has(e.pointerId)) return false;
      const t = target.current;
      if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 14) t.moved = true;
      return true;
    },
    onPointerUp: (e: PointerEvent) => {
      if (!consumed.current.delete(e.pointerId)) return false;
      e.preventDefault();
      try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* lost capture */ }
      const t = target.current;
      if (t?.id === e.pointerId && !t.moved && e.type !== "pointercancel" && armedRef.current) {
        move(e.clientX, e.clientY);
        click();
      }
      target.current = null;
      if (consumed.current.size === 0) arm(false);
      return true;
    },
  };
}
