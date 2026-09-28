//! The narration log: what exists, what the phone has played, what to
//! synthesize next, and how a backlog is condensed.
//!
//! Speech is made just in time: only a short window ahead of the phone's
//! playhead is synthesized, so a backlog never turns into minutes of stale audio
//! that has already been made. When the unplayed part grows too long, runs of old
//! actions and outputs are replaced by one summary line; replies, thinking and
//! questions are always kept. Nothing is deleted: condensed lines stay in the
//! history as text.

use super::speak::{self, Kind};
use super::transcript::Event;

/// Rough speaking rate of Kokoro at 1× (characters per second), for estimates
/// before an item has audio.
const CHARS_PER_SEC: f64 = 15.0;
/// Longest single piece of audio. The first piece of a long reply can play
/// while the rest is still being made.
pub const PART_MAX_CHARS: usize = 320;
/// The first piece of every item: short, so a line starts within about a second
/// (Kokoro makes ~5 s of speech per second of CPU).
pub const FIRST_PART_MAX_CHARS: usize = 80;
/// Items kept in memory (the relay keeps the long history).
const KEEP_ITEMS: usize = 3000;

#[derive(Clone, Debug)]
pub struct Item {
    /// URL-safe, unique.
    pub id: String,
    /// Playback order. Spaced by 4 so a summary can slot in front of a run.
    pub order: i64,
    pub created_utc: String,
    pub kind: Kind,
    pub text: String,
    pub session_id: String,
    pub title: String,
    pub project: String,
    pub helper: bool,
    pub category: &'static str,
    pub failed: bool,
    /// Condensed away: kept as text, never played.
    pub skip: bool,
    /// The text split for synthesis.
    pub parts: Vec<String>,
    /// Duration of each part's audio once it exists (ms).
    pub audio_ms: Vec<Option<u32>>,
    /// Changed since it was last sent to the relay.
    pub dirty: bool,
}

impl Item {
    fn estimate_secs(&self) -> f64 {
        self.parts
            .iter()
            .zip(&self.audio_ms)
            .map(|(p, a)| match a {
                Some(ms) => *ms as f64 / 1000.0,
                None => p.len() as f64 / CHARS_PER_SEC,
            })
            .sum()
    }
}

/// Tunables; the defaults are what the feature ships with.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Keep this many seconds of made-but-unplayed audio ahead of the phone.
    pub lookahead_secs: f64,
    /// Condense once the unplayed backlog is longer than this.
    pub condense_after_secs: f64,
    /// The newest items are never condensed (they're what's happening now).
    pub keep_newest: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { lookahead_secs: 40.0, condense_after_secs: 90.0, keep_newest: 4 }
    }
}

#[derive(Default)]
pub struct Log {
    pub items: Vec<Item>,
    /// Order of the last item the phone finished (None = no phone has reported).
    pub head: Option<i64>,
    last_order: i64,
}

impl Log {
    /// Append an event (arrival order = playback order).
    pub fn push(&mut self, e: Event, now_us: i64, created_utc: String) -> &Item {
        let order = (now_us * 4).max(self.last_order + 4);
        self.last_order = order;
        let parts = speak::chunks_lead(&e.text, FIRST_PART_MAX_CHARS, PART_MAX_CHARS);
        let n = parts.len();
        self.items.push(Item {
            id: safe_id(&e.id),
            order,
            created_utc,
            kind: e.kind,
            text: e.text,
            session_id: e.session_id,
            title: e.title,
            project: e.project,
            helper: e.helper,
            category: e.category,
            failed: e.failed,
            skip: false,
            parts,
            audio_ms: vec![None; n],
            dirty: true,
        });
        if self.items.len() > KEEP_ITEMS {
            let drop = self.items.len() - KEEP_ITEMS;
            self.items.drain(..drop);
        }
        self.items.last().expect("just pushed")
    }

    /// The phone reports the last item it finished. A phone that has never
    /// reported starts "now": everything before its first report is history.
    pub fn set_head(&mut self, order: i64) {
        self.head = Some(self.head.map_or(order, |h| h.max(order)));
    }

    /// "Catch up to live": everything so far counts as played.
    pub fn catch_up(&mut self) {
        if let Some(last) = self.items.last() {
            self.head = Some(last.order);
        }
    }

    fn unplayed(&self) -> impl Iterator<Item = (usize, &Item)> {
        let head = self.head.unwrap_or(i64::MAX);
        self.items
            .iter()
            .enumerate()
            .filter(move |(_, it)| it.order > head && !it.skip)
    }

    /// Next (item index, part index) to synthesize, or None when enough audio is
    /// already waiting (or no phone is listening).
    pub fn next_to_synthesize(&self, limits: &Limits) -> Option<(usize, usize)> {
        self.head?;
        let mut ready_ahead = 0.0;
        for (i, it) in self.unplayed() {
            for (p, a) in it.audio_ms.iter().enumerate() {
                match a {
                    Some(ms) => ready_ahead += *ms as f64 / 1000.0,
                    None => {
                        return (ready_ahead < limits.lookahead_secs).then_some((i, p));
                    }
                }
            }
        }
        None
    }

    pub fn set_audio(&mut self, id: &str, part: usize, ms: u32) {
        if let Some(it) = self.items.iter_mut().find(|it| it.id == id) {
            if let Some(slot) = it.audio_ms.get_mut(part) {
                // The relay records audio itself when it arrives; no re-publish.
                *slot = Some(ms);
            }
        }
    }

    /// Estimated seconds of speech the phone hasn't played yet.
    pub fn backlog_secs(&self) -> f64 {
        self.unplayed().map(|(_, it)| it.estimate_secs()).sum()
    }

    /// Merge runs of old actions/outputs into summary lines while the backlog is
    /// too long. Returns true if anything changed.
    pub fn condense(&mut self, limits: &Limits, now_us: i64, created_utc: &str) -> bool {
        if self.head.is_none() || self.backlog_secs() <= limits.condense_after_secs {
            return false;
        }
        let unplayed: Vec<usize> = self.unplayed().map(|(i, _)| i).collect();
        if unplayed.len() <= limits.keep_newest + 1 {
            return false;
        }
        // The first unplayed item may be playing right now; the newest few are
        // what's happening now. Everything between is fair game.
        let candidates = &unplayed[1..unplayed.len() - limits.keep_newest];
        let mut runs: Vec<Vec<usize>> = Vec::new();
        let mut run: Vec<usize> = Vec::new();
        for &i in candidates {
            if matches!(self.items[i].kind, Kind::Action | Kind::Output) {
                run.push(i);
            } else if !run.is_empty() {
                runs.push(std::mem::take(&mut run));
            }
        }
        if !run.is_empty() {
            runs.push(run);
        }
        let mut changed = false;
        let mut summaries = Vec::new();
        for run in runs.into_iter().filter(|r| r.len() >= 2) {
            let text = summary_text(run.iter().map(|&i| &self.items[i]));
            let first = self.items[run[0]].clone();
            let order = first.order - 1;
            let base_id = format!("sum-{}", first.id);
            for &i in &run {
                self.items[i].skip = true;
                self.items[i].dirty = true;
            }
            let parts = speak::chunks_lead(&text, FIRST_PART_MAX_CHARS, PART_MAX_CHARS);
            let n = parts.len();
            summaries.push(Item {
                id: base_id,
                order,
                created_utc: created_utc.to_string(),
                kind: Kind::Summary,
                text,
                session_id: first.session_id.clone(),
                title: first.title.clone(),
                project: first.project.clone(),
                helper: false,
                category: "",
                failed: false,
                skip: false,
                parts,
                audio_ms: vec![None; n],
                dirty: true,
            });
            changed = true;
        }
        let _ = now_us;
        if changed {
            self.items.extend(summaries);
            self.items.sort_by_key(|it| it.order);
        }
        changed
    }
}

/// "Skipped ahead: ran 4 commands, read 3 files and edited 2 files. One failed."
pub fn summary_text<'a>(items: impl Iterator<Item = &'a Item>) -> String {
    let (mut commands, mut reads, mut edits, mut searches, mut web, mut other, mut failed) = (0, 0, 0, 0, 0, 0, 0);
    for it in items {
        if it.kind == Kind::Output {
            if it.failed {
                failed += 1;
            }
            continue;
        }
        match it.category {
            "command" => commands += 1,
            "read" => reads += 1,
            "edit" => edits += 1,
            "search" => searches += 1,
            "web" => web += 1,
            _ => other += 1,
        }
    }
    let plural = |n: i32, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut bits = Vec::new();
    if commands > 0 {
        bits.push(format!("ran {}", plural(commands, "command", "commands")));
    }
    if reads > 0 {
        bits.push(format!("read {}", plural(reads, "file", "files")));
    }
    if edits > 0 {
        bits.push(format!("edited {}", plural(edits, "file", "files")));
    }
    if searches > 0 {
        bits.push(format!("ran {}", plural(searches, "search", "searches")));
    }
    if web > 0 {
        bits.push(format!("opened {}", plural(web, "web page", "web pages")));
    }
    if other > 0 {
        bits.push(format!("took {}", plural(other, "other step", "other steps")));
    }
    let list = match bits.len() {
        0 => "went through some steps".to_string(),
        1 => bits.remove(0),
        _ => {
            let last = bits.pop().unwrap_or_default();
            format!("{} and {last}", bits.join(", "))
        }
    };
    let mut s = format!("Skipping ahead: {list}.");
    if failed > 0 {
        s.push_str(&format!(" {} failed.", if failed == 1 { "One".to_string() } else { failed.to_string() }));
    }
    s
}

/// Transcript ids are uuid:index; the relay puts ids in URL paths.
fn safe_id(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: &str, kind: Kind, text: &str, category: &'static str) -> Event {
        Event {
            id: id.into(),
            session_id: "s".into(),
            title: String::new(),
            project: "p".into(),
            kind,
            text: text.into(),
            helper: false,
            category,
            failed: false,
        }
    }

    #[test]
    fn nothing_is_made_until_a_phone_reports_and_then_only_a_window_ahead() {
        let mut log = Log::default();
        let lim = Limits { lookahead_secs: 10.0, ..Default::default() };
        for i in 0..5 {
            log.push(ev(&format!("a{i}"), Kind::Reply, "Hello there.", ""), 1_000 + i, "t".into());
        }
        assert_eq!(log.next_to_synthesize(&lim), None, "no phone yet");
        log.set_head(log.items[0].order); // phone has played the first
        assert_eq!(log.next_to_synthesize(&lim), Some((1, 0)));
        // 6 s of audio waiting: still under the 10 s window.
        log.set_audio(&log.items[1].id.clone(), 0, 6_000);
        assert_eq!(log.next_to_synthesize(&lim), Some((2, 0)));
        log.set_audio(&log.items[2].id.clone(), 0, 6_000);
        assert_eq!(log.next_to_synthesize(&lim), None, "12 s ready is enough");
        log.set_head(log.items[2].order);
        assert_eq!(log.next_to_synthesize(&lim), Some((3, 0)));
    }

    #[test]
    fn a_backlog_condenses_old_actions_but_keeps_replies_and_the_newest() {
        let mut log = Log::default();
        log.push(ev("r0", Kind::Reply, "Starting.", ""), 1, "t".into());
        log.set_head(log.items[0].order);
        let long = "x".repeat(300); // 20 s each at 15 chars/s
        log.push(ev("playing", Kind::Reply, &long, ""), 2, "t".into());
        for i in 0..4 {
            log.push(ev(&format!("c{i}"), Kind::Action, &long, "command"), 10 + i, "t".into());
            log.push(ev(&format!("o{i}"), Kind::Output, &long, "command"), 20 + i, "t".into());
        }
        log.push(ev("mid", Kind::Reply, &long, ""), 30, "t".into());
        log.push(ev("e0", Kind::Action, &long, "edit"), 40, "t".into());
        log.push(ev("e1", Kind::Action, &long, "read"), 41, "t".into());
        for i in 0..4 {
            log.push(ev(&format!("new{i}"), Kind::Action, &long, "command"), 50 + i, "t".into());
        }
        assert!(log.backlog_secs() > 90.0);
        assert!(log.condense(&Limits::default(), 100, "t"));

        let played: Vec<&str> = log.items.iter().filter(|i| !i.skip && i.order > log.head.unwrap()).map(|i| i.id.as_str()).collect();
        assert_eq!(played[0], "playing", "the item that may be playing is untouched");
        assert!(played[1].starts_with("sum-"), "{played:?}");
        assert_eq!(played[2], "mid", "replies survive");
        assert!(played[3].starts_with("sum-"));
        assert_eq!(&played[4..], ["new0", "new1", "new2", "new3"], "the newest are untouched");
        let sums: Vec<&str> = log.items.iter().filter(|i| i.kind == Kind::Summary).map(|i| i.text.as_str()).collect();
        assert_eq!(sums, ["Skipping ahead: ran 4 commands.", "Skipping ahead: read 1 file and edited 1 file."]);
        // Condensed items are still in the log, as text.
        assert_eq!(log.items.iter().filter(|i| i.skip).count(), 10);
    }

    #[test]
    fn summary_counts_failures() {
        let mut out = ev("o", Kind::Output, "boom", "command");
        out.failed = true;
        let mut log = Log::default();
        log.push(ev("a", Kind::Action, "x", "command"), 1, "t".into());
        log.push(out, 2, "t".into());
        assert_eq!(summary_text(log.items.iter()), "Skipping ahead: ran 1 command. One failed.");
    }

    #[test]
    fn long_text_is_split_into_parts_and_ids_are_url_safe() {
        let mut log = Log::default();
        let text = "This is a sentence that goes on for a while. ".repeat(20);
        let it = log.push(ev("uuid:3", Kind::Reply, text.trim(), ""), 1, "t".into());
        assert!(it.parts.len() > 1);
        assert!(it.parts.iter().all(|p| p.len() <= PART_MAX_CHARS));
        assert!(it.parts[0].len() <= FIRST_PART_MAX_CHARS, "the first piece is short");
        assert_eq!(it.id, "uuid_3");
    }
}
