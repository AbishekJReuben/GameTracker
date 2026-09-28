//! Turning transcript text into something that sounds natural when read aloud.
//!
//! Kokoro reads exactly what it's given, so Markdown, paths, URLs and version
//! strings have to be rewritten first: `**bold**` would be read as "asterisk",
//! `src/lib/useVisible.ts:42` as a string of slashes, and `3.9.107` as a date.

use serde_json::Value;

/// Which voice (and which rules) a line of narration uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Claude's own text.
    Reply,
    /// Thinking, when the transcript carries its text.
    Thinking,
    /// A tool call, as one short sentence.
    Action,
    /// A tool result.
    Output,
    /// An AskUserQuestion prompt: the question and its options.
    Question,
    /// Several old actions/outputs merged while the phone was behind.
    Summary,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Reply => "reply",
            Kind::Thinking => "thinking",
            Kind::Action => "action",
            Kind::Output => "output",
            Kind::Question => "question",
            Kind::Summary => "summary",
        }
    }
}

/// Markdown reply / thinking → plain sentences. Code blocks become a short
/// mention ("Code block, 12 lines.") because reading code aloud is noise.
pub fn prose(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut in_code = false;
    let mut code_lines = 0usize;
    for raw in md.lines() {
        let line = raw.trim_end();
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            if in_code {
                in_code = false;
                out.push_str(&format!(
                    "Code block, {} line{}. ",
                    code_lines,
                    if code_lines == 1 { "" } else { "s" }
                ));
            } else {
                in_code = true;
                code_lines = 0;
            }
            continue;
        }
        if in_code {
            code_lines += 1;
            continue;
        }
        if t.is_empty() {
            push_break(&mut out);
            continue;
        }
        // Table separator rows (|---|:--:|) carry nothing.
        if t.starts_with('|') && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')) {
            continue;
        }
        let mut s = t.to_string();
        // Headings, quotes and list markers.
        s = s.trim_start_matches('#').trim_start().to_string();
        s = s.trim_start_matches('>').trim_start().to_string();
        s = strip_list_marker(&s);
        // Table rows: cells become a comma list.
        if s.starts_with('|') {
            s = s
                .trim_matches('|')
                .split('|')
                .map(|c| c.trim())
                .filter(|c| !c.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
        }
        let s = inline(&s);
        if s.is_empty() {
            continue;
        }
        out.push_str(&s);
        // A line without its own ending (a list item, a heading) still needs a
        // pause, or the voice runs the items together.
        if !s.ends_with(['.', '!', '?', ':', ';', ',']) {
            out.push('.');
        }
        out.push(' ');
    }
    if in_code && code_lines > 0 {
        out.push_str(&format!("Code block, {code_lines} lines. "));
    }
    tidy(&out)
}

/// A tool result, read as text but capped: `max_chars == 0` means no cap.
pub fn output(text: &str, is_error: bool, max_chars: usize) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut in_reminder = false;
    for raw in text.lines() {
        let t = raw.trim();
        // Harness notes injected into results are for the model, not for you.
        if t.starts_with("<system-reminder>") {
            in_reminder = !t.ends_with("</system-reminder>");
            continue;
        }
        if in_reminder {
            if t.ends_with("</system-reminder>") {
                in_reminder = false;
            }
            continue;
        }
        let t = strip_ansi(t);
        // Read results come as `cat -n`: "   12\tcode".
        let t = strip_line_number(&t);
        if t.is_empty() || looks_binary(&t) {
            continue;
        }
        lines.push(inline(&t));
    }
    let total = lines.len();
    let mut spoken = String::new();
    let mut used = 0usize;
    for line in &lines {
        if max_chars > 0 && spoken.len() + line.len() > max_chars && used > 0 {
            break;
        }
        spoken.push_str(line);
        if !line.ends_with(['.', '!', '?', ':', ';', ',']) {
            spoken.push('.');
        }
        spoken.push(' ');
        used += 1;
    }
    if max_chars > 0 && spoken.len() > max_chars {
        let cut = floor_char_boundary(&spoken, max_chars);
        spoken.truncate(cut);
        spoken.push_str("… ");
    }
    let rest = total.saturating_sub(used);
    if rest > 0 {
        spoken.push_str(&format!(
            "And {rest} more line{}.",
            if rest == 1 { "" } else { "s" }
        ));
    }
    let spoken = tidy(&spoken);
    match (is_error, spoken.is_empty()) {
        (true, true) => "The command failed.".into(),
        (true, false) => format!("Error. {spoken}"),
        (false, true) => "No output.".into(),
        (false, false) => spoken,
    }
}

/// What a tool call did, for the backlog summary ("ran 4 commands, read 3 files").
pub fn category(tool: &str) -> &'static str {
    match tool {
        "Bash" | "PowerShell" => "command",
        "Read" => "read",
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "edit",
        "Grep" | "Glob" => "search",
        "WebFetch" | "WebSearch" => "web",
        _ => "other",
    }
}

/// A tool call → one short sentence, or `None` for plumbing nobody wants read.
pub fn action(tool: &str, input: &Value) -> Option<(Kind, String)> {
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let text = match tool {
        "Bash" | "PowerShell" => {
            let d = s("description");
            if d.is_empty() { "Running a command.".into() } else { d }
        }
        "Read" => format!("Reading {}.", file_name(&s("file_path"))),
        "Edit" | "MultiEdit" => format!("Editing {}.", file_name(&s("file_path"))),
        "Write" => format!("Writing {}.", file_name(&s("file_path"))),
        "NotebookEdit" => format!("Editing notebook {}.", file_name(&s("notebook_path"))),
        "Grep" => {
            let p = s("pattern");
            if p.len() <= 40 && p.chars().all(|c| c.is_alphanumeric() || " _-.".contains(c)) {
                format!("Searching the code for {p}.")
            } else {
                "Searching the code.".into()
            }
        }
        "Glob" => "Looking for files.".into(),
        "WebFetch" => format!("Opening {}.", host(&s("url"))),
        "WebSearch" => format!("Searching the web for {}.", s("query")),
        "TodoWrite" | "TaskCreate" | "TaskUpdate" => "Updating the task list.".into(),
        "Agent" | "Task" => {
            let d = s("description");
            if d.is_empty() { "Starting a helper agent.".into() } else { format!("Starting a helper: {d}.") }
        }
        "Skill" => format!("Loading the {} skill.", s("skill").replace([':', '-', '_'], " ")),
        "AskUserQuestion" => return question(input).map(|q| (Kind::Question, q)),
        // Plumbing: loading tool schemas says nothing about the work.
        "ToolSearch" => return None,
        _ => {
            // mcp__server__tool_name → "Using tool name".
            let short = tool.rsplit("__").next().unwrap_or(tool);
            format!("Using {}.", short.replace(['_', '-'], " "))
        }
    };
    Some((Kind::Action, tidy(&inline(&text))))
}

/// "Question: … Options: A; B; C." for every question in an AskUserQuestion call.
fn question(input: &Value) -> Option<String> {
    let qs = input.get("questions")?.as_array()?;
    let mut out = String::new();
    for q in qs {
        let text = q.get("question").and_then(Value::as_str).unwrap_or("");
        out.push_str("Question: ");
        out.push_str(&inline(text));
        out.push(' ');
        let opts: Vec<String> = q
            .get("options")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|o| o.get("label").and_then(Value::as_str))
                    .map(inline)
                    .collect()
            })
            .unwrap_or_default();
        if !opts.is_empty() {
            out.push_str("Options: ");
            out.push_str(&opts.join("; "));
            out.push_str(". ");
        }
    }
    let out = tidy(&out);
    (!out.is_empty()).then_some(out)
}

/// Inline Markdown and technical tokens → speakable words.
pub fn inline(s: &str) -> String {
    let mut s = s.to_string();
    // [text](url) → text
    s = replace_links(&s);
    // Emphasis and inline code markers.
    for m in ["**", "__", "`", "~~"] {
        s = s.replace(m, "");
    }
    s = strip_single_emphasis(&s);
    // Bare URLs → "a link to host".
    s = replace_urls(&s);
    // Paths → file name (+ line).
    s = replace_paths(&s);
    // Versions like 3.9.107 → "3 point 9 point 107".
    s = replace_versions(&s);
    s = s
        .replace("→", " to ")
        .replace("->", " to ")
        .replace("≈", " about ")
        .replace("×", " times ")
        .replace("e.g.", "for example")
        .replace("i.e.", "that is")
        .replace(" & ", " and ");
    // Emoji and other pictographs: the model has no sound for them.
    s.retain(|c| !is_pictograph(c));
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn push_break(out: &mut String) {
    let t = out.trim_end();
    if !t.is_empty() && !t.ends_with(['.', '!', '?', ':']) {
        out.truncate(t.len());
        out.push_str(". ");
    }
}

fn tidy(s: &str) -> String {
    let joined = s.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.replace(" .", ".").replace("..", ".").replace(". .", ".").trim().to_string()
}

fn strip_list_marker(s: &str) -> String {
    let t = s.trim_start();
    for m in ["- [ ] ", "- [x] ", "- ", "* ", "+ "] {
        if let Some(rest) = t.strip_prefix(m) {
            return rest.to_string();
        }
    }
    // "1. " / "12) "
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && digits < 4 {
        let rest = &t[digits..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return r.to_string();
        }
    }
    t.to_string()
}

fn strip_single_emphasis(s: &str) -> String {
    // *word* / _word_ at word boundaries; leave snake_case and a*b alone.
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '*' || c == '_' {
            let prev = if i > 0 { chars[i - 1] } else { ' ' };
            let next = chars.get(i + 1).copied().unwrap_or(' ');
            let opens = !prev.is_alphanumeric() && next.is_alphanumeric();
            let closes = prev.is_alphanumeric() && !next.is_alphanumeric();
            if opens || closes {
                continue;
            }
        }
        out.push(c);
    }
    out
}

fn replace_links(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('[') {
        let Some(close_rel) = rest[open..].find("](") else { break };
        let close = open + close_rel;
        let Some(end_rel) = rest[close + 2..].find(')') else { break };
        let end = close + 2 + end_rel;
        out.push_str(&rest[..open]);
        out.push_str(&rest[open + 1..close]);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

fn replace_urls(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            if w.starts_with("http://") || w.starts_with("https://") {
                format!("a link to {}", host(w))
            } else {
                w.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn host(url: &str) -> String {
    let no_scheme = url.split("://").nth(1).unwrap_or(url);
    let h = no_scheme.split(['/', '?', '#', ')', ']']).next().unwrap_or(no_scheme);
    h.trim_start_matches("www.").to_string()
}

/// `src/lib/useVisible.ts:42` → "useVisible.ts line 42"; `H:\a\b\c.rs` → "c.rs".
fn replace_paths(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            let trimmed = w.trim_matches(|c: char| "()[]{},;\"'".contains(c));
            let sep = trimmed.contains('/') || trimmed.contains('\\');
            let has_ext = trimmed
                .rsplit(['/', '\\'])
                .next()
                .map(|n| n.split(':').next().unwrap_or(n).contains('.'))
                .unwrap_or(false);
            if sep && has_ext && !trimmed.contains("://") {
                let (path, line) = match trimmed.rsplit_once(':') {
                    Some((p, l)) if !l.is_empty() && l.chars().all(|c| c.is_ascii_digit()) => (p, Some(l)),
                    _ => (trimmed, None),
                };
                let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
                let spoken = match line {
                    Some(l) => format!("{name} line {l}"),
                    None => name.to_string(),
                };
                w.replace(trimmed, &spoken)
            } else {
                w.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Dotted versions with two or more dots ("3.9.107", "v1.13.8"). A single dot is
/// a decimal and reads fine as it is.
fn replace_versions(s: &str) -> String {
    s.split(' ')
        .map(|w| {
            let core = w.trim_end_matches(|c: char| ",;:.!?)".contains(c));
            let tail = &w[core.len()..];
            let body = core.strip_prefix('v').unwrap_or(core);
            let parts: Vec<&str> = body.split('.').collect();
            if parts.len() >= 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
                let prefix = if core.starts_with('v') { "version " } else { "" };
                format!("{prefix}{}{tail}", parts.join(" point "))
            } else {
                w.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn file_name(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    if name.is_empty() { "a file".into() } else { name.to_string() }
}

fn strip_line_number(t: &str) -> String {
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 {
        let rest = &t[digits..];
        if let Some(r) = rest.strip_prefix('\t').or_else(|| rest.strip_prefix('→')) {
            return r.trim().to_string();
        }
    }
    t.to_string()
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Base64 blobs, hex dumps and minified lines: long runs with no spaces.
fn looks_binary(t: &str) -> bool {
    t.len() > 120 && !t.contains(' ')
}

fn is_pictograph(c: char) -> bool {
    let u = c as u32;
    (0x1F300..=0x1FAFF).contains(&u) || (0x2600..=0x27BF).contains(&u) || u == 0xFE0F
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Like [chunks], but the first piece is kept short (about a sentence) so the
/// voice starts almost at once; the rest is made while it plays.
pub fn chunks_lead(text: &str, first_max: usize, max: usize) -> Vec<String> {
    let mut pieces = chunks(text, first_max);
    if pieces.len() <= 1 {
        return pieces;
    }
    let head = pieces.remove(0);
    let mut out = vec![head];
    out.extend(chunks(&pieces.join(" "), max));
    out
}

/// Split long text into sentence-aligned pieces of at most `max` bytes, so the
/// first piece can play while the rest is still being synthesized.
pub fn chunks(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for sentence in sentences(text) {
        if !cur.is_empty() && cur.len() + sentence.len() + 1 > max {
            out.push(std::mem::take(&mut cur));
        }
        if sentence.len() > max {
            // One enormous "sentence" (a log line): cut at spaces.
            for word in sentence.split(' ') {
                if !cur.is_empty() && cur.len() + word.len() + 1 > max {
                    out.push(std::mem::take(&mut cur));
                }
                if !cur.is_empty() {
                    cur.push(' ');
                }
                cur.push_str(word);
            }
            continue;
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(sentence);
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = text.as_bytes();
    for i in 0..b.len() {
        if matches!(b[i], b'.' | b'!' | b'?') && (i + 1 == b.len() || b[i + 1] == b' ') {
            let s = text[start..=i].trim();
            if !s.is_empty() {
                out.push(s);
            }
            start = i + 1;
        }
    }
    let tail = text[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prose_reads_markdown_as_sentences() {
        let md = "## Done\n\nI **bumped** the version to 3.9.107 and pushed.\n\n- Fixed `useVisible.ts`\n- See [the PR](https://github.com/x/y/pull/1)\n\n```rust\nfn a() {}\nfn b() {}\n```\n";
        let s = prose(md);
        assert_eq!(
            s,
            "Done. I bumped the version to 3 point 9 point 107 and pushed. Fixed useVisible.ts. See the PR. Code block, 2 lines."
        );
    }

    #[test]
    fn paths_urls_and_tables_become_words() {
        assert_eq!(inline("see src/lib/useVisible.ts:42 now"), "see useVisible.ts line 42 now");
        assert_eq!(inline(r"at H:\Works\app\src\main.rs"), "at main.rs");
        assert_eq!(inline("open https://www.example.com/a?b=1"), "open a link to example.com");
        assert_eq!(prose("| a | b |\n|---|---|\n| 1 | 2 |"), "a, b. 1, 2.");
        assert_eq!(inline("snake_case stays"), "snake_case stays");
        assert_eq!(inline("v1.13.8, ok"), "version 1 point 13 point 8, ok");
        assert_eq!(inline("0.45 seconds"), "0.45 seconds");
    }

    #[test]
    fn output_strips_line_numbers_reminders_and_caps() {
        let text = "     1\tfn main() {\n     2\t    println!(\"hi\");\n<system-reminder>\nsecret\n</system-reminder>\n     3\t}\n";
        assert_eq!(output(text, false, 0), "fn main() {. println!(\"hi\"); }.");
        let long = (1..=50).map(|i| format!("line number {i}")).collect::<Vec<_>>().join("\n");
        let s = output(&long, false, 60);
        assert!(s.starts_with("line number 1. line number 2."), "{s}");
        assert!(s.ends_with("more lines."), "{s}");
        assert_eq!(output("", true, 100), "The command failed.");
        assert_eq!(output("", false, 100), "No output.");
    }

    #[test]
    fn actions_use_the_tools_own_words() {
        let a = |t: &str, v: Value| action(t, &v).map(|(_, s)| s);
        assert_eq!(a("Bash", json!({"command":"cargo test","description":"Run Rust library tests"})).unwrap(), "Run Rust library tests");
        assert_eq!(a("Read", json!({"file_path":"H:\\x\\src\\lib.rs"})).unwrap(), "Reading lib.rs.");
        assert_eq!(a("Grep", json!({"pattern":"useVisible"})).unwrap(), "Searching the code for useVisible.");
        assert_eq!(a("Grep", json!({"pattern":"fn \\w+\\("})).unwrap(), "Searching the code.");
        assert_eq!(a("mcp__Claude_Browser__read_page", json!({})).unwrap(), "Using read page.");
        assert!(a("ToolSearch", json!({})).is_none());
        let (kind, q) = action(
            "AskUserQuestion",
            &json!({"questions":[{"question":"Which voice?","options":[{"label":"Heart"},{"label":"Bella"}]}]}),
        )
        .unwrap();
        assert_eq!(kind, Kind::Question);
        assert_eq!(q, "Question: Which voice? Options: Heart; Bella.");
    }

    #[test]
    fn chunks_keep_sentences_whole() {
        let text = "One two three. Four five six. Seven eight nine.";
        assert_eq!(chunks(text, 30), vec!["One two three. Four five six.", "Seven eight nine."]);
        let long = "word ".repeat(40);
        assert!(chunks(long.trim(), 50).iter().all(|c| c.len() <= 50));
    }
}
