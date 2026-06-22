use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDto {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub install_folder: Option<String>,
    pub exe_paths: Vec<String>,
    pub icon_path: Option<String>,
    pub cover_path: Option<String>,
    pub status: String,
    pub rating: Option<i64>,
    pub developer: Option<String>,
    pub release_year: Option<i64>,
    pub started_year: Option<i64>,
    pub started_month: Option<i64>,
    pub started_day: Option<i64>,
    pub completed_year: Option<i64>,
    pub completed_month: Option<i64>,
    pub completed_day: Option<i64>,
    pub metacritic: Option<i64>,
    pub notes: Option<String>,
    pub time_to_beat_minutes: Option<i64>,
    pub manual_playtime_seconds: i64,
    pub hltb_main_minutes: Option<i64>,
    pub hltb_main_extra_minutes: Option<i64>,
    pub hltb_completionist_minutes: Option<i64>,
    pub accent_color: Option<String>,
    pub is_enabled: bool,
    pub is_tracked: bool,
    pub created_at: String,
    pub tags: Vec<String>,
    pub screenshots: Vec<String>,
    pub background_url: Option<String>,
    pub website: Option<String>,
    pub count_background: bool,
    pub steam_app_id: Option<i64>,
    pub metacritic_slug: Option<String>,
    pub info_json: Option<String>,
    pub trailer_url: Option<String>,
    pub theme_youtube_id: Option<String>,
    pub theme_audio_url: Option<String>,
    // session stats (tracked only)
    pub tracked_runtime_seconds: i64,
    pub tracked_active_seconds: i64,
    pub session_count: i64,
    pub last_played_utc: Option<String>,
    pub first_played_utc: Option<String>,
    // tracked + manual
    pub total_runtime_seconds: i64,
    pub total_active_seconds: i64,
}

/// Payload for creating or updating a game (manual add, completed-catalog form, drag-drop).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInput {
    pub id: Option<String>,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub display_name: String,
    pub install_folder: Option<String>,
    #[serde(default)]
    pub exe_paths: Vec<String>,
    pub cover_path: Option<String>,
    #[serde(default = "default_status")]
    pub status: String,
    pub rating: Option<i64>,
    pub developer: Option<String>,
    pub release_year: Option<i64>,
    pub started_year: Option<i64>,
    pub started_month: Option<i64>,
    pub started_day: Option<i64>,
    pub completed_year: Option<i64>,
    pub completed_month: Option<i64>,
    pub completed_day: Option<i64>,
    pub metacritic: Option<i64>,
    pub notes: Option<String>,
    pub time_to_beat_minutes: Option<i64>,
    pub manual_playtime_seconds: Option<i64>,
    pub accent_color: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub count_background: Option<bool>,
    /// Exact Steam appid when known (autosuggest pick / Steam detection). Used to
    /// make the auto-enrichment lookup exact instead of a fuzzy name search.
    #[serde(default)]
    pub steam_app_id: Option<i64>,
}

fn default_status() -> String {
    "backlog".to_string()
}

fn default_kind() -> String {
    "game".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSpan {
    pub start_utc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_utc: Option<String>,
    pub focused: bool,
}

/// A stretch of foreground window activity within a session — the window title
/// and, for browsers, the active tab URL. Used to annotate the timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySpan {
    pub start_utc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_utc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// An auto-captured in-game screenshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotDto {
    pub id: String,
    pub game_id: String,
    pub session_id: Option<String>,
    pub path: String,
    pub captured_utc: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDto {
    pub id: String,
    pub game_id: String,
    pub game_name: String,
    pub kind: String,
    pub icon_path: Option<String>,
    pub cover_path: Option<String>,
    pub accent_color: Option<String>,
    pub start_utc: String,
    pub end_utc: Option<String>,
    pub last_seen_utc: String,
    pub runtime_seconds: i64,
    pub active_seconds: i64,
    pub was_idle_ended: bool,
    #[serde(default)]
    pub focus_spans: Vec<FocusSpan>,
    #[serde(default)]
    pub activity_spans: Vec<ActivitySpan>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilter {
    pub game_id: Option<String>,
    pub from_utc: Option<String>,
    pub to_utc: Option<String>,
    pub min_seconds: Option<i64>,
    pub exclude_idle_ended: Option<bool>,
    pub limit: Option<i64>,
    /// Restrict to a single kind ('game' | 'app'); None returns both.
    pub kind: Option<String>,
}
