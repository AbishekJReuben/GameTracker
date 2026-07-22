//! Bounded, native link metadata fetcher. Keeping it outside the WebView avoids
//! CORS and gives desktop + Android the same Open Graph/Twitter/fav-icon order.
use scraper::{Html, Selector};
use serde::Serialize;
use std::io::Read;
use std::net::IpAddr;
use std::time::Duration;
use url::Url;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    pub url: String,
    pub host: String,
    pub title: String,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub favicon_url: Option<String>,
    pub source: String,
}

fn safe_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid link")?;
    if !matches!(url.scheme(), "http" | "https") { return Err("Only web links can be previewed".into()); }
    let host = url.host_str().ok_or("Link has no host")?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".local") { return Err("Local links are not previewed".into()); }
    if let Ok(ip) = host.parse::<IpAddr>() {
        let private = match ip {
            IpAddr::V4(v) => v.is_loopback() || v.is_private() || v.is_unspecified() || v.is_link_local(),
            IpAddr::V6(v) => v.is_loopback() || v.is_unspecified() || v.is_unique_local() || v.is_unicast_link_local(),
        };
        if private { return Err("Private-network links are not previewed".into()); }
    }
    Ok(url)
}

fn absolute(base: &Url, value: Option<&str>) -> Option<String> {
    value.and_then(|v| base.join(v.trim()).ok()).map(|u| u.into())
}

fn text(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|v| !v.is_empty()).map(|v| v.chars().take(280).collect())
}

pub fn fetch(raw: String) -> Result<LinkPreview, String> {
    let mut url = safe_url(&raw)?;
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).redirects(0).build();
    let mut html = String::new();
    for _ in 0..4 {
        match agent.get(url.as_str()).set("User-Agent", "GameTracker-LinkPreview/1.0").call() {
            Ok(response) => {
                response.into_reader().take(512 * 1024).read_to_string(&mut html).map_err(|e| e.to_string())?;
                break;
            }
            Err(ureq::Error::Status(code, response)) if (300..400).contains(&code) => {
                let next = absolute(&url, response.header("Location")).ok_or("Invalid redirect")?;
                url = safe_url(&next)?;
            }
            Err(e) => return Err(format!("Could not load link: {e}")),
        }
    }
    if html.is_empty() { return Err("Link redirected too many times".into()); }
    let doc = Html::parse_document(&html);
    let meta = Selector::parse("meta").map_err(|e| e.to_string())?;
    let mut og_title = None; let mut og_description = None; let mut og_image = None;
    let mut twitter_title = None; let mut twitter_description = None; let mut twitter_image = None;
    for node in doc.select(&meta) {
        let key = node.value().attr("property").or_else(|| node.value().attr("name")).unwrap_or("").to_ascii_lowercase();
        let value = text(node.value().attr("content"));
        match key.as_str() {
            "og:title" => og_title = value, "og:description" => og_description = value, "og:image" | "og:image:url" => og_image = absolute(&url, value.as_deref()),
            "twitter:title" => twitter_title = value, "twitter:description" => twitter_description = value, "twitter:image" | "twitter:image:src" => twitter_image = absolute(&url, value.as_deref()), _ => {}
        }
    }
    let title_tag = Selector::parse("title").map_err(|e| e.to_string())?;
    let page_title = doc.select(&title_tag).next().map(|n| n.text().collect::<String>()).and_then(|v| text(Some(&v)));
    let icon_sel = Selector::parse("link[rel]").map_err(|e| e.to_string())?;
    let favicon = doc.select(&icon_sel).find_map(|n| n.value().attr("rel").filter(|r| r.to_ascii_lowercase().contains("icon")).and_then(|_| absolute(&url, n.value().attr("href"))));
    let host = url.host_str().unwrap_or_default().trim_start_matches("www.").to_string();
    let (image_url, source) = if og_image.is_some() { (og_image, "openGraph") } else if twitter_image.is_some() { (twitter_image, "twitterCard") } else { (None, "favicon") };
    Ok(LinkPreview { url: url.to_string(), host: host.clone(), title: og_title.or(twitter_title).or(page_title).unwrap_or_else(|| host.clone()), description: og_description.or(twitter_description), image_url, favicon_url: favicon.or_else(|| Some(format!("{}/favicon.ico", url.origin().ascii_serialization()))), source: source.into() })
}
