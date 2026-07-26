use reqwest::{header, multipart};
use serde::Deserialize;
use url::Url;

const UPLOAD_ENDPOINT: &str = "https://www.yuque.com/api/upload/attach";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct YuqueEnvelope {
    data: Option<YuqueUploadData>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YuqueUploadData {
    url: Option<String>,
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

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|error| format!("无法初始化网络客户端：{error}"))?;

    let response = client
        .post(UPLOAD_ENDPOINT)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, "https://www.yuque.com/")
        .header(header::ORIGIN, "https://www.yuque.com")
        .header(header::ACCEPT, "application/json, text/plain, */*")
        .header(header::USER_AGENT, "QuePic/0.1")
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("连接语雀图片接口失败：{error}"))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("语雀 Cookie 已失效或权限不足，请重新获取。".into());
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

fn normalize_remote_url(raw_url: &str) -> Result<String, String> {
    let normalized = if raw_url.starts_with("//") {
        format!("https:{raw_url}")
    } else {
        raw_url.to_string()
    };
    let parsed = Url::parse(&normalized).map_err(|_| "语雀返回了无效的图片地址。".to_string())?;
    if parsed.scheme() != "https" {
        return Err("语雀返回的图片地址不是 HTTPS。".into());
    }
    Ok(parsed.to_string())
}
