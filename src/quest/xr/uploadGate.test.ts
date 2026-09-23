import { describe, expect, it } from "vitest";
import { newUploadGate, shouldUploadVideoFrame } from "./session";

describe("XR video upload gate", () => {
  it("uploads only when the decoded-frame counter advances, with a 500ms safety refresh", () => {
    const g = newUploadGate();
    expect(shouldUploadVideoFrame(g, 1, 0)).toBe(true); // first frame
    expect(shouldUploadVideoFrame(g, 1, 11)).toBe(false); // same frame, next XR tick
    expect(shouldUploadVideoFrame(g, 1, 22)).toBe(false);
    expect(shouldUploadVideoFrame(g, 2, 33)).toBe(true); // new frame
    expect(shouldUploadVideoFrame(g, 2, 44)).toBe(false);
    expect(shouldUploadVideoFrame(g, 2, 540)).toBe(true); // stale > 500ms: refresh anyway
  });

  it("keeps uploading every frame while learning and forever if the counter never moves", () => {
    const g = newUploadGate();
    for (let t = 0; t <= 2000; t += 11) expect(shouldUploadVideoFrame(g, 0, t)).toBe(true);
    // Past the learning window with a dead counter: behave exactly like before.
    expect(shouldUploadVideoFrame(g, 0, 2100)).toBe(true);
    expect(g.counterWorks).toBe(false);
    expect(shouldUploadVideoFrame(g, 0, 2111)).toBe(true);
  });

  it("treats an unsupported API (-1) like a dead counter", () => {
    const g = newUploadGate();
    expect(shouldUploadVideoFrame(g, -1, 0)).toBe(true);
    expect(shouldUploadVideoFrame(g, -1, 11)).toBe(true);
  });
});
