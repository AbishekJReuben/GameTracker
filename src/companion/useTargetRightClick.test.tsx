import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { PointerEvent } from "react";
import { useTargetRightClick } from "./useTargetRightClick";

const event = (type: string, id = 1, x = 100, y = 200) => ({
  type, pointerId: id, button: 0, clientX: x, clientY: y,
  preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() },
} as unknown as PointerEvent);

describe("Quest one-shot right-click targeting (non-visual)", () => {
  it("leaves normal gestures untouched unless explicitly armed", () => {
    const { result } = renderHook(() => useTargetRightClick(vi.fn(), vi.fn()));
    expect(result.current.onPointerDown(event("pointerdown"))).toBe(false);
    expect(result.current.onPointerUp(event("pointerup"))).toBe(false);
  });
  it("consumes the whole trigger gesture and moves before exactly one right click", () => {
    const calls: string[] = [];
    const { result } = renderHook(() => useTargetRightClick((x, y) => calls.push(`move:${x},${y}`), () => calls.push("right")));
    act(() => result.current.toggle());
    expect(result.current.armed).toBe(true);
    expect(result.current.onPointerDown(event("pointerdown"))).toBe(true);
    expect(result.current.onPointerMove(event("pointermove"))).toBe(true);
    act(() => { expect(result.current.onPointerUp(event("pointerup"))).toBe(true); });
    expect(calls).toEqual(["move:100,200", "right"]);
    expect(result.current.armed).toBe(false);
    expect(result.current.onPointerUp(event("pointerup"))).toBe(false);
  });
  it.each(["cancel", "drag", "multi-touch", "disconnected"])("does not click after %s", (reason) => {
    const click = vi.fn();
    const { result } = renderHook(() => useTargetRightClick(vi.fn(), click));
    act(() => result.current.toggle());
    result.current.onPointerDown(event("pointerdown"));
    if (reason === "drag") result.current.onPointerMove(event("pointermove", 1, 150));
    if (reason === "multi-touch") result.current.onPointerDown(event("pointerdown", 2));
    if (reason === "disconnected") act(() => result.current.cancel());
    act(() => { result.current.onPointerUp(event(reason === "cancel" ? "pointercancel" : "pointerup")); });
    expect(click).not.toHaveBeenCalled();
  });
  it("releases targeting state when disconnection loses the original pointer-up", () => {
    const { result } = renderHook(() => useTargetRightClick(vi.fn(), vi.fn()));
    act(() => result.current.toggle());
    result.current.onPointerDown(event("pointerdown", 1));
    act(() => result.current.cancel());
    expect(result.current.onPointerDown(event("pointerdown", 2))).toBe(false);
  });
});
