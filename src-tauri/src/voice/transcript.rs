//! Following every Claude Code session on this PC through its transcript files.
//!
//! Claude Code (the CLI and the desktop app's Code tab) appends one JSON record
//! per content block to `~/.claude/projects/<project>/<session>.jsonl`, helper
//! agents to `<session>/subagents/*.jsonl`, as the work happens. Tailing those
//! files sees every reply, thought, tool call and tool result of every session
//! with nothing installed per project and no API calls.
//!
//! Files that exist when watching starts are read from their current end: old
//! history is never replayed as speech.

use super::speak::{self, Kind};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// One line of narration, before scheduling.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    /// Stable id: the record's uuid plus the block index.
    pub id: String,
    pub session_id: String,
    /// The session's title if Claude Code has named it, else "".
    pub title: String,
    /// Project folder name (from the record's cwd).
    pub project: String,
    pub kind: Kind,
    pub text: String,
    /// True for helper-agent (subagent) activity.
    pub helper: bool,
    /// For actions and outputs: what kind of tool ("command", "read", …).
    pub category: &'static str,
    /// A tool result that reported an error.
    pub failed: bool,
}

/// Parsing state that outlives a single line: tool names by id (so a result
/// knows what produced it) and session titles.
#[derive(Default)]
pub struct Parser {
    tools: HashMap<String, String>,
    titles: HashMap<String, String>,
    pub output_max_chars: usize,
}

impl Parser {
    pub fn new(output_max_chars: usize) -> Self {
        Self { output_max_chars, ..Default::default() }
    }

    /// One transcript line → zero or more events.
    pub fn line(&mut self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
        let session_id = v.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        match ty {
            "custom-title" | "agent-name" => {
                let t = v
                    .get("customTitle")
                    .or_else(|| v.get("agentName"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !t.is_empty() && !session_id.is_empty() {
                    self.titles.insert(session_id, t.to_string());
                }
                return Vec::new();
            }
            "assistant" | "user" => {}
            _ => return Vec::new(),
        }
        let uuid = v.get("uuid").and_then(Value::as_str).unwrap_or("").to_string();
        let project = v
            .get("cwd")
            .and_then(Value::as_str)
            .map(|c| c.trim_end_matches(['\\', '/']).rsplit(['\\', '/']).next().unwrap_or(c).to_string())
            .unwrap_or_default();
        let helper = v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false);
        let title = self.titles.get(&session_id).cloned().unwrap_or_default();
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
            // A plain-string user message is your own prompt: not narrated.
            return Vec::new();
        };
        let mut out = Vec::new();
        for (i, b) in blocks.iter().enumerate() {
            let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
            let mut category = "";
            let mut failed = false;
            let spoken: Option<(Kind, String)> = match (ty, bt) {
                ("assistant", "text") => {
                    let t = speak::prose(b.get("text").and_then(Value::as_str).unwrap_or(""));
                    (!t.is_empty()).then_some((Kind::Reply, t))
                }
                ("assistant", "thinking") => {
                    // Usually stored empty (signed placeholder); speak it when it isn't.
                    let t = speak::prose(b.get("thinking").and_then(Value::as_str).unwrap_or(""));
                    (!t.is_empty()).then_some((Kind::Thinking, t))
                }
                ("assistant", "tool_use") => {
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("");
                    category = speak::category(name);
                    if let Some(id) = b.get("id").and_then(Value::as_str) {
                        if self.tools.len() > 4096 {
                            self.tools.clear();
                        }
                        self.tools.insert(id.to_string(), name.to_string());
                    }
                    speak::action(name, b.get("input").unwrap_or(&Value::Null))
                }
                ("user", "tool_result") => {
                    let tool = b
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .and_then(|id| self.tools.remove(id))
                        .unwrap_or_default();
                    // Answers to your own questions and plumbing results aren't worth reading.
                    let is_error = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    if matches!(tool.as_str(), "AskUserQuestion" | "ToolSearch" | "TodoWrite") {
                        None
                    } else if speak::category(&tool) == "command" {
                        // Command output is never read (the user's call): the action
                        // line already said what ran. A failure is still worth one line.
                        category = "command";
                        failed = is_error;
                        is_error.then(|| (Kind::Output, "The command failed.".to_string()))
                    } else {
                        category = speak::category(&tool);
                        failed = is_error;
                        let text = result_text(b.get("content"));
                        Some((Kind::Output, speak::output(&text, is_error, self.output_max_chars)))
                    }
                }
                _ => None,
            };
            if let Some((kind, text)) = spoken {
                out.push(Event {
                    id: format!("{uuid}:{i}"),
                    session_id: session_id.clone(),
                    title: title.clone(),
                    project: project.clone(),
                    kind,
                    text,
                    helper,
                    category,
                    failed,
                });
            }
        }
        out
    }
}

/// A tool_result's content is a string or an array of blocks (text / image).
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Where Claude Code keeps its transcripts.
pub fn projects_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

struct Tail {
    offset: u64,
    /// Bytes after the last newline (a record still being written).
    partial: Vec<u8>,
}

/// Follows every `.jsonl` under the projects root.
pub struct Watcher {
    root: PathBuf,
    files: HashMap<PathBuf, Tail>,
    last_scan: Option<std::time::Instant>,
    /// Files untouched for longer than this are not re-read every tick.
    started: SystemTime,
}

impl Watcher {
    pub fn new(root: PathBuf) -> Self {
        let mut w = Self { root, files: HashMap::new(), last_scan: None, started: SystemTime::now() };
        // Everything that exists now starts at its end.
        for p in list_jsonl(&w.root) {
            let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            w.files.insert(p, Tail { offset: len, partial: Vec::new() });
        }
        w
    }

    /// New complete lines since the last call, in file order per file.
    pub fn poll(&mut self) -> Vec<String> {
        // New files (a new session, a new helper) appear rarely: rescan every 2 s.
        let rescan = self.last_scan.map_or(true, |t| t.elapsed() >= Duration::from_secs(2));
        if rescan {
            self.last_scan = Some(std::time::Instant::now());
            for p in list_jsonl(&self.root) {
                if !self.files.contains_key(&p) {
                    // Created after we started: read it from the beginning, so the
                    // first reply of a brand-new session isn't lost. One that
                    // predates us (a rename) starts at its end.
                    let meta = std::fs::metadata(&p).ok();
                    let born_after = meta
                        .as_ref()
                        .and_then(|m| m.created().ok())
                        .is_some_and(|c| c >= self.started);
                    let offset = if born_after { 0 } else { meta.map(|m| m.len()).unwrap_or(0) };
                    self.files.insert(p, Tail { offset, partial: Vec::new() });
                }
            }
            self.files.retain(|p, _| p.exists());
        }
        let mut lines = Vec::new();
        for (path, tail) in self.files.iter_mut() {
            let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else { continue };
            if len < tail.offset {
                // Rewritten or truncated: follow it from its new end.
                tail.offset = len;
                tail.partial.clear();
                continue;
            }
            if len == tail.offset {
                continue;
            }
            read_new(path, tail, len, &mut lines);
        }
        lines
    }
}

fn read_new(path: &Path, tail: &mut Tail, len: u64, lines: &mut Vec<String>) {
    let Ok(mut f) = File::open(path) else { return };
    if f.seek(SeekFrom::Start(tail.offset)).is_err() {
        return;
    }
    // Cap a single read so a huge catch-up can't stall the loop.
    let want = (len - tail.offset).min(8 * 1024 * 1024) as usize;
    let mut buf = vec![0u8; want];
    let Ok(n) = f.read(&mut buf) else { return };
    buf.truncate(n);
    tail.offset += n as u64;
    tail.partial.extend_from_slice(&buf);
    while let Some(nl) = tail.partial.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = tail.partial.drain(..=nl).collect();
        let s = String::from_utf8_lossy(&line);
        let s = s.trim();
        if !s.is_empty() {
            lines.push(s.to_string());
        }
    }
}

fn list_jsonl(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                // projects/<project>/<session>/subagents/*.jsonl is depth 3.
                if depth < 3 {
                    stack.push((p, depth + 1));
                }
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                out.push(p);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec(v: Value) -> String {
        v.to_string()
    }

    #[test]
    fn parses_replies_actions_results_and_titles() {
        let mut p = Parser::new(0);
        assert!(p.line(&rec(json!({"type":"custom-title","customTitle":"Voice plan","sessionId":"s1"}))).is_empty());
        let ev = p.line(&rec(json!({
            "type":"assistant","uuid":"u1","sessionId":"s1","cwd":"H:\\Works\\GameTracker",
            "message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test","description":"Run the tests"}}]}
        })));
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].kind, Kind::Action);
        assert_eq!(ev[0].text, "Run the tests");
        assert_eq!(ev[0].title, "Voice plan");
        assert_eq!(ev[0].project, "GameTracker");
        assert_eq!(ev[0].id, "u1:0");

        // Command output is never read…
        let ev = p.line(&rec(json!({
            "type":"user","uuid":"u2","sessionId":"s1",
            "message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"test result: ok. 85 passed"}]}
        })));
        assert!(ev.is_empty());
        // …but a failed command gets one line.
        p.line(&rec(json!({
            "type":"assistant","uuid":"u2b","sessionId":"s1",
            "message":{"content":[{"type":"tool_use","id":"t2","name":"PowerShell","input":{"command":"x"}}]}
        })));
        let ev = p.line(&rec(json!({
            "type":"user","uuid":"u2c","sessionId":"s1",
            "message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"boom"}]}
        })));
        assert_eq!((ev[0].kind, ev[0].text.as_str(), ev[0].failed), (Kind::Output, "The command failed.", true));
        // Other tools' results are still read.
        p.line(&rec(json!({
            "type":"assistant","uuid":"u2d","sessionId":"s1",
            "message":{"content":[{"type":"tool_use","id":"t3","name":"Grep","input":{"pattern":"x"}}]}
        })));
        let ev = p.line(&rec(json!({
            "type":"user","uuid":"u2e","sessionId":"s1",
            "message":{"content":[{"type":"tool_result","tool_use_id":"t3","content":"Found 4 files"}]}
        })));
        assert_eq!(ev[0].text, "Found 4 files.");

        let ev = p.line(&rec(json!({
            "type":"assistant","uuid":"u3","sessionId":"s1",
            "message":{"content":[{"type":"text","text":"All **done**."}]}
        })));
        assert_eq!((ev[0].kind, ev[0].text.as_str()), (Kind::Reply, "All done."));
    }

    #[test]
    fn skips_empty_thinking_prompts_and_plumbing() {
        let mut p = Parser::new(0);
        let empty_think = rec(json!({"type":"assistant","uuid":"a","message":{"content":[{"type":"thinking","thinking":"","signature":"x"}]}}));
        assert!(p.line(&empty_think).is_empty());
        let think = rec(json!({"type":"assistant","uuid":"b","message":{"content":[{"type":"thinking","thinking":"Check the relay first."}]}}));
        assert_eq!(p.line(&think)[0].kind, Kind::Thinking);
        let prompt = rec(json!({"type":"user","uuid":"c","message":{"content":"please build it"}}));
        assert!(p.line(&prompt).is_empty());
        let ts = rec(json!({"type":"assistant","uuid":"d","message":{"content":[{"type":"tool_use","id":"t9","name":"ToolSearch","input":{}}]}}));
        assert!(p.line(&ts).is_empty());
        let ts_res = rec(json!({"type":"user","uuid":"e","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"schemas"}]}}));
        assert!(p.line(&ts_res).is_empty());
        assert!(p.line("not json").is_empty());
        assert!(p.line(&rec(json!({"type":"attachment"}))).is_empty());
    }

    #[test]
    fn watcher_skips_existing_history_and_follows_new_lines() {
        let root = std::env::temp_dir().join(format!("gt-voice-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let proj = root.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let old = proj.join("old.jsonl");
        std::fs::write(&old, "{\"history\":1}\n").unwrap();
        let mut w = Watcher::new(root.clone());
        assert!(w.poll().is_empty(), "existing content is history");

        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&old).unwrap();
        f.write_all(b"{\"a\":1}\n{\"b\":").unwrap();
        f.flush().unwrap();
        assert_eq!(w.poll(), vec!["{\"a\":1}".to_string()]);
        f.write_all(b"2}\n").unwrap();
        f.flush().unwrap();
        assert_eq!(w.poll(), vec!["{\"b\":2}".to_string()]);

        // A session created after watching started is read from its beginning.
        let sub = proj.join("s1").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("agent-x.jsonl"), "{\"new\":1}\n").unwrap();
        w.last_scan = None;
        assert_eq!(w.poll(), vec!["{\"new\":1}".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
