use reqwest::{header, multipart};
use serde::Deserialize;
use url::Url;

const UPLOAD_ENDPOINT: &str = "https://www.yuque.com/api/upload/attach";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_IMAGE_DOWNLOAD_BYTES: usize = 30 * 1024 * 1024;
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

pub async fn upload(
    cookie: &str,
    file_name: &str,
    mime_type: &str,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let part = multipart::Part::bytes(bytes)
        .file_name(file_name.to_string())
        .mime_str(mime_type)
        .map_err(|_| "图片 MIME 类型无效。".to_string())?;
    let form = multipart::Form::new().part("file", part);

    let client = secure_client(std::time::Duration::from_secs(90))?;
    let response = client
        .post(UPLOAD_ENDPOINT)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, "https://www.yuque.com/")
        .header(header::ORIGIN, "https://www.yuque.com")
        .header(header::ACCEPT, "application/json, text/plain, */*")
        .header(header::USER_AGENT, "QuePic/0.2")
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("连接语雀图片接口失败：{error}"))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("语雀 Cookie 已失效或权限不足，请重新登录。".into());
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
        if response_text.contains("登录") || response_text.to_ascii_lowercase().contains("login") {
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

pub async fn download_image(cookie: &str, remote_url: &str) -> Result<DownloadedImage, String> {
    let normalized = normalize_remote_url(remote_url)?;
    let client = secure_client(std::time::Duration::from_secs(60))?;
    let mut response = client
        .get(&normalized)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, "https://www.yuque.com/")
        .header(header::ACCEPT, "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
        .header(header::USER_AGENT, "Mozilla/5.0 QuePic/0.2")
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
        return Err("远程图片超过 30 MB 缓存限制。".into());
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
            return Err("远程图片超过 30 MB 缓存限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("语雀返回了空图片。".into());
    }

    Ok(DownloadedImage { bytes, mime_type })
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
    use super::{normalize_remote_url, wordpress_proxy_url};

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
