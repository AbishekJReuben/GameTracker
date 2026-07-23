// What a note actually *is*, so the list can render it as itself rather than as
// undifferentiated grey text. The shapes here were chosen against the real note
// history on a working machine: mostly single-line snippets, with a long tail of
// pasted code, error dumps and diagnostics blocks.
//
// Everything is heuristic and deliberately conservative — misreading prose as
// code is far more annoying than missing a code block, so each rule needs
// positive evidence before it fires.

export type ClipContentKind =
  | "link" // the whole note is one URL
  | "command" // a single shell/CLI line
  | "code" // a source snippet
  | "json" // JSON or a JSON-lines log
  | "log" // stack trace, error output, diagnostics dump
  | "path" // a filesystem path
  | "text"; // anything else

export interface ClipContent {
  kind: ClipContentKind;
  /** Label shown on the block's badge ("TypeScript", "Error", "Shell"…). */
  label?: string;
  /** Present for `link`: the normalized, absolute URL. */
  url?: string;
  /** True when the body should be rendered monospaced in a scrollable block. */
  mono: boolean;
}

/* ------------------------------------------------------------------ links -- */

// Bare hosts (amazon.in/…, github.com/x) are extremely common in pasted text and
// share sheets. Matching "something.something" alone would swallow file names
// (main.rs), version strings (3.9.81) and sentence ends ("done.Next"), so the
// last label must be a TLD we actually recognize.
const TLDS =
  "com|in|org|net|io|gg|dev|app|co|me|ai|tv|xyz|uk|us|edu|gov|info|biz|online|site|shop|store|cloud|page|link|live|news|blog|game|games|gl|ly|be|to|sh|fm|so|it|de|fr|jp|au|ca|nl|se|no|es|br|ru|cn|pl|ch|at|dk|fi|ie|nz|za|kr|tw|hk|sg|ae|id|my|ph|th|vn|pk|bd|lk|np";

const SCHEME_URL = /https?:\/\/[^\s<>()[\]{}"']+/i;
const BARE_URL = new RegExp(
  // optional www., at least one dot-separated label, a known TLD, then an
  // optional path/query. Not preceded by @ (emails) or / or a word character.
  String.raw`(?<![\w@./-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${TLDS}))(?![a-z])(?:[:/?#][^\s<>()[\]{}"']*)?`,
  "i",
);

/** Trailing sentence punctuation is almost never part of the link. */
function trimUrlTail(raw: string): string {
  let out = raw;
  while (out.length > 1 && /[.,;:!?'"]$/.test(out)) out = out.slice(0, -1);
  // Balance a trailing ")" only if the URL has no matching "(" — Wikipedia-style
  // links legitimately end in one.
  while (out.endsWith(")") && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * First link in the text as an absolute URL, accepting bare hosts. Returns null
 * when there is nothing link-shaped, so callers can skip the preview entirely.
 */
export function firstHttpUrl(text?: string | null): string | null {
  if (!text) return null;
  const withScheme = text.match(SCHEME_URL)?.[0];
  const raw = withScheme ?? text.match(BARE_URL)?.[0];
  if (!raw) return null;
  const cleaned = trimUrlTail(raw);
  const candidate = withScheme ? cleaned : `https://${cleaned}`;
  try {
    const url = new URL(candidate);
    // A host with no dot ("https://localhost") is not a real destination here.
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- code sniff -- */

const COMMANDS =
  /^(?:sudo\s+)?(?:npm|npx|pnpm|yarn|bun|git|cargo|rustup|python3?|pip3?|node|deno|go|docker|kubectl|adb|gradlew|\.\/gradlew|\.\/mvnw|mvn|curl|wget|ssh|scp|cd|ls|dir|cat|echo|mkdir|rm|cp|mv|touch|chmod|winget|choco|scoop|brew|apt|apt-get|dotnet|java|javac|tsc|vite|make|cmake|ffmpeg|tar|zip|unzip|robocopy|netstat|tasklist|taskkill|reg|wmic|powershell|pwsh|bash|sh)\b/;

const WINDOWS_PATH = /^[A-Za-z]:[\\/][^\n:*?"<>|]*$/;
const UNC_PATH = /^\\\\[^\n]+$/;
const POSIX_PATH = /^(?:~|\.{0,2})\/[^\s\n:*?"<>|]+$/;

// Unambiguous machine output: if one of these appears, no amount of surrounding
// prose makes the note anything other than a log.
const STRONG_LOG = [
  /^\s*at\s+[\w$.<>]+\s*\(/m, // JVM / JS stack frame
  /^\s*File\s+"[^"]+",\s+line\s+\d+/m, // Python traceback
  /^Traceback \(most recent call last\)/m,
  /^\s*Caused by:/m,
  /\b[A-Z]\w*(?:Error|Exception)\b\s*:/,
  /^error\[E\d{2,4}\]/m, // rustc
  /^error TS\d{4}/m, // tsc
  /panicked at/,
  /^\s*\d{1,3}\s*\|\s/m, // rustc/vite code frame gutter
  /^(?:FAILURE|BUILD FAILED|FAILED|\* What went wrong:)/m, // gradle
  /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/m, // timestamped log line
  /^\s*===.*===\s*$/m, // the app's own diagnostics dumps
  /^\s*(?:Failed to |Uncaught |Unhandled |Warning: |ERROR|FATAL)/m,
  /\bException in thread\b/,
  // A short standalone "… diagnostics …" banner — how every dump this app and
  // its companions emit announces itself.
  /^[^\n]{0,80}\bdiagnostics\b[^\n]{0,40}$/im,
];

// A unified diff / patch. Distinctive enough to detect on its own, and much
// nicer to read as a block than as wrapped prose.
const DIFF = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|(?:---|\+\+\+) )/m;

/** Fraction of non-empty lines that are themselves machine output. */
function machineLineRatio(text: string): number {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return 0;
  const hits = lines.filter((l) => STRONG_LOG.some((re) => re.test(l))).length;
  return hits / lines.length;
}

/** Fraction of non-empty lines that read as `key: value` / `key=value`. */
function keyValueRatio(text: string): number {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return 0;
  const kv = lines.filter(
    (l) =>
      /^\s*[\w.$-]+\s*[:=]\s*\S/.test(l) &&
      // Exclusions matter more than the rule: a TypeScript interface body and a
      // YAML-ish diagnostics dump look identical until you notice that code
      // lines terminate (`;` `,` `{`) and carry call/arrow syntax.
      !/[;{},]\s*$/.test(l) &&
      !/=>|\(\)|\[\]|\breturn\b/.test(l) &&
      !/[.!?]\s*$/.test(l),
  ).length;
  return kv / lines.length;
}

/**
 * How much this reads like someone writing to another person. Prose is the
 * default for a reason: the corpus is mostly notes-to-self and pasted chat, and
 * a stray "ERROR" or a semicolon must not turn a paragraph into a code block.
 */
function proseRatio(text: string): number {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return 0;
  const prosey = lines.filter((l) => {
    const words = l.trim().split(/\s+/);
    const alpha = words.filter((w) => /^[A-Za-z][A-Za-z']*$/.test(w)).length;
    // Either a full sentence, or simply a long run of ordinary words.
    return (alpha >= 4 && /[.!?,;:]\s*$/.test(l)) || alpha >= 6;
  }).length;
  return prosey / lines.length;
}

/** Language markers, scored highlight.js-style: most distinctive hits win. */
const LANGUAGES: { label: string; id: string; hints: RegExp[] }[] = [
  { label: "TypeScript", id: "ts", hints: [/\binterface\s+\w+\s*\{/, /:\s*(?:string|number|boolean|void|unknown|any)\b/, /\bexport\s+(?:type|interface)\b/, /\bas\s+const\b/, /<[A-Z]\w*(?:,\s*\w+)*>\(/] },
  { label: "JavaScript", id: "js", hints: [/\b(?:const|let)\s+\w+\s*=/, /=>\s*[{(]/, /\bfunction\s*\w*\s*\(/, /\brequire\(['"]/, /\bconsole\.\w+\(/, /\bexport\s+default\b/] },
  { label: "Rust", id: "rs", hints: [/\bfn\s+\w+\s*[(<]/, /\blet\s+mut\b/, /\bimpl\b[^\n]*\bfor\b/, /::\w+/, /\bpub\s+(?:fn|struct|enum|mod)\b/, /\bmatch\s+\w+\s*\{/] },
  { label: "Java", id: "java", hints: [/\b(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\]]+\s+\w+\s*\(/, /\bnew\s+[A-Z]\w*\s*\(/, /\bimport\s+(?:java|android|androidx)\./, /@Override\b/] },
  { label: "Kotlin", id: "kt", hints: [/\bfun\s+\w+\s*\(/, /\bval\s+\w+\s*[:=]/, /\bvar\s+\w+\s*:\s*\w+/, /\bcompanion\s+object\b/] },
  { label: "Python", id: "py", hints: [/^\s*def\s+\w+\s*\(/m, /^\s*from\s+[\w.]+\s+import\b/m, /^\s*import\s+\w+$/m, /\bself\./, /\belif\b/, /:\s*$/m] },
  { label: "C#", id: "cs", hints: [/\busing\s+System\b/, /\bnamespace\s+\w+/, /\bvar\s+\w+\s*=\s*new\b/, /\bpublic\s+class\b/] },
  { label: "Go", id: "go", hints: [/\bfunc\s+\w*\s*\(/, /\bpackage\s+main\b/, /:=/, /\bimport\s+\(/] },
  { label: "SQL", id: "sql", hints: [/\bselect\b[\s\S]*\bfrom\b/i, /\binsert\s+into\b/i, /\bcreate\s+table\b/i, /\bwhere\b.*\band\b/i] },
  { label: "HTML", id: "html", hints: [/<\/(?:div|span|p|a|body|html|section|button)>/i, /<!DOCTYPE html>/i, /<[a-z]+\s+[\w-]+=["']/i] },
  { label: "CSS", id: "css", hints: [/[.#]?[\w-]+\s*\{[^}]*:[^}]*;[\s\S]*\}/, /@media\b/, /--[\w-]+\s*:/] },
  { label: "Shell", id: "sh", hints: [/^\s*#!/, /\$\{?\w+\}?/, /\|\s*(?:grep|awk|sed|head|tail)\b/, /^\s*(?:export|source)\s+\w+/m] },
  { label: "XML", id: "xml", hints: [/<\?xml\b/, /<manifest\b/, /xmlns:/] },
];

/** Structural evidence that a block is code rather than prose. */
function codeScore(text: string): number {
  const lines = text.split("\n");
  const dense = lines.filter((l) => /[{};()[\]=<>]/.test(l)).length / Math.max(1, lines.length);
  const indented = lines.filter((l) => /^(?:\s{2,}|\t)/.test(l)).length / Math.max(1, lines.length);
  let score = 0;
  if (dense > 0.45) score += 2;
  if (dense > 0.7) score += 1;
  if (indented > 0.25) score += 1;
  if (/;\s*$/m.test(text)) score += 1;
  if (/^\s*(?:\/\/|#|\/\*|\*)/m.test(text)) score += 1;
  if (/\b(?:function|const|let|var|def|fn|class|struct|impl|public|private|import|export|return|if|else|for|while)\b/.test(text)) score += 1;
  // Prose gives itself away: long runs of words with no punctuation soup.
  const words = text.split(/\s+/).filter(Boolean);
  const wordy = words.filter((w) => /^[A-Za-z']{2,}$/.test(w)).length / Math.max(1, words.length);
  if (wordy > 0.8) score -= 3;
  return score;
}

/**
 * Highest-scoring language, but only when it wins outright. Sibling languages
 * share most of their syntax, so a one-point lead means nothing — a tie falls
 * back to a plain "Code" badge rather than naming the wrong language.
 */
function guessLanguage(text: string): string | undefined {
  const scored = LANGUAGES.map((lang) => ({
    label: lang.label,
    score: lang.hints.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0),
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < 2) return undefined;
  if (next && next.score === best.score) return undefined;
  return best.label;
}

function isJson(text: string): boolean {
  const s = text.trim();
  if (!/^[[{]/.test(s)) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    // JSON-lines (one object per line) is what most structured logs actually are.
    const lines = s.split("\n").filter((l) => l.trim());
    if (lines.length < 2) return false;
    const ok = lines.filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    }).length;
    return ok / lines.length > 0.8;
  }
}

/* -------------------------------------------------------------- classify --- */

/** Decide how a note should be presented. Never throws. */
export function classifyClip(text?: string | null): ClipContent {
  const raw = (text ?? "").trim();
  if (!raw) return { kind: "text", mono: false };
  const lines = raw.split("\n");
  const single = lines.length === 1;

  // A note that is *only* a link is a link, whatever else it looks like.
  const url = firstHttpUrl(raw);
  if (single && url) {
    const bare = raw.replace(/^https?:\/\//i, "");
    const target = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    if (bare.replace(/\/$/, "") === target) return { kind: "link", url, mono: false };
  }

  if (single && (WINDOWS_PATH.test(raw) || UNC_PATH.test(raw) || POSIX_PATH.test(raw))) {
    return { kind: "path", label: "Path", mono: true };
  }

  if (single && COMMANDS.test(raw) && raw.length < 400) {
    return { kind: "command", label: "Shell", mono: true };
  }

  if (isJson(raw)) return { kind: "json", label: "JSON", mono: true };

  // `\w*` so compound type names count — IllegalStateException, TypeError.
  const failed = /\b\w*(?:error|exception)\b|\b(?:failed|failure|panicked|fatal)\b/i.test(raw);
  const asLog = (): ClipContent => ({ kind: "log", label: failed ? "Error" : "Log", mono: true });

  const prose = proseRatio(raw);

  // Machine output is checked before code: a stack trace is full of code-ish
  // punctuation and would otherwise be labelled with whatever language it names.
  // A long note that merely quotes one error line stays prose, though — the
  // corpus is full of instructions that mention a failure in passing.
  if (STRONG_LOG.some((re) => re.test(raw)) && (prose <= 0.6 || machineLineRatio(raw) > 0.2)) {
    return asLog();
  }

  if (DIFF.test(raw)) return { kind: "code", label: "Diff", mono: true };

  // A block of `key: value` lines is a diagnostics dump, not source.
  if (!single && keyValueRatio(raw) > 0.5) return asLog();

  // Everything below can be confused with writing, so prose wins ties. Measured
  // against the real note history, where paragraphs of instructions are by far
  // the most common thing pasted — including long ones that quote code partway
  // through, which read far better as text than as one giant code block.
  if (prose > 0.45) return { kind: "text", mono: false };

  if (!single && codeScore(raw) >= 3) {
    return { kind: "code", label: guessLanguage(raw) ?? "Code", mono: true };
  }

  // Machine output that named no stack frame and no level — a bare "403
  // FORBIDDEN" line, a service's status spew.
  if (!single && failed) return asLog();

  // Single-line code is real (a one-line function, a selector) but the evidence
  // bar is higher, since most single-line notes are just text.
  if (single && raw.length > 24 && codeScore(raw) >= 4) {
    return { kind: "code", label: guessLanguage(raw) ?? "Code", mono: true };
  }

  return { kind: "text", mono: false };
}

/* ------------------------------------------------------------ highlighting - */

export type Token = { text: string; type: "plain" | "comment" | "string" | "number" | "keyword" | "punct" | "meta" };

const KEYWORDS = new RegExp(
  String.raw`\b(?:abstract|any|as|async|await|bool|boolean|break|case|catch|class|const|constructor|continue|crate|def|default|delete|do|double|elif|else|enum|except|export|extends|extern|false|final|finally|float|fn|for|from|func|function|if|impl|implements|import|in|instanceof|int|interface|is|let|lambda|match|mod|module|mut|namespace|new|None|not|null|nullptr|number|object|or|override|package|pass|private|protected|pub|public|raise|readonly|record|ref|return|self|static|str|string|struct|super|switch|this|throw|throws|trait|true|try|type|typeof|union|unsafe|use|val|var|void|when|where|while|with|yield)\b`,
);

// One pass, alternation ordered so comments and strings win over everything.
const TOKENIZER = new RegExp(
  [
    String.raw`(?<comment>\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)`,
    String.raw`(?<string>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`(?:[^\`\\]|\\.)*\`)`,
    String.raw`(?<number>\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b)`,
    String.raw`(?<meta>@[A-Za-z_]\w*|#\[[^\]]*\])`,
    String.raw`(?<word>[A-Za-z_$][\w$]*)`,
    String.raw`(?<punct>[{}()[\];:,.<>=+\-*/%!&|^~?]+)`,
  ].join("|"),
  "g",
);

/**
 * Minimal multi-language tokenizer. Deliberately not a dependency: a real
 * highlighter is a six-figure byte cost for a notes panel, and the shared
 * grammar of comments / strings / numbers / keywords covers every language that
 * actually turns up here. Unknown syntax simply falls through as plain text.
 */
export function tokenizeCode(source: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  TOKENIZER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKENIZER.exec(source))) {
    if (m.index > last) out.push({ text: source.slice(last, m.index), type: "plain" });
    const g = m.groups!;
    if (g.comment) out.push({ text: m[0], type: "comment" });
    else if (g.string) out.push({ text: m[0], type: "string" });
    else if (g.number) out.push({ text: m[0], type: "number" });
    else if (g.meta) out.push({ text: m[0], type: "meta" });
    else if (g.word) out.push({ text: m[0], type: KEYWORDS.test(m[0]) ? "keyword" : "plain" });
    else out.push({ text: m[0], type: "punct" });
    last = m.index + m[0].length;
    if (m[0].length === 0) TOKENIZER.lastIndex++; // guard against zero-width loops
  }
  if (last < source.length) out.push({ text: source.slice(last), type: "plain" });
  return out;
}

/** Log lines carry severity rather than syntax; colour by what went wrong. */
export type LogSeverity = "error" | "warn" | "info" | "plain";

export function logSeverity(line: string): LogSeverity {
  if (/\b\w*(?:error|exception)\b|\b(?:failed|failure|fatal|panicked)\b|^E\//i.test(line)) return "error";
  if (/\b(?:warn|warning|deprecated|W\/)\b/i.test(line)) return "warn";
  if (/^\s*(?:at\s|File\s"|Caused by:|\d+\s*\|)/.test(line)) return "info";
  return "plain";
}
