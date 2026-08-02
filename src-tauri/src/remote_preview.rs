use std::{sync::Arc, time::Duration};

use reqwest::{header, redirect::Policy};
use tokio::{sync::{Mutex, OwnedSemaphorePermit, Semaphore}, time::{sleep, Instant}};
use url::Url;

const MAX_IMAGE_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;
const MINIMUM_REQUEST_INTERVAL: Duration = Duration::from_millis(750);
const MAX_CONCURRENT_REQUESTS: usize = 2;
const ALLOWED_IMAGE_HOST_SUFFIXES: &[&str] = &["yuque.com", "nlark.com"];
const USER_AGENT: &str = "QuePic/0.4 remote-preview";

#[derive(Debug)]
pub struct DownloadedImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

pub struct RequestLimiter {
    semaphore: Arc<Semaphore>,
    last_started: Mutex<Option<Instant>>,
}

impl RequestLimiter {
    pub fn new() -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
            last_started: Mutex::new(None),
        }
    }

    async fn acquire(&self) -> Result<OwnedSemaphorePermit, String> {
        let permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "远程缩略图限流器已关闭。".to_string())?;

        let mut last_started = self.last_started.lock().await;
        if let Some(last) = *last_started {
            let elapsed = last.elapsed();
            if elapsed < MINIMUM_REQUEST_INTERVAL {
                sleep(MINIMUM_REQUEST_INTERVAL - elapsed).await;
            }
        }
        *last_started = Some(Instant::now());
        drop(last_started);
        Ok(permit)
    }
}

pub async fn download_preview(
    limiter: Arc<RequestLimiter>,
    remote_url: &str,
    prefer_original: bool,
) -> Result<DownloadedImage, String> {
    let normalized = normalize_remote_url(remote_url)?;
    let candidates = preview_candidates(&normalized, prefer_original);
    let mut errors = Vec::new();

    for candidate in candidates {
        let _permit = limiter.acquire().await?;
        match download_candidate(&candidate).await {
            Ok(image) => return Ok(image),
            Err(error) => errors.push(error),
        }
    }

    Err(format!(
        "无法通过已上传 URL 获取图片：{}",
        errors.last().cloned().unwrap_or_else(|| "远程地址不可用。".into())
    ))
}

async fn download_candidate(url: &Url) -> Result<DownloadedImage, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("无法初始化远程图片客户端：{error}"))?;

    let mut response = client
        .get(url.clone())
        .header(header::ACCEPT, "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
        .header(header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("远程图片请求失败：{error}"))?;

    if response.status().is_redirection() {
        return Err("远程图片地址返回重定向，已拒绝继续请求。".into());
    }
    if !response.status().is_success() {
        return Err(format!("远程图片请求失败（HTTP {}）。", response.status().as_u16()));
    }
    if response.content_length().unwrap_or(0) as usize > MAX_IMAGE_DOWNLOAD_BYTES {
        return Err("远程图片超过 50 MB 下载限制。".into());
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
        return Err(format!("远程 URL 返回的不是图片：{mime_type}"));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取远程图片失败：{error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_IMAGE_DOWNLOAD_BYTES {
            return Err("远程图片超过 50 MB 下载限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("远程 URL 返回了空图片。".into());
    }

    Ok(DownloadedImage { bytes, mime_type })
}

fn preview_candidates(url: &Url, prefer_original: bool) -> Vec<Url> {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let has_transform = url.query_pairs().any(|(key, _)| key == "x-oss-process");
    let mut candidates = Vec::new();

    if !prefer_original
        && (host == "nlark.com" || host.ends_with(".nlark.com"))
        && !has_transform
    {
        let mut optimized = url.clone();
        optimized
            .query_pairs_mut()
            .append_pair("x-oss-process", "image/resize,w_640,limit_1/format,webp");
        candidates.push(optimized);
    }
    candidates.push(url.clone());
    candidates
}

fn normalize_remote_url(raw_url: &str) -> Result<Url, String> {
    let normalized = if raw_url.starts_with("//") {
        format!("https:{raw_url}")
    } else {
        raw_url.to_string()
    };
    let parsed = Url::parse(&normalized).map_err(|_| "远程图片地址无效。".to_string())?;
    if parsed.scheme() != "https" {
        return Err("远程图片地址不是 HTTPS。".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "远程图片地址缺少域名。".to_string())?
        .to_ascii_lowercase();
    if !ALLOWED_IMAGE_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err("远程图片域名不在允许列表中。".into());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::{normalize_remote_url, preview_candidates};

    #[test]
    fn creates_optimized_nlark_candidate_for_grid_thumbnail() {
        let url = normalize_remote_url("https://cdn.nlark.com/yuque/test.png").unwrap();
        let candidates = preview_candidates(&url, false);
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0].as_str().contains("x-oss-process"));
        assert_eq!(candidates[1], url);
    }

    #[test]
    fn uses_original_url_only_for_detail_preview() {
        let url = normalize_remote_url("https://cdn.nlark.com/yuque/test.png").unwrap();
        assert_eq!(preview_candidates(&url, true), vec![url]);
    }

    #[test]
    fn rejects_untrusted_hosts() {
        assert!(normalize_remote_url("https://example.com/image.png").is_err());
    }
}
