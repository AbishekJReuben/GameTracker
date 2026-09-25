import { expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import frameGateSource from "../../public/frame-gate.js?raw";

const native = vi.hoisted(() => {
  const callbacks: Record<string, () => void> = {};
  return {
    callbacks,
    isVisible: vi.fn(async () => true),
    isMinimized: vi.fn(async () => false),
    onFocusChanged: vi.fn(async (fn: () => void) => { callbacks.focus = fn; return () => {}; }),
    onResized: vi.fn(async (fn: () => void) => { callbacks.resize = fn; return () => {}; }),
    onCloseRequested: vi.fn(async (fn: () => void) => { callbacks.close = fn; return () => {}; }),
  };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("stops Motion's JS loops behind the tray and restarts them on show", async () => {
  // As index.html does it: the gate first, then modules. Motion captures rAF at import.
  new Function(frameGateSource)();
  const { motion } = await import("motion/react");
  const { installDesktopVisibility, subscribeUiVisibility } = await import("./useVisible");
  await installDesktopVisibility();
  const unsubscribe = subscribeUiVisibility(() => {});

  const { getByTestId } = render(
    <motion.div
      data-testid="loop"
      animate={{ x: [0, 100, 0] }}
      transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
    />,
  );
  const el = getByTestId("loop");
  const moves = async (ms: number) => {
    const before = el.style.transform;
    await sleep(ms);
    return el.style.transform !== before;
  };
  try {
    await sleep(100);
    expect(await moves(150)).toBe(true);

    native.callbacks.close();
    await sleep(50); // a frame already queued natively may still land
    expect(await moves(300)).toBe(false);

    native.callbacks.focus();
    await vi.waitFor(async () => expect(await moves(100)).toBe(true));
  } finally {
    unsubscribe();
  }
});
