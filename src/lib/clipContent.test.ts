import { describe, it, expect } from "vitest";
import { classifyClip, firstHttpUrl, linkSegments, tokenizeCode } from "./clipContent";

describe("firstHttpUrl", () => {
  it("finds a plain http(s) url", () => {
    expect(firstHttpUrl("https://www.youtube.com/watch?v=3zlb_KbVLqw")).toBe(
      "https://www.youtube.com/watch?v=3zlb_KbVLqw",
    );
  });

  it("accepts a bare host with a path and query", () => {
    const raw =
      "amazon.in/Motomax-2K-Rubbing-Compound-100g/dp/B077TQRPZS?ref_=Oct_d_obs_d_5257491031_1&pd_rd_i=B077TQRPZS";
    expect(firstHttpUrl(raw)).toBe(`https://${raw}`);
  });

  it("accepts a bare host with no path", () => {
    expect(firstHttpUrl("offbrand.gg")).toBe("https://offbrand.gg/");
  });

  it("finds a url inside a sentence and drops the trailing period", () => {
    expect(firstHttpUrl("see github.com/AbishekJReuben/GameTracker.")).toBe(
      "https://github.com/AbishekJReuben/GameTracker",
    );
  });

  it("ignores file names, versions and identifiers", () => {
    for (const s of ["main.rs", "index.html", "3.9.81", "ClipboardService.java", "package.json", "vite.config.ts"]) {
      expect(firstHttpUrl(s), s).toBeNull();
    }
  });

  it("ignores email addresses", () => {
    expect(firstHttpUrl("chilloutstudioofficial@gmail.com")).toBeNull();
  });

  it("returns null for ordinary prose", () => {
    expect(firstHttpUrl("Sales filter should also have broadcast filters.")).toBeNull();
  });
});

describe("classifyClip", () => {
  it("treats a lone url as a link", () => {
    expect(classifyClip("https://github.com/awslabs/mcp").kind).toBe("link");
  });

  it("treats a lone bare url as a link", () => {
    expect(classifyClip("amazon.in/dp/B077TQRPZS?ref_=x").kind).toBe("link");
  });

  it("recognizes shell commands", () => {
    for (const s of ["npm run dev", "npx tsc --noEmit && vite build", "cargo check --message-format short", "git status"]) {
      expect(classifyClip(s), s).toMatchObject({ kind: "command", mono: true });
    }
  });

  it("recognizes windows and posix paths", () => {
    expect(classifyClip("H:\\Works\\ChilloutGames\\2026\\May\\GameTracker\\src-tauri").kind).toBe("path");
    expect(classifyClip("~/.gradle/caches/modules-2").kind).toBe("path");
  });

  it("recognizes json", () => {
    expect(classifyClip('{"timestamp":"2026-07-20T07:16:48.215Z","level":"LOG"}')).toMatchObject({ kind: "json" });
  });

  it("recognizes json-lines logs", () => {
    const jsonl = '{"a":1}\n{"a":2}\n{"a":3}';
    expect(classifyClip(jsonl).kind).toBe("json");
  });

  it("recognizes a java stack trace as an error", () => {
    const trace = [
      "java.lang.IllegalStateException: no such row",
      "\tat com.chilloutgames.gametracker.companion.ClipboardService.bindRow(ClipboardService.java:2847)",
      "\tat android.view.View.performClick(View.java:7448)",
      "Caused by: java.lang.NullPointerException",
    ].join("\n");
    expect(classifyClip(trace)).toMatchObject({ kind: "log", label: "Error" });
  });

  it("recognizes a rust compiler error", () => {
    const err = [
      "error[E0599]: no method named `into_json` found for struct `ureq::Response`",
      "  --> src/link_preview.rs:76:89",
      "   |",
      "76 |     if let Ok(body) = agent.get(&oembed).call()",
      "   |                                          ^^^^^^^^^",
    ].join("\n");
    expect(classifyClip(err)).toMatchObject({ kind: "log", label: "Error" });
  });

  it("recognizes a diagnostics dump as a log", () => {
    const dump = [
      "=== GameTracker shared-clipboard diagnostics ===",
      "Generated: 2026-07-20T07:24:13.555Z",
      "device: SENGALPC",
      "ws: open",
    ].join("\n");
    expect(classifyClip(dump).kind).toBe("log");
  });

  it("recognizes typescript", () => {
    const code = [
      "export interface ClipStore {",
      "  items: ClipItem[];",
      "  loading: boolean;",
      "  setFilter: (f: ClipFilter) => void;",
      "}",
    ].join("\n");
    expect(classifyClip(code)).toMatchObject({ kind: "code", label: "TypeScript" });
  });

  it("recognizes rust", () => {
    const code = [
      "pub fn fetch(raw: String) -> Result<LinkPreview, String> {",
      "    let mut url = safe_url(&raw)?;",
      "    match agent.get(url.as_str()).call() {",
      "        Ok(response) => response,",
      "    }",
      "}",
    ].join("\n");
    expect(classifyClip(code)).toMatchObject({ kind: "code", label: "Rust" });
  });

  it("recognizes python", () => {
    const code = ["def profile(rows):", "    for kind, text in rows:", "        print(kind, len(text))"].join("\n");
    expect(classifyClip(code)).toMatchObject({ kind: "code", label: "Python" });
  });

  it("leaves prose alone", () => {
    const prose = [
      "Site/Call visible",
      "Ability to view users",
      "Option to bookmark users in messages and users",
    ].join("\n");
    expect(classifyClip(prose)).toMatchObject({ kind: "text", mono: false });
  });

  it("leaves short single-line notes alone", () => {
    for (const s of ["permission", "admin", "Sales filter should also have broadcast filters."]) {
      expect(classifyClip(s), s).toMatchObject({ kind: "text", mono: false });
    }
  });

  it("does not mistake a message with punctuation for code", () => {
    const s = "Usage limit reached for 5 hour. Your limit will reset at 2026-07-20 21:46:48";
    expect(classifyClip(s).kind).toBe("text");
  });

  it("handles empty and whitespace input", () => {
    expect(classifyClip("").kind).toBe("text");
    expect(classifyClip("   \n  ").kind).toBe("text");
    expect(classifyClip(null).kind).toBe("text");
  });
});

describe("linkSegments", () => {
  it("returns one plain segment when there is no link", () => {
    expect(linkSegments("just some prose")).toEqual([{ text: "just some prose" }]);
  });

  it("splits a link out of a sentence and keeps the punctuation outside it", () => {
    const segs = linkSegments("check https://github.com/x/y. thanks");
    expect(segs.map((s) => s.text).join("")).toBe("check https://github.com/x/y. thanks");
    expect(segs.filter((s) => s.url)).toHaveLength(1);
    expect(segs.find((s) => s.url)?.text).toBe("https://github.com/x/y");
  });

  it("handles several links, bare and schemed", () => {
    const segs = linkSegments("see amazon.in/dp/B077TQRPZS and https://offbrand.gg/devs/ too");
    const links = segs.filter((s) => s.url);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe("https://amazon.in/dp/B077TQRPZS");
    expect(links[1].url).toBe("https://offbrand.gg/devs/");
  });

  it("never loses or duplicates text", () => {
    for (const s of ["a github.com/x b amazon.in c", "https://a.com https://b.com", "no links here", ""]) {
      expect(linkSegments(s).map((x) => x.text).join(""), s).toBe(s);
    }
  });

  it("does not linkify a version number mid-sentence", () => {
    expect(linkSegments("bumped to 3.9.81 today").filter((s) => s.url)).toHaveLength(0);
  });
});

describe("C# detection", () => {
  it("recognizes a class with auto-properties", () => {
    const code = [
      "using System;",
      "using System.Collections.Generic;",
      "",
      "namespace GameTracker.Sensors",
      "{",
      "    public sealed class SensorReading",
      "    {",
      "        public string Name { get; init; }",
      "        public double Value { get; set; }",
      "    }",
      "}",
    ].join("\n");
    expect(classifyClip(code)).toMatchObject({ kind: "code", label: "C#" });
  });

  it("recognizes an async method body", () => {
    const code = [
      "public async Task<List<string>> LoadAsync(string[] args)",
      "{",
      "    var items = new List<string>();",
      "    foreach (var a in args) { items.Add(a); }",
      "    Console.WriteLine(nameof(LoadAsync));",
      "    return items;",
      "}",
    ].join("\n");
    expect(classifyClip(code)).toMatchObject({ kind: "code", label: "C#" });
  });
});

describe("tokenizeCode", () => {
  it("round-trips the source exactly", () => {
    const src = 'const x = "a\\"b"; // note\nfn main() { 0x1F }';
    expect(tokenizeCode(src).map((t) => t.text).join("")).toBe(src);
  });

  it("tags comments, strings, numbers and keywords", () => {
    const types = new Set(tokenizeCode('const n = 42; // hi\nlet s = "x";').map((t) => t.type));
    expect(types).toContain("keyword");
    expect(types).toContain("number");
    expect(types).toContain("comment");
    expect(types).toContain("string");
  });

  it("terminates on pathological input", () => {
    expect(() => tokenizeCode("`".repeat(500))).not.toThrow();
    expect(() => tokenizeCode("/*".repeat(500))).not.toThrow();
  });
});
