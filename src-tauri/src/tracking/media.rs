//! Windows System Media Transport Controls (SMTC) bridge. Reads whatever media
//! is currently playing across the OS — Spotify, browser audio/video, Apple
//! Music, podcast apps — so it can be recorded into `media_plays` alongside the
//! in-app jukebox. Fully local: no network, no extra permissions.

/// A point-in-time view of one media session.
#[derive(Debug, Clone, Default)]
pub struct MediaSnapshot {
    pub source_app: String, // SourceAppUserModelId (AUMID / exe)
    pub app_name: String,   // friendly name
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub playing: bool,
    /// Windows MediaPlaybackType reported by the source: 1=Music, 2=Video,
    /// 3=Image, 0/None=Unknown. Browsers (Chromium) set this per media element,
    /// so it's the most reliable music-vs-video signal we have.
    pub playback_type: Option<i32>,
}

impl MediaSnapshot {
    /// Stable identity for a track within a source (title + artist).
    pub fn track_key(&self) -> String {
        format!(
            "{}|{}",
            self.title.clone().unwrap_or_default().to_lowercase(),
            self.artist.clone().unwrap_or_default().to_lowercase()
        )
    }

    pub fn has_content(&self) -> bool {
        self.title.is_some() || self.artist.is_some()
    }
}

/// Best-effort friendly app name from a SourceAppUserModelId.
pub fn friendly_app_name(aumid: &str) -> String {
    let lower = aumid.to_lowercase();
    const KNOWN: &[(&str, &str)] = &[
        ("spotify", "Spotify"),
        ("apple", "Apple Music"),
        ("music.ui", "Groove Music"),
        ("zune", "Groove Music"),
        ("tidal", "TIDAL"),
        ("deezer", "Deezer"),
        ("ytmdesktop", "YouTube Music"),
        ("foobar2000", "foobar2000"),
        ("aimp", "AIMP"),
        ("musicbee", "MusicBee"),
        ("winamp", "Winamp"),
        ("vlc", "VLC"),
        ("mpc-hc", "MPC-HC"),
        ("potplayer", "PotPlayer"),
        ("mpv", "mpv"),
        ("kodi", "Kodi"),
        ("netflix", "Netflix"),
        ("chrome", "Chrome"),
        ("msedge", "Microsoft Edge"),
        ("firefox", "Firefox"),
        ("308046b0af4a39cb", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vivaldi", "Vivaldi"),
    ];
    for (needle, name) in KNOWN {
        if lower.contains(needle) {
            return name.to_string();
        }
    }
    if lower.ends_with(".exe") {
        return crate::util::name_from_exe(aumid);
    }
    // AUMIDs are often "PackageFamily!App" — take the leading package token.
    let head = aumid.split(['!', '_']).next().unwrap_or(aumid);
    if head.is_empty() {
        aumid.to_string()
    } else {
        head.to_string()
    }
}

/// Classify a media session into music / video / podcast / other.
///
/// Order of evidence: a dedicated app's identity wins (Spotify is always music,
/// VLC always video). Otherwise we trust Windows' own `playback_type` hint
/// (1=Music, 2=Video) — Chromium tags each browser media element, so this is
/// what tells a YouTube Music track apart from a YouTube vlog even though both
/// arrive through the same browser with a channel name in `artist`. Only when
/// the OS gives no hint do we fall back to metadata heuristics (album ⇒ a real
/// music service; otherwise browser playback is treated as video).
pub fn classify(
    source_app: &str,
    artist: Option<&str>,
    album: Option<&str>,
    playback_type: Option<i32>,
) -> &'static str {
    let lower = source_app.to_lowercase();
    const MUSIC: &[&str] = &[
        "spotify", "apple", "music.ui", "zune", "tidal", "deezer", "ytmdesktop",
        "foobar2000", "aimp", "musicbee", "winamp", "amazonmusic",
    ];
    const PODCAST: &[&str] = &["podcast", "pocketcasts", "overcast", "castbox", "antennapod"];
    const VIDEO: &[&str] = &[
        "vlc", "mpc-hc", "mpc-be", "potplayer", "mpv", "kodi", "netflix",
        "primevideo", "disney", "hulu", "wmplayer",
    ];
    const BROWSER: &[&str] = &[
        "chrome", "msedge", "firefox", "308046b0af4a39cb", "brave", "opera",
        "vivaldi", "chromium",
    ];
    // 1. Dedicated apps: identity is definitive.
    if MUSIC.iter().any(|n| lower.contains(n)) {
        return "music";
    }
    if PODCAST.iter().any(|n| lower.contains(n)) {
        return "podcast";
    }
    if VIDEO.iter().any(|n| lower.contains(n)) {
        return "video";
    }
    // 2. The OS's own per-track hint (set by Chromium for browser playback).
    match playback_type {
        Some(1) => return "music",
        Some(2) => return "video",
        _ => {}
    }
    // 3. No hint — fall back to metadata.
    let has_artist = artist.map(|a| !a.trim().is_empty()).unwrap_or(false);
    let has_album = album.map(|a| !a.trim().is_empty()).unwrap_or(false);
    if BROWSER.iter().any(|n| lower.contains(n)) {
        // A channel name lands in `artist` for ordinary videos too, so artist alone
        // can't tell a song from a vlog. An album means it came from a real music
        // service; without one, treat browser playback as video.
        if has_album {
            "music"
        } else {
            "video"
        }
    } else if has_artist {
        "music"
    } else {
        "other"
    }
}

pub use imp::MediaReader;

#[cfg(windows)]
mod imp {
    use super::{friendly_app_name, MediaSnapshot};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    pub struct MediaReader {
        manager: Option<Manager>,
    }

    fn opt_string(s: windows::core::Result<windows::core::HSTRING>) -> Option<String> {
        let v = s.ok()?.to_string();
        let t = v.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    }

    impl MediaReader {
        pub fn new() -> Self {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            let manager = Manager::RequestAsync().ok().and_then(|op| op.get().ok());
            Self { manager }
        }

        fn snapshot(session: &Session) -> Option<MediaSnapshot> {
            let aumid = session.SourceAppUserModelId().ok()?.to_string();
            if aumid.trim().is_empty() {
                return None;
            }
            let playing = session
                .GetPlaybackInfo()
                .and_then(|i| i.PlaybackStatus())
                .map(|s| s == Status::Playing)
                .unwrap_or(false);
            let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
            let title = opt_string(props.Title());
            let artist = opt_string(props.Artist());
            let album = opt_string(props.AlbumTitle());
            // MediaPlaybackType is an IReference (nullable); absent ⇒ Unknown.
            let playback_type = props
                .PlaybackType()
                .ok()
                .and_then(|r| r.Value().ok())
                .map(|t| t.0);
            Some(MediaSnapshot {
                app_name: friendly_app_name(&aumid),
                source_app: aumid,
                title,
                artist,
                album,
                playing,
                playback_type,
            })
        }

        /// All current media sessions (each with its own playback state).
        pub fn sessions(&self) -> Vec<MediaSnapshot> {
            let Some(mgr) = &self.manager else { return Vec::new() };
            let Ok(list) = mgr.GetSessions() else { return Vec::new() };
            let mut out = Vec::new();
            if let Ok(n) = list.Size() {
                for i in 0..n {
                    if let Ok(s) = list.GetAt(i) {
                        if let Some(snap) = Self::snapshot(&s) {
                            if snap.has_content() {
                                out.push(snap);
                            }
                        }
                    }
                }
            }
            out
        }

        /// Read the current track's thumbnail bytes for a given source app.
        pub fn thumbnail_for(&self, source_app: &str) -> Option<Vec<u8>> {
            let mgr = self.manager.as_ref()?;
            let list = mgr.GetSessions().ok()?;
            let n = list.Size().ok()?;
            for i in 0..n {
                let session = list.GetAt(i).ok()?;
                let aumid = session.SourceAppUserModelId().ok()?.to_string();
                if aumid != source_app {
                    continue;
                }
                let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
                let reference = props.Thumbnail().ok()?;
                let stream = reference.OpenReadAsync().ok()?.get().ok()?;
                let size = stream.Size().ok()? as u32;
                if size == 0 || size > 8_000_000 {
                    return None;
                }
                let input = stream.GetInputStreamAt(0).ok()?;
                let reader = DataReader::CreateDataReader(&input).ok()?;
                reader.LoadAsync(size).ok()?.get().ok()?;
                let mut buf = vec![0u8; size as usize];
                reader.ReadBytes(&mut buf).ok()?;
                return Some(buf);
            }
            None
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::MediaSnapshot;
    pub struct MediaReader;
    impl MediaReader {
        pub fn new() -> Self {
            MediaReader
        }
        pub fn sessions(&self) -> Vec<MediaSnapshot> {
            Vec::new()
        }
        pub fn thumbnail_for(&self, _source_app: &str) -> Option<Vec<u8>> {
            None
        }
    }
}
