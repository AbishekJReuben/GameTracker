import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// The old overlay called setResizable in three places without ever being granted it,
// so every call failed silently and the bubble kept its resize frame.

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

it("the panel only calls window APIs it has been granted", () => {
  const granted: string[] = JSON.parse(readFileSync("src-tauri/capabilities/notes.json", "utf8")).permissions;
  const code = sources("src/notes").map((f) => readFileSync(f, "utf8")).join("\n");
  const calls = [...code.matchAll(/getCurrentWindow\(\)\s*\.(\w+)\(/g)].map((m) => m[1]);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(granted).toContain(`core:window:allow-${kebab(call)}`);
  if (code.includes("data-tauri-drag-region")) expect(granted).toContain("core:window:allow-start-dragging");
});

it("the panel page has no window it isn't declared for", () => {
  const capability = JSON.parse(readFileSync("src-tauri/capabilities/notes.json", "utf8"));
  expect(capability.windows).toEqual(["notes-panel"]);
});
