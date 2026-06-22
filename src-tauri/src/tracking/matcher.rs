use crate::db::games::MatchGame;
use crate::util;

/// Match a normalized/raw exe path to a registered game (exact path first, then install folder).
pub fn match_path<'a>(games: &'a [MatchGame], exe_path: &str) -> Option<&'a MatchGame> {
    let norm = util::normalize_path(exe_path);
    if norm.is_empty() {
        return None;
    }
    if let Some(g) = games
        .iter()
        .find(|g| g.exe_paths.iter().any(|p| util::paths_equal(p, &norm)))
    {
        return Some(g);
    }
    games.iter().find(|g| {
        g.install_folder
            .as_deref()
            .map(|f| util::is_under_folder(&norm, f))
            .unwrap_or(false)
    })
}
