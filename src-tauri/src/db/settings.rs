use crate::db::DbPool;
use crate::error::AppResult;
use std::collections::HashMap;

/// (key, default) pairs. Defaults are seeded lazily on read.
pub const DEFAULTS: &[(&str, &str)] = &[
    ("idle_minutes", "5"),
    ("min_session_seconds", "30"),
    ("tracking_paused", "false"),
    ("start_with_windows", "true"),
    ("online_metadata_enabled", "true"),
    ("onboarded", "false"),
    ("accent", "violet"),
    ("theme", "dark"),
    ("close_to_tray", "true"),
    ("notify_sessions", "true"),
    ("daily_goal_minutes", "0"),
    ("break_reminder_minutes", "0"),
    ("auto_screenshots_enabled", "true"),
    ("screenshot_interval_minutes", "1"),
    ("theme_music_enabled", "true"),
    ("system_monitor_enabled", "true"),
    ("media_tracking_enabled", "true"),
    ("media_app_types", "{}"),
    ("steam_id", ""),
    ("steam_persona_name", ""),
    ("steam_avatar_url", ""),
    ("steam_linked", "false"),
    // "Remote only" setup mode: hides every surface except Remote and Settings
    // on the desktop AND on the phone/web/Quest companions. Presentation only —
    // tracking, media logging and the system monitor keep running, so turning
    // the full app back on in Settings leaves no gap in history. Seeded from the
    // installer's setup-type choice (see seed_install_mode in lib.rs).
    ("remote_only", "false"),
    ("remote_enabled", "false"),
    ("remote_port", "47800"),
    ("remote_cloud_enabled", "false"),
    // Default signaling server (WebRTC rendezvous). Kept in sync with
    // DEFAULT_SIGNAL_URL in src/lib/remoteConfig.ts. Self-hosted on this PC and
    // exposed via a Cloudflare Tunnel; the phone connects here, then P2P takes over.
    (
        "remote_signal_url",
        "wss://discovery.chilloutgamestudio.com",
    ),
    // Secret "permanent key" (code 2): a phone that supplies it is auto-trusted.
    // Empty by default → generated + persisted on first launch (see lib.rs setup).
    ("remote_secret_code", ""),
    // Per-device access grants (JSON). Trusted = permanent; temp = time-boxed.
    ("remote_trusted_devices", "[]"),
    ("remote_temp_grants", "[]"),
    // AnyDesk-style "show UAC prompts to the remote" — disables the UAC secure
    // desktop while remote is enabled so admin-consent dialogs are captured and
    // controllable from the phone. Opt-in (lowers local security); restored on
    // disable/exit. See remote/uac.rs.
    ("remote_show_uac", "false"),
    // Shared clipboard: a floating widget + a permanent, E2E-encrypted history
    // synced across desktop + Android. Off by default; enabling walks permissions.
    // The encryption key and relay space derive from `remote_secret_code` (shared
    // with the remote feature), so both devices converge without a separate pairing.
    // See src/clipboard/ and src/db/clipboard.rs.
    ("clipboard_enabled", "false"),
    ("clipboard_overlay_enabled", "false"),
    // Desktop-only native auto-capture (Win32 clipboard listener). On by default so
    // that, once the feature is enabled, copies flow in without any extra tap.
    ("clipboard_auto_capture", "true"),
    ("clipboard_stt_enabled", "false"),
    // Optional user-supplied Sarvam speech-to-text API key. Takes priority over the
    // key baked from `.env` at compile time, so voice-to-text works on installs that
    // shipped without a key (and lets the user rotate it without a rebuild). Empty
    // → fall back to the baked/env key. Shared verbatim to the phone over the trusted
    // channel so the companion's mic works too. Also the STT language ("" = auto).
    ("clipboard_sarvam_key", ""),
    ("clipboard_stt_language", ""),
    // Persisted overlay bubble position ("x,y") and a stable per-install device id
    // (generated on first use). Empty until set.
    ("clipboard_overlay_pos", ""),
    ("clipboard_device_id", ""),
];

fn default_for(key: &str) -> Option<&'static str> {
    DEFAULTS.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

pub fn get(pool: &DbPool, key: &str) -> AppResult<Option<String>> {
    let conn = pool.get()?;
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .ok();
    Ok(v.or_else(|| default_for(key).map(|s| s.to_string())))
}

pub fn get_bool(pool: &DbPool, key: &str) -> AppResult<bool> {
    Ok(get(pool, key)?
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false))
}

pub fn get_i64(pool: &DbPool, key: &str, fallback: i64) -> AppResult<i64> {
    Ok(get(pool, key)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(fallback))
}

pub fn set(pool: &DbPool, key: &str, value: &str) -> AppResult<()> {
    let conn = pool.get()?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// Returns the full settings map (defaults merged with stored values).
pub fn all(pool: &DbPool) -> AppResult<HashMap<String, String>> {
    let mut map: HashMap<String, String> = DEFAULTS
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let conn = pool.get()?;
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}
