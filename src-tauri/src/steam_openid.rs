//! Steam OpenID 2.0 sign-in via a one-shot loopback HTTP listener.
//!
//! https://steamcommunity.com/dev — provider URL `https://steamcommunity.com/openid`

use crate::error::{AppError, AppResult};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const OPENID_LOGIN: &str = "https://steamcommunity.com/openid/login";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const READ_BUF: usize = 16_384;

const DONE_HTML: &str = concat!(
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: text/html; charset=utf-8\r\n",
    "Connection: close\r\n",
    "Content-Length: 147\r\n",
    "\r\n",
    "<!DOCTYPE html><html><body style=\"font-family:sans-serif;background:#1b2838;color:#c7d5e0;",
    "display:flex;align-items:center;justify-content:center;height:100vh\">",
    "<p>Signed in — return to GameTracker.</p></body></html>"
);

/// Run the browser-based Steam login flow. `open_browser` must open the login URL.
pub fn login_blocking(open_browser: impl FnOnce(&str) -> AppResult<()>) -> AppResult<String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::msg(format!("Could not start sign-in listener: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::msg(e.to_string()))?
        .port();
    let return_to = format!("http://127.0.0.1:{port}/steam/auth");
    let realm = format!("http://127.0.0.1:{port}");
    let login_url = build_login_url(&return_to, &realm);

    let (tx, rx) = mpsc::sync_channel::<AppResult<HashMap<String, String>>>(1);
    thread::spawn(move || {
        let _ = tx.send(accept_callback(&listener));
    });

    open_browser(&login_url)?;

    let params = rx
        .recv_timeout(LOGIN_TIMEOUT)
        .map_err(|_| AppError::msg("Steam sign-in timed out. Try again."))??;

    verify_response(&params)?;
    extract_steam_id(&params)
}

fn build_login_url(return_to: &str, realm: &str) -> String {
    format!(
        "{OPENID_LOGIN}?openid.ns={ns}&openid.mode=checkid_setup&openid.return_to={ret}&openid.realm={realm}&openid.identity={id}&openid.claimed_id={id}",
        ns = pct("http://specs.openid.net/auth/2.0"),
        ret = pct(return_to),
        realm = pct(realm),
        id = pct("http://specs.openid.net/auth/2.0/identifier_select"),
    )
}

fn accept_callback(listener: &TcpListener) -> AppResult<HashMap<String, String>> {
    if let Err(e) = listener.set_nonblocking(true) {
        return Err(AppError::msg(e.to_string()));
    }
    let deadline = std::time::Instant::now() + LOGIN_TIMEOUT;
    loop {
        if std::time::Instant::now() > deadline {
            return Err(AppError::msg("Steam sign-in timed out."));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                if let Ok(params) = read_openid_params(&mut stream) {
                    let _ = stream.write_all(DONE_HTML.as_bytes());
                    return Ok(params);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(AppError::msg(e.to_string())),
        }
    }
}

fn read_openid_params(stream: &mut TcpStream) -> AppResult<HashMap<String, String>> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| AppError::msg(e.to_string()))?;
    let mut buf = vec![0u8; READ_BUF];
    let n = stream
        .read(&mut buf)
        .map_err(|e| AppError::msg(e.to_string()))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| AppError::msg("Invalid sign-in callback."))?;
    let query = path.split('?').nth(1).unwrap_or("");
    parse_query(query)
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
        map.insert(
            pct_decode(k),
            pct_decode(v),
        );
    }
    if !map.contains_key("openid.claimed_id") && !map.contains_key("openid.identity") {
        return Err(AppError::msg("Steam sign-in was cancelled."));
    }
    Ok(map)
}

fn verify_response(params: &HashMap<String, String>) -> AppResult<()> {
    let mut body = String::new();
    for (k, v) in params {
        if k.starts_with("openid.") && k != "openid.mode" {
            if !body.is_empty() {
                body.push('&');
            }
            body.push_str(&format!("{}={}", pct(k), pct(v)));
        }
    }
    if !body.is_empty() {
        body.push('&');
    }
    body.push_str("openid.mode=check_authentication");

    let resp = ureq::post(OPENID_LOGIN)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .timeout(Duration::from_secs(20))
        .send_string(&body)
        .map_err(|e| AppError::msg(format!("Steam verification request failed: {e}")))?;
    let text = resp
        .into_string()
        .map_err(|e| AppError::msg(e.to_string()))?;
    if text.lines().any(|l| l.trim() == "is_valid:true") {
        Ok(())
    } else {
        Err(AppError::msg("Steam rejected the sign-in response."))
    }
}

fn extract_steam_id(params: &HashMap<String, String>) -> AppResult<String> {
    let claimed = params
        .get("openid.claimed_id")
        .or_else(|| params.get("openid.identity"))
        .ok_or_else(|| AppError::msg("Steam did not return a profile id."))?;
    let id = claimed
        .rsplit('/')
        .next()
        .filter(|s| s.chars().all(|c| c.is_ascii_digit()) && s.len() >= 15)
        .ok_or_else(|| AppError::msg("Could not parse SteamID from sign-in."))?;
    Ok(id.to_string())
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
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_steam_id_from_claimed() {
        let mut p = HashMap::new();
        p.insert(
            "openid.claimed_id".into(),
            "https://steamcommunity.com/openid/id/76561198000000000".into(),
        );
        assert_eq!(
            extract_steam_id(&p).unwrap(),
            "76561198000000000"
        );
    }

    #[test]
    fn pct_roundtrip_space() {
        assert_eq!(pct_decode(&pct("hello world")), "hello world");
    }
}
