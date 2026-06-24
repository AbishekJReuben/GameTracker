//! GOG OAuth2 sign-in via the system browser.
//!
//! The Galaxy client only registers `https://embed.gog.com/on_login_success?origin=client`
//! as a redirect URI. After sign-in, paste the full redirect URL (or just the code) back
//! into Tracker — an in-app webview shows a blank page on GOG's login (WebView2 issue).

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

pub const CLIENT_ID: &str = "46899977096215655";
pub const CLIENT_SECRET: &str =
    "9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9";

pub const REDIRECT_URI: &str = "https://embed.gog.com/on_login_success?origin=client";

const AUTH_URL: &str = "https://auth.gog.com/auth";
const TOKEN_URL: &str = "https://auth.gog.com/token";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GogTokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub expires_in: u64,
    #[serde(default)]
    pub token_type: String,
}

/// Browser login URL (registered redirect URI).
pub fn login_url() -> String {
    build_login_url(REDIRECT_URI)
}

/// Accept a pasted redirect URL or raw authorization code.
pub fn complete_from_user_input(input: &str) -> AppResult<GogTokenResponse> {
    let code = extract_code_from_user_input(input)?;
    exchange_code(&code, REDIRECT_URI)
}

pub fn extract_code_from_user_input(input: &str) -> AppResult<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::msg("Paste the GOG redirect URL or authorization code."));
    }
    if trimmed.contains("code=") || trimmed.contains("error=") {
        return code_from_callback_url(trimmed);
    }
    Ok(trimmed.to_string())
}

pub fn build_login_url(redirect_uri: &str) -> String {
    format!(
        "{AUTH_URL}?client_id={cid}&redirect_uri={red}&response_type=code&layout=client2",
        cid = pct(CLIENT_ID),
        red = pct(redirect_uri),
    )
}

fn code_from_callback_url(url: &str) -> AppResult<String> {
    let query = url.split('?').nth(1).unwrap_or(url);
    let params = parse_query(query)?;
    if let Some(err) = params.get("error") {
        let detail = params
            .get("error_description")
            .map(|s| s.as_str())
            .unwrap_or("");
        return Err(AppError::msg(if detail.is_empty() {
            format!("GOG sign-in failed: {err}")
        } else {
            format!("GOG sign-in failed: {detail}")
        }));
    }
    params
        .get("code")
        .cloned()
        .filter(|c| !c.is_empty())
        .ok_or_else(|| AppError::msg("GOG did not return an authorization code."))
}

fn parse_query(query: &str) -> AppResult<HashMap<String, String>> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair
            .split_once('=')
            .map(|(a, b)| (a, b))
            .unwrap_or((pair, ""));
        map.insert(pct_decode(k), pct_decode(v));
    }
    Ok(map)
}

pub fn exchange_code(code: &str, redirect_uri: &str) -> AppResult<GogTokenResponse> {
    let url = format!(
        "{TOKEN_URL}?client_id={cid}&client_secret={sec}&grant_type=authorization_code&code={code}&redirect_uri={red}",
        cid = pct(CLIENT_ID),
        sec = pct(CLIENT_SECRET),
        code = pct(code),
        red = pct(redirect_uri),
    );
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| AppError::msg(format!("GOG token request failed: {e}")))?;
    let token: GogTokenResponse = resp
        .into_json()
        .map_err(|e| AppError::msg(format!("Invalid GOG token response: {e}")))?;
    if token.access_token.is_empty() || token.user_id.is_empty() {
        return Err(AppError::msg("GOG returned an incomplete token."));
    }
    Ok(token)
}

pub fn refresh_token(refresh: &str) -> AppResult<GogTokenResponse> {
    let url = format!(
        "{TOKEN_URL}?client_id={cid}&client_secret={sec}&grant_type=refresh_token&refresh_token={rt}",
        cid = pct(CLIENT_ID),
        sec = pct(CLIENT_SECRET),
        rt = pct(refresh),
    );
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| AppError::msg(format!("GOG token refresh failed: {e}")))?;
    resp.into_json()
        .map_err(|e| AppError::msg(format!("Invalid GOG refresh response: {e}")))
}

fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn pct_decode(s: &str) -> String {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_code_from_embed_redirect() {
        let url = "https://embed.gog.com/on_login_success?origin=client&code=abc123";
        assert_eq!(extract_code_from_user_input(url).unwrap(), "abc123");
    }

    #[test]
    fn accepts_raw_code() {
        assert_eq!(extract_code_from_user_input("raw-code-xyz").unwrap(), "raw-code-xyz");
    }
}
