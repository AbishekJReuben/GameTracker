import { expect, it } from "vitest";

// The old overlay called setResizable in three places without ever being granted it,
// so every call failed silently and the bubble kept its resize frame.

const sources = import.meta.glob(["./*.ts", "./*.tsx", "!./*.test.*"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const files = import.meta.glob("../../src-tauri/capabilities/notes.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const capability = JSON.parse(Object.values(files)[0]) as { windows: string[]; permissions: string[] };

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

it("the panel only calls window APIs it has been granted", () => {
  const code = Object.values(sources).join("\n");
  const calls = [...code.matchAll(/getCurrentWindow\(\)\s*\.(\w+)\(/g)].map((m) => m[1]);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(capability.permissions).toContain(`core:window:allow-${kebab(call)}`);
  if (code.includes("data-tauri-drag-region")) expect(capability.permissions).toContain("core:window:allow-start-dragging");
});

it("the capability belongs to the panel alone", () => {
  expect(capability.windows).toEqual(["notes-panel"]);
});
