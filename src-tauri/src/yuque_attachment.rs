use std::path::Path;

use reqwest::{header, multipart, redirect::Policy, Client};
use serde_json::Value;
use tokio::{fs::File, io::AsyncWriteExt};
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
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const ALLOWED_ATTACHMENT_HOST_SUFFIXES: &[&str] = &["yuque.com", "nlark.com"];

pub async fn upload(
    cookie: &str,
    local_path: &Path,
    file_name: &str,
    mime_type: &str,
    attachable_id: Option<i64>,
    referer_url: Option<&str>,
) -> Result<String, String> {
    let upload_url = build_upload_url(cookie, attachable_id)?;
    let referer = resolve_upload_referer(attachable_id, referer_url)?;
    let part = multipart::Part::file(local_path)
        .await
        .map_err(|error| format!("读取待上传附件失败：{error}"))?
        .file_name(file_name.to_string())
        .mime_str(mime_type)
        .map_err(|_| "附件 MIME 类型无效。".to_string())?;
    let form = multipart::Form::new().part("file", part);

    let client = secure_client(std::time::Duration::from_secs(600))?;
    let response = client
        .post(upload_url)
        .header(header::COOKIE, cookie)
        .header(header::REFERER, referer)
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
        .map_err(|error| format!("连接语雀附件接口失败：{error}"))?;

    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(if attachable_id.is_some() {
            "语雀 Cookie、ctoken 已失效或文档权限不足，请重新登录。".into()
        } else {
            "语雀 Cookie 或 ctoken 已失效，请重新登录。".into()
        });
    }
    if status.is_redirection() {
        return Err("语雀附件接口返回了重定向。为避免 Cookie 泄露，QuePic 已拒绝继续请求。".into());
    }
    if response.content_length().unwrap_or(0) as usize > MAX_RESPONSE_BYTES {
        return Err("语雀附件接口响应体异常过大。".into());
    }

    let response_text = response
        .text()
        .await
        .map_err(|error| format!("读取语雀附件响应失败：{error}"))?;
    if response_text.len() > MAX_RESPONSE_BYTES {
        return Err("语雀附件接口响应体异常过大。".into());
    }

    let payload: Value = serde_json::from_str(&response_text).map_err(|_| {
        if response_text.contains("登录") || response_text.to_ascii_lowercase().contains("login")
        {
            "语雀返回了登录页面，Cookie 可能已经失效。".to_string()
        } else {
            "语雀附件接口返回格式已经变化，请更新 QuePic。".to_string()
        }
    })?;
    if !status.is_success() {
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| payload.get("msg").and_then(Value::as_str));
        return Err(message
            .map(|value| format!("语雀拒绝上传附件：{value}"))
            .unwrap_or_else(|| format!("语雀拒绝上传附件（HTTP {status}）。")));
    }

    let raw_url = find_attachment_url(&payload)
        .ok_or_else(|| "语雀附件接口未返回可下载地址。".to_string())?;
    normalize_remote_url(raw_url)
}

pub async fn download_to(cookie: &str, remote_url: &str, target: &Path) -> Result<(), String> {
    let client = secure_client(std::time::Duration::from_secs(600))?;
    let mut current_url = normalize_remote_url(remote_url)?;

    for _ in 0..4 {
        let parsed = Url::parse(&current_url).map_err(|_| "语雀附件下载地址无效。".to_string())?;
        let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
        let mut request = client
            .get(parsed.clone())
            .header(header::REFERER, YUQUE_ORIGIN_REFERER)
            .header(header::ACCEPT, "*/*")
            .header(header::ACCEPT_LANGUAGE, BROWSER_ACCEPT_LANGUAGE)
            .header(header::USER_AGENT, BROWSER_USER_AGENT);
        if host == "yuque.com" || host.ends_with(".yuque.com") {
            request = request.header(header::COOKIE, cookie);
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("连接语雀附件下载地址失败：{error}"))?;

        let status = response.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("语雀附件拒绝访问，请重新登录来源账号后重试。".into());
        }
        if status.is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "语雀附件下载重定向缺少 Location。".to_string())?;
            let next = parsed
                .join(location)
                .map_err(|_| "语雀附件下载重定向地址无效。".to_string())?;
            current_url = normalize_remote_url(next.as_str())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("语雀附件下载失败（HTTP {status}）。"));
        }
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .unwrap_or_default()
            .trim();
        if content_type.eq_ignore_ascii_case("text/html") {
            return Err(
                "语雀返回了网页而不是原始附件，下载地址可能已失效或来源账号需要重新登录。".into(),
            );
        }
        if response.content_length().unwrap_or(0) > MAX_DOWNLOAD_BYTES {
            return Err("远程附件超过 QuePic 当前 1 GB 下载保护上限。".into());
        }

        let mut file = File::create(target)
            .await
            .map_err(|error| format!("创建附件保存文件失败：{error}"))?;
        let mut written = 0_u64;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("读取语雀附件数据失败：{error}"))?
        {
            written = written.saturating_add(chunk.len() as u64);
            if written > MAX_DOWNLOAD_BYTES {
                let _ = tokio::fs::remove_file(target).await;
                return Err("远程附件超过 QuePic 当前 1 GB 下载保护上限。".into());
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("写入附件文件失败：{error}"))?;
        }
        file.flush()
            .await
            .map_err(|error| format!("刷新附件文件失败：{error}"))?;
        if written == 0 {
            let _ = tokio::fs::remove_file(target).await;
            return Err("语雀返回了空附件。".into());
        }
        return Ok(());
    }

    Err("语雀附件下载重定向次数过多。".into())
}

fn build_upload_url(cookie: &str, attachable_id: Option<i64>) -> Result<Url, String> {
    let ctoken = cookie_value(cookie, "yuque_ctoken")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "语雀 Cookie 中缺少 yuque_ctoken，请重新登录后再上传。".to_string())?;
    let mut url =
        Url::parse(UPLOAD_ENDPOINT).map_err(|error| format!("语雀附件上传地址无效：{error}"))?;
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
            .append_pair("type", "file")
            .append_pair("ctoken", &ctoken);
    }
    Ok(url)
}

fn resolve_upload_referer(
    attachable_id: Option<i64>,
    referer_url: Option<&str>,
) -> Result<String, String> {
    match (attachable_id, referer_url) {
        (Some(_), Some(value)) => normalize_document_url(value),
        (Some(_), None) => Err("文档关联附件上传缺少 Referer。".into()),
        (None, Some(_)) => Err("无文档附件上传不应携带 Referer。".into()),
        (None, None) => Ok(YUQUE_ORIGIN_REFERER.to_string()),
    }
}

fn normalize_document_url(raw_url: &str) -> Result<String, String> {
    let parsed = Url::parse(raw_url.trim()).map_err(|_| "语雀文档 URL 无效。".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("www.yuque.com") {
        return Err("上传上下文必须是 https://www.yuque.com/ 下的文档地址。".into());
    }
    Ok(parsed.to_string())
}

fn find_attachment_url(payload: &Value) -> Option<&str> {
    const CANDIDATE_KEYS: &[&str] = &[
        "download_url",
        "downloadUrl",
        "original_url",
        "originalUrl",
        "source_url",
        "sourceUrl",
        "file_url",
        "fileUrl",
        "raw_url",
        "rawUrl",
        "url",
    ];
    for key in CANDIDATE_KEYS {
        if let Some(value) = payload
            .get("data")
            .and_then(|data| data.get(*key))
            .and_then(Value::as_str)
        {
            return Some(value);
        }
    }
    for key in CANDIDATE_KEYS {
        if let Some(value) = payload.get(*key).and_then(Value::as_str) {
            return Some(value);
        }
    }
    payload
        .get("data")
        .and_then(|data| data.get("attachment"))
        .and_then(|attachment| {
            CANDIDATE_KEYS
                .iter()
                .find_map(|key| attachment.get(*key).and_then(Value::as_str))
        })
}

fn cookie_value(cookie: &str, name: &str) -> Option<String> {
    cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| key.trim() == name)
        .map(|(_, value)| value.trim().to_string())
}

fn normalize_remote_url(raw_url: &str) -> Result<String, String> {
    let normalized = if raw_url.starts_with("//") {
        format!("https:{raw_url}")
    } else if raw_url.starts_with('/') {
        format!("https://www.yuque.com{raw_url}")
    } else {
        raw_url.to_string()
    };
    let parsed = Url::parse(&normalized).map_err(|_| "语雀附件地址无效。".to_string())?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("语雀附件地址必须是无凭据的 HTTPS URL。".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "语雀附件地址缺少域名。".to_string())?
        .to_ascii_lowercase();
    if !ALLOWED_ATTACHMENT_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    {
        return Err(format!("拒绝访问非语雀附件域名：{host}"));
    }
    Ok(parsed.to_string())
}

fn secure_client(timeout: std::time::Duration) -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| format!("创建语雀附件网络客户端失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::{find_attachment_url, normalize_remote_url};
    use serde_json::json;

    #[test]
    fn reads_common_attachment_url_shapes() {
        assert_eq!(
            find_attachment_url(&json!({"data": {"url": "https://cdn.nlark.com/a.pdf"}})),
            Some("https://cdn.nlark.com/a.pdf")
        );
        assert_eq!(
            find_attachment_url(&json!({
                "data": {
                    "url": "https://cdn.nlark.com/preview.pdf",
                    "download_url": "https://www.yuque.com/api/v2/attachments/original.pdf"
                }
            })),
            Some("https://www.yuque.com/api/v2/attachments/original.pdf")
        );
        assert_eq!(
            find_attachment_url(
                &json!({"data": {"attachment": {"download_url": "/api/attachments/a"}}})
            ),
            Some("/api/attachments/a")
        );
    }

    #[test]
    fn restricts_remote_attachment_hosts() {
        assert!(normalize_remote_url("https://cdn.nlark.com/a.pdf").is_ok());
        assert!(normalize_remote_url("/api/attachments/a").is_ok());
        assert!(normalize_remote_url("https://example.com/a.pdf").is_err());
    }
}
