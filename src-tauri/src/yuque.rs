use reqwest::{header, multipart};
use serde::Deserialize;
use url::Url;

const UPLOAD_ENDPOINT: &str = "https://www.yuque.com/api/upload/attach";
const YUQUE_ORIGIN_REFERER: &str = "https://www.yuque.com/";
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const BROWSER_ACCEPT: &str = "text/javascript, text/html, application/xml, text/xml, */*";
const BROWSER_ACCEPT_LANGUAGE: &str = "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7";
const BROWSER_ACCEPT_ENCODING: &str = "gzip, deflate, br, zstd";
const BROWSER_CLIENT_HINT: &str =
    "\"Not;A=Brand\";v=\"8\", \"Chromium\";v=\"150\", \"Microsoft Edge\";v=\"150\"";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;
const MAX_DOCUMENT_PAGE_BYTES: usize = 5 * 1024 * 1024;
const ALLOWED_IMAGE_HOST_SUFFIXES: &[&str] = &["yuque.com", "nlark.com"];

#[derive(Debug, Deserialize)]
struct YuqueEnvelope {
    data: Option<YuqueUploadData>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YuqueUploadData {
    url: Option<String>,
}

#[derive(Debug)]
pub struct DownloadedImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

#[derive(Debug)]
pub struct SessionDocumentContext {
    pub attachable_id: i64,
    pub document_url: String,
    pub title: String,
}

pub async fn resolve_document_context(
    cookie: &str,
    raw_url: &str,
) -> Result<SessionDocumentContext, String> {
    let document_url = normalize_document_url(raw_url)?;
    let client = secure_client(std::time::Duration::from_secs(60))?;
    let response = client
        .get(&document_url)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, YUQUE_ORIGIN_REFERER)
        .header(
            header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        )
        .header(header::ACCEPT_LANGUAGE, BROWSER_ACCEPT_LANGUAGE)
        .header(header::USER_AGENT, BROWSER_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("读取语雀文档页面失败：{error}"))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("语雀文档拒绝访问，请重新登录或确认当前账号拥有文档权限。".into());
    }
    if status.is_redirection() {
        return Err("语雀文档页面返回重定向，QuePic 已拒绝继续请求。".into());
    }
    if !status.is_success() {
        return Err(format!("读取语雀文档页面失败（HTTP {status}）。"));
    }
    if response.content_length().unwrap_or(0) as usize > MAX_DOCUMENT_PAGE_BYTES {
        return Err("语雀文档页面响应体异常过大。".into());
    }

    let html = response
        .text()
        .await
        .map_err(|error| format!("读取语雀文档页面内容失败：{error}"))?;
    if html.len() > MAX_DOCUMENT_PAGE_BYTES {
        return Err("语雀文档页面响应体异常过大。".into());
    }
    if html.to_ascii_lowercase().contains("/login") && !html.contains("appData") {
        return Err("语雀返回了登录页面，请重新登录后重试。".into());
    }

    let attachable_id = extract_document_id(&html).ok_or_else(|| {
        "无法从语雀文档页面解析文档 ID；请确认 URL 指向具体文档并重新登录。".to_string()
    })?;
    let title = extract_html_title(&html).unwrap_or_else(|| "语雀上传上下文".into());
    Ok(SessionDocumentContext {
        attachable_id,
        document_url,
        title,
    })
}

pub async fn upload(
    cookie: &str,
    file_name: &str,
    mime_type: &str,
    bytes: Vec<u8>,
    attachable_id: Option<i64>,
    referer_url: &Option<String>,
) -> Result<String, String> {
    let upload_url = build_upload_url(cookie, attachable_id)?;
    let referer_url = resolve_upload_referer(attachable_id, referer_url.as_deref())?;
    let part = multipart::Part::bytes(bytes)
        .file_name(file_name.to_string())
        .mime_str(mime_type)
        .map_err(|_| "图片 MIME 类型无效。".to_string())?;
    let form = multipart::Form::new().part("file", part);

    let client = secure_client(std::time::Duration::from_secs(90))?;
    let response = client
        .post(upload_url)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, &referer_url)
        .header(header::ORIGIN, "https://www.yuque.com")
        .header(header::ACCEPT, BROWSER_ACCEPT)
        .header(header::ACCEPT_LANGUAGE, BROWSER_ACCEPT_LANGUAGE)
        .header(header::ACCEPT_ENCODING, BROWSER_ACCEPT_ENCODING)
        .header(header::USER_AGENT, BROWSER_USER_AGENT)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-origin")
        .header("sec-ch-ua", BROWSER_CLIENT_HINT)
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", "\"Windows\"")
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("连接语雀图片接口失败：{error}"))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(if attachable_id.is_some() {
            "语雀 Cookie、ctoken 已失效或文档权限不足，请重新登录。".into()
        } else {
            "语雀 Cookie 或 ctoken 已失效，请重新登录。".into()
        });
    }
    if status.is_redirection() {
        return Err("语雀上传接口返回了重定向。为避免 Cookie 泄露，QuePic 已拒绝继续请求。".into());
    }

    let content_length = response.content_length().unwrap_or(0) as usize;
    if content_length > MAX_RESPONSE_BYTES {
        return Err("语雀返回内容异常，响应体过大。".into());
    }

    let response_text = response
        .text()
        .await
        .map_err(|error| format!("读取语雀响应失败：{error}"))?;
    if response_text.len() > MAX_RESPONSE_BYTES {
        return Err("语雀返回内容异常，响应体过大。".into());
    }

    let payload: YuqueEnvelope = serde_json::from_str(&response_text).map_err(|_| {
        if response_text.contains("登录") || response_text.to_ascii_lowercase().contains("login")
        {
            "语雀返回了登录页面，Cookie 可能已经失效。".to_string()
        } else {
            "语雀上传接口返回格式已经变化，请更新 QuePic。".to_string()
        }
    })?;

    if !status.is_success() {
        return Err(payload
            .message
            .map(|message| format!("语雀拒绝上传：{message}"))
            .unwrap_or_else(|| format!("语雀拒绝上传（HTTP {status}）。")));
    }

    let raw_url = payload
        .data
        .and_then(|data| data.url)
        .ok_or_else(|| "语雀图片接口未返回图片地址。".to_string())?;
    normalize_remote_url(&raw_url)
}

fn build_upload_url(cookie: &str, attachable_id: Option<i64>) -> Result<Url, String> {
    let ctoken = cookie_value(cookie, "yuque_ctoken")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "语雀 Cookie 中缺少 yuque_ctoken，请重新登录后再上传。".to_string())?;
    let mut url =
        Url::parse(UPLOAD_ENDPOINT).map_err(|error| format!("语雀上传地址无效：{error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("attachable_type", "Doc");
        if let Some(attachable_id) = attachable_id {
            if attachable_id <= 0 {
                return Err("上传上下文文档 ID 无效，请重新验证文档 URL。".into());
            }
            query.append_pair("attachable_id", &attachable_id.to_string());
        }
        query
            .append_pair("type", "image")
            .append_pair("ocr", "off")
            .append_pair("ctoken", &ctoken);
    }
    Ok(url)
}

fn resolve_upload_referer(
    attachable_id: Option<i64>,
    referer_url: Option<&str>,
) -> Result<String, String> {
    match (attachable_id, referer_url) {
        (Some(_), Some(referer_url)) => normalize_document_url(referer_url),
        (Some(_), None) => Err("文档关联上传缺少 Referer，请重新准备主账号上传上下文。".into()),
        (None, _) => Ok(YUQUE_ORIGIN_REFERER.to_string()),
    }
}

fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| key.trim() == name)
        .map(|(_, value)| value.trim().to_string())
}

pub async fn download_image(cookie: &str, remote_url: &str) -> Result<DownloadedImage, String> {
    let normalized = normalize_remote_url(remote_url)?;
    let client = secure_client(std::time::Duration::from_secs(60))?;
    let mut response = client
        .get(&normalized)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, YUQUE_ORIGIN_REFERER)
        .header(
            header::ACCEPT,
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .header(header::USER_AGENT, BROWSER_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("从语雀回源图片失败：{error}"))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("语雀图片拒绝访问，请重新登录后重试。".into());
    }
    if status.is_redirection() {
        return Err("语雀图片返回重定向，QuePic 已拒绝继续请求。".into());
    }
    if !status.is_success() {
        return Err(format!("语雀图片回源失败（HTTP {status}）。"));
    }

    if response.content_length().unwrap_or(0) as usize > MAX_IMAGE_DOWNLOAD_BYTES {
        return Err("远程图片超过 50 MB 缓存限制。".into());
    }

    let mime_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("application/octet-stream")
        .trim()
        .to_ascii_lowercase();
    if !mime_type.starts_with("image/") {
        return Err(format!("语雀返回的不是图片内容：{mime_type}"));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取语雀图片数据失败：{error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_DOWNLOAD_BYTES {
            return Err("远程图片超过 50 MB 缓存限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("语雀返回了空图片。".into());
    }

    Ok(DownloadedImage { bytes, mime_type })
}

fn extract_document_id(html: &str) -> Option<i64> {
    const MARKERS: &[&str] = &[
        "\"doc\":{\"id\":",
        "\"doc\": {\"id\":",
        "\\\"doc\\\":{\\\"id\\\":",
        "appData.doc={\"id\":",
        "appData.doc = {\"id\":",
        "\"doc_id\":",
    ];
    MARKERS.iter().find_map(|marker| {
        html.find(marker)
            .and_then(|index| parse_number_after(&html[index + marker.len()..]))
    })
}

fn parse_number_after(value: &str) -> Option<i64> {
    let digits = value
        .trim_start_matches(|character: char| character.is_ascii_whitespace() || character == '\"')
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    let parsed = digits.parse::<i64>().ok()?;
    (parsed > 0).then_some(parsed)
}

fn extract_html_title(html: &str) -> Option<String> {
    let start = html.to_ascii_lowercase().find("<title")?;
    let content_start = html[start..].find('>')? + start + 1;
    let end = html[content_start..]
        .to_ascii_lowercase()
        .find("</title>")?
        + content_start;
    let title = decode_basic_html(html[content_start..end].trim())
        .trim_end_matches(" · 语雀")
        .trim_end_matches(" - 语雀")
        .trim()
        .to_string();
    (!title.is_empty()).then_some(title)
}

fn decode_basic_html(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

pub fn wordpress_proxy_url(remote_url: &str, width: Option<u32>) -> Result<String, String> {
    let parsed = Url::parse(&normalize_remote_url(remote_url)?)
        .map_err(|_| "无法生成 WordPress 图片代理地址。".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "图片地址缺少域名。".to_string())?;
    let mut proxy = format!("https://i3.wp.com/{host}{}", parsed.path());

    let mut query = parsed.query().unwrap_or_default().to_string();
    if let Some(width) = width.filter(|value| *value > 0 && *value <= 2_048) {
        if !query.is_empty() {
            query.push('&');
        }
        query.push_str(&format!("w={width}"));
    }
    if !query.is_empty() {
        proxy.push('?');
        proxy.push_str(&query);
    }
    Ok(proxy)
}

pub fn normalize_document_url(raw_url: &str) -> Result<String, String> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|_| "上传上下文必须是完整的语雀文档 URL。".to_string())?;
    if parsed.scheme() != "https" {
        return Err("上传上下文文档 URL 必须使用 HTTPS。".into());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "www.yuque.com" && host != "yuque.com" {
        return Err("上传上下文只支持 yuque.com 文档 URL。".into());
    }
    let segments = parsed
        .path_segments()
        .map(|segments| {
            segments
                .filter(|segment| !segment.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if segments.len() < 3 {
        return Err("上传上下文 URL 必须指向具体语雀文档。".into());
    }
    Ok(format!(
        "https://www.yuque.com/{}/{}/{}",
        segments[0], segments[1], segments[2]
    ))
}

pub fn normalize_remote_url(raw_url: &str) -> Result<String, String> {
    let normalized = if raw_url.starts_with("//") {
        format!("https:{raw_url}")
    } else {
        raw_url.to_string()
    };
    let parsed = Url::parse(&normalized).map_err(|_| "语雀返回了无效的图片地址。".to_string())?;
    if parsed.scheme() != "https" {
        return Err("语雀返回的图片地址不是 HTTPS。".into());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "语雀返回的图片地址缺少域名。".to_string())?
        .to_ascii_lowercase();
    if !ALLOWED_IMAGE_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err("语雀返回了不受信任的图片域名，QuePic 已拒绝使用该链接。".into());
    }

    Ok(parsed.to_string())
}

fn secure_client(timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("无法初始化网络客户端：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        build_upload_url, cookie_value, extract_document_id, extract_html_title,
        normalize_document_url, normalize_remote_url, resolve_upload_referer, wordpress_proxy_url,
        YUQUE_ORIGIN_REFERER,
    };

    #[test]
    fn extracts_session_document_metadata() {
        let html = r#"<html><head><title>测试文档 · 语雀</title></head><body><script>window.appData={"doc":{"id":123456,"title":"测试文档"}}</script></body></html>"#;
        assert_eq!(extract_document_id(html), Some(123456));
        assert_eq!(extract_html_title(html).as_deref(), Some("测试文档"));
    }

    #[test]
    fn builds_official_doc_upload_context() {
        let url = build_upload_url(
            "lang=zh-cn; yuque_ctoken=test-token; current_theme=default",
            Some(123456),
        )
        .unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            query.get("attachable_type").map(|value| value.as_ref()),
            Some("Doc")
        );
        assert_eq!(
            query.get("attachable_id").map(|value| value.as_ref()),
            Some("123456")
        );
        assert_eq!(query.get("type").map(|value| value.as_ref()), Some("image"));
        assert_eq!(query.get("ocr").map(|value| value.as_ref()), Some("off"));
        assert_eq!(
            query.get("ctoken").map(|value| value.as_ref()),
            Some("test-token")
        );
    }

    #[test]
    fn builds_contextless_upload_for_child_account() {
        let url = build_upload_url(
            "lang=zh-cn; yuque_ctoken=child-token; current_theme=default",
            None,
        )
        .unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            query.get("attachable_type").map(|value| value.as_ref()),
            Some("Doc")
        );
        assert!(!query.contains_key("attachable_id"));
        assert_eq!(query.get("type").map(|value| value.as_ref()), Some("image"));
        assert_eq!(query.get("ocr").map(|value| value.as_ref()), Some("off"));
        assert_eq!(
            query.get("ctoken").map(|value| value.as_ref()),
            Some("child-token")
        );
        assert_eq!(
            resolve_upload_referer(None, Some("https://www.yuque.com/other/book/doc")).unwrap(),
            YUQUE_ORIGIN_REFERER
        );
    }

    #[test]
    fn requires_ctoken_from_cookie() {
        assert_eq!(
            cookie_value("a=1; yuque_ctoken=abc-123; b=2", "yuque_ctoken").as_deref(),
            Some("abc-123")
        );
        assert!(build_upload_url("a=1; b=2", Some(123456)).is_err());
        assert!(build_upload_url("yuque_ctoken=abc", Some(0)).is_err());
    }

    #[test]
    fn validates_upload_referer_by_mode() {
        assert_eq!(
            resolve_upload_referer(
                Some(123456),
                Some("https://yuque.com/team/book/document?view=doc_embed"),
            )
            .unwrap(),
            "https://www.yuque.com/team/book/document"
        );
        assert!(resolve_upload_referer(Some(123456), None).is_err());
        assert_eq!(
            resolve_upload_referer(None, None).unwrap(),
            YUQUE_ORIGIN_REFERER
        );
    }

    #[test]
    fn validates_account_document_referer() {
        assert_eq!(
            normalize_document_url("https://yuque.com/team/book/document?view=doc_embed").unwrap(),
            "https://www.yuque.com/team/book/document"
        );
        assert!(normalize_document_url("https://example.com/team/book/document").is_err());
        assert!(normalize_document_url("https://www.yuque.com/team/book").is_err());
    }

    #[test]
    fn accepts_yuque_cdn_urls() {
        assert_eq!(
            normalize_remote_url("//cdn.nlark.com/yuque/example.png").unwrap(),
            "https://cdn.nlark.com/yuque/example.png"
        );
        assert!(normalize_remote_url("https://cdn.yuque.com/example.png").is_ok());
    }

    #[test]
    fn rejects_untrusted_or_insecure_urls() {
        assert!(normalize_remote_url("http://cdn.nlark.com/example.png").is_err());
        assert!(normalize_remote_url("https://example.com/image.png").is_err());
        assert!(normalize_remote_url("https://nlark.com.evil.example/image.png").is_err());
    }

    #[test]
    fn creates_wordpress_proxy_url_without_accepting_arbitrary_hosts() {
        assert_eq!(
            wordpress_proxy_url("https://cdn.nlark.com/yuque/example.jpg", Some(640)).unwrap(),
            "https://i3.wp.com/cdn.nlark.com/yuque/example.jpg?w=640"
        );
        assert!(wordpress_proxy_url("https://example.com/image.jpg", Some(640)).is_err());
    }
}
