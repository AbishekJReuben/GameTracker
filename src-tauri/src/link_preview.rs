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

/// A desktop Chrome string. Several large sites (YouTube among them) serve a
/// metadata-free consent stub to anything that doesn't look like a browser,
/// which is why those links only ever resolved to a bare favicon card.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Video id for a watch / shorts / embed / youtu.be URL.
fn youtube_id(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.trim_start_matches("www.");
    if host == "youtu.be" {
        let id = url.path().trim_matches('/');
        return (!id.is_empty()).then(|| id.to_string());
    }
    if !(host.ends_with("youtube.com") || host.ends_with("youtube-nocookie.com")) { return None; }
    if let Some((_, v)) = url.query_pairs().find(|(k, _)| k == "v") {
        if !v.is_empty() { return Some(v.into_owned()); }
    }
    let mut parts = url.path().trim_matches('/').split('/');
    let head = parts.next()?;
    matches!(head, "shorts" | "embed" | "live" | "v")
        .then(|| parts.next().map(str::to_string))
        .flatten()
        .filter(|id| !id.is_empty())
}

/// oEmbed gives title + channel with no API key and no quota, and the thumbnail
/// is derivable from the id, so a YouTube card costs exactly one small request.
fn youtube_preview(url: &Url, id: &str, agent: &ureq::Agent) -> LinkPreview {
    let image = format!("https://i.ytimg.com/vi/{id}/maxresdefault.jpg");
    let oembed = format!("https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch%3Fv%3D{id}");
    let (mut title, mut author) = (None, None);
    // Parsed from the response text rather than `into_json`: this module is shared
    // verbatim with the companion crate, whose ureq is built without the `json`
    // feature. serde_json is a direct dependency of both.
    if let Ok(body) = agent
        .get(&oembed)
        .set("User-Agent", UA)
        .call()
        .map_err(|e| e.to_string())
        .and_then(|r| r.into_string().map_err(|e| e.to_string()))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))
    {
        title = body.get("title").and_then(|v| v.as_str()).map(str::to_string);
        author = body.get("author_name").and_then(|v| v.as_str()).map(str::to_string);
    }
    LinkPreview {
        url: url.to_string(),
        host: "youtube.com".into(),
        title: title.unwrap_or_else(|| "YouTube".into()),
        description: author,
        image_url: Some(image),
        favicon_url: Some("https://www.youtube.com/favicon.ico".into()),
        source: "openGraph".into(),
    }
}

/// Preview for a URL that points straight at an image file.
fn direct_image(url: &Url) -> Option<LinkPreview> {
    let path = url.path().to_ascii_lowercase();
    let ext = path.rsplit('.').next()?;
    if !matches!(ext, "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif" | "bmp") { return None; }
    let host = url.host_str()?.trim_start_matches("www.").to_string();
    let name = url.path_segments()?.next_back()?.to_string();
    Some(LinkPreview {
        url: url.to_string(),
        host: host.clone(),
        title: name,
        description: None,
        image_url: Some(url.to_string()),
        favicon_url: Some(format!("{}/favicon.ico", url.origin().ascii_serialization())),
        source: "openGraph".into(),
    })
}

/// Product image for an Amazon `/dp/<ASIN>` or `/gp/product/<ASIN>` URL.
fn amazon_image(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    if !host.contains("amazon.") { return None; }
    let mut segments = url.path_segments()?.peekable();
    let mut asin = None;
    while let Some(seg) = segments.next() {
        if matches!(seg, "dp" | "product" | "gp") {
            if let Some(next) = segments.peek() {
                let candidate = next.trim();
                if candidate.len() == 10 && candidate.chars().all(|c| c.is_ascii_alphanumeric()) {
                    asin = Some(candidate.to_string());
                    break;
                }
            }
        }
    }
    Some(format!("https://images-na.ssl-images-amazon.com/images/P/{}.01._SCLZZZZZZZ_.jpg", asin?))
}

pub fn fetch(raw: String) -> Result<LinkPreview, String> {
    let mut url = safe_url(&raw)?;
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(8)).redirects(0).build();
    if let Some(id) = youtube_id(&url) {
        return Ok(youtube_preview(&url, &id, &agent));
    }
    // A link that *is* an image previews as that image. Fetching it as HTML would
    // download the whole file only to produce a card titled with the host.
    if let Some(preview) = direct_image(&url) {
        return Ok(preview);
    }
    let mut html = String::new();
    for _ in 0..4 {
        match agent
            .get(url.as_str())
            .set("User-Agent", UA)
            .set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .set("Accept-Language", "en-US,en;q=0.9")
            // Retail and CDN edges profile more than the UA string; without the
            // fetch-metadata headers a request is obviously automated and gets a
            // stub page back. `identity` because this agent can't decompress.
            .set("Accept-Encoding", "identity")
            .set("Sec-Fetch-Dest", "document")
            .set("Sec-Fetch-Mode", "navigate")
            .set("Sec-Fetch-Site", "none")
            .set("Sec-Fetch-User", "?1")
            .set("Upgrade-Insecure-Requests", "1")
            .call()
        {
            // ureq only reports 4xx/5xx as `Err(Status)`, so a redirect arrives
            // here as a perfectly successful response whose body is the "301 Moved
            // Permanently" stub — which is exactly what the card ended up showing.
            // Redirects are followed by hand (rather than by ureq) so every hop is
            // re-checked by `safe_url` and can't be aimed at a private address.
            Ok(response) if (300..400).contains(&response.status()) => {
                let next = absolute(&url, response.header("Location")).ok_or("Invalid redirect")?;
                url = safe_url(&next)?;
            }
            Ok(response) => {
                // Bytes, not read_to_string: a single invalid UTF-8 byte anywhere in
                // the page would otherwise fail the whole preview.
                let mut bytes = Vec::new();
                response.into_reader().take(512 * 1024).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                html = String::from_utf8_lossy(&bytes).into_owned();
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
    let mut meta_description = None;
    for node in doc.select(&meta) {
        let key = node.value().attr("property").or_else(|| node.value().attr("name")).unwrap_or("").to_ascii_lowercase();
        let value = text(node.value().attr("content"));
        match key.as_str() {
            "og:title" => og_title = value, "og:description" => og_description = value, "og:image" | "og:image:url" => og_image = absolute(&url, value.as_deref()),
            "twitter:title" => twitter_title = value, "twitter:description" => twitter_description = value, "twitter:image" | "twitter:image:src" => twitter_image = absolute(&url, value.as_deref()),
            "description" => meta_description = value, _ => {}
        }
    }
    let title_tag = Selector::parse("title").map_err(|e| e.to_string())?;
    let page_title = doc.select(&title_tag).next().map(|n| n.text().collect::<String>()).and_then(|v| text(Some(&v)));
    let icon_sel = Selector::parse("link[rel]").map_err(|e| e.to_string())?;
    let favicon = doc.select(&icon_sel).find_map(|n| n.value().attr("rel").filter(|r| r.to_ascii_lowercase().contains("icon")).and_then(|_| absolute(&url, n.value().attr("href"))));
    let host = url.host_str().unwrap_or_default().trim_start_matches("www.").to_string();
    // Older sites publish no card tags at all but do declare `rel=image_src`.
    let image_src = doc
        .select(&icon_sel)
        .find(|n| n.value().attr("rel").is_some_and(|r| r.eq_ignore_ascii_case("image_src")))
        .and_then(|n| absolute(&url, n.value().attr("href")));
    let (image_url, source) = if og_image.is_some() {
        (og_image, "openGraph")
    } else if twitter_image.is_some() {
        (twitter_image, "twitterCard")
    } else if image_src.is_some() {
        (image_src, "openGraph")
    } else if let Some(image) = amazon_image(&url) {
        // Amazon deliberately ships no og:image, but every product image is
        // addressable by ASIN — the same trick the chat apps' crawlers use.
        (Some(image), "openGraph")
    } else {
        (None, "favicon")
    };
    let title = og_title.or(twitter_title).or(page_title).unwrap_or_else(|| host.clone());
    // Plenty of pages set description to the title verbatim; showing it twice
    // just wastes the card's second line.
    let description = og_description.or(twitter_description).or(meta_description).filter(|d| d != &title);
    Ok(LinkPreview { url: url.to_string(), host: host.clone(), title, description, image_url, favicon_url: favicon.or_else(|| Some(format!("{}/favicon.ico", url.origin().ascii_serialization()))), source: source.into() })
}
