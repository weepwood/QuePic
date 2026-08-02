use std::time::Duration;

use reqwest::{header::ACCEPT, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::openapi_token;

const YUQUE_API_BASE: &str = "https://www.yuque.com/api/v2";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct CreateYuqueDocumentInput {
    pub account_name: String,
    pub book_id: i64,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Serialize)]
pub struct YuqueDocumentResult {
    pub id: i64,
    pub title: String,
    pub slug: String,
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YuqueResponse {
    data: YuqueDocument,
}

#[derive(Debug, Deserialize)]
struct YuqueDocument {
    id: i64,
    title: String,
    slug: String,
    book: Option<YuqueBook>,
}

#[derive(Debug, Deserialize)]
struct YuqueBook {
    namespace: Option<String>,
}

#[tauri::command]
pub async fn create_yuque_document(
    input: CreateYuqueDocumentInput,
) -> Result<YuqueDocumentResult, String> {
    let account_name = validate_account_name(&input.account_name)?;
    let token = openapi_token::load(account_name)?;
    if input.book_id <= 0 {
        return Err("知识库 ID 必须是正整数。".into());
    }

    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("文档标题不能为空。".into());
    }
    if title.chars().count() > 200 {
        return Err("文档标题不能超过 200 个字符。".into());
    }
    if input.body.trim().is_empty() {
        return Err("文档正文不能为空。".into());
    }

    let endpoint = format!("{YUQUE_API_BASE}/repos/{}/docs", input.book_id);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("无法初始化语雀 OpenAPI 客户端：{error}"))?;

    let response = client
        .post(endpoint)
        .header("X-Auth-Token", &token)
        .header(ACCEPT, "application/json")
        .json(&json!({
            "title": title,
            "format": "markdown",
            "body": input.body,
        }))
        .send()
        .await
        .map_err(|error| format!("创建语雀文档请求失败：{error}"))?;

    if response.status().is_redirection() {
        return Err("语雀 OpenAPI 返回重定向，QuePic 已拒绝继续请求。".into());
    }
    if response.content_length().unwrap_or(0) as usize > MAX_RESPONSE_BYTES {
        return Err("语雀 OpenAPI 响应体异常过大。".into());
    }

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|error| format!("读取语雀 OpenAPI 响应失败：{error}"))?;
    if response_text.len() > MAX_RESPONSE_BYTES {
        return Err("语雀 OpenAPI 响应体异常过大。".into());
    }

    if !status.is_success() {
        let message = extract_error_message(&response_text)
            .unwrap_or_else(|| response_text.trim().to_string())
            .trim()
            .to_string();
        let message = if message.is_empty() {
            "语雀未返回错误详情。".to_string()
        } else {
            message
        };
        return Err(format!("创建语雀文档失败（HTTP {}）：{message}", status.as_u16()));
    }

    let payload: YuqueResponse = serde_json::from_str(&response_text)
        .map_err(|error| format!("解析语雀文档响应失败：{error}"))?;
    let document = payload.data;
    let url = build_document_url(document.book.as_ref(), &document.slug);

    Ok(YuqueDocumentResult {
        id: document.id,
        title: document.title,
        slug: document.slug,
        url,
    })
}

fn validate_account_name(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("账号名称不能为空。".into());
    }
    if value.chars().count() > 80 {
        return Err("账号名称不能超过 80 个字符。".into());
    }
    if value.chars().any(char::is_control) {
        return Err("账号名称包含无效控制字符。".into());
    }
    Ok(value)
}

fn build_document_url(book: Option<&YuqueBook>, slug: &str) -> Option<String> {
    let namespace = book?.namespace.as_deref()?.trim().trim_matches('/');
    let slug = slug.trim().trim_matches('/');
    if namespace.is_empty() || slug.is_empty() {
        return None;
    }
    Some(format!("https://www.yuque.com/{namespace}/{slug}"))
}

fn extract_error_message(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message = [
        value.get("message"),
        value.get("error"),
        value.get("data").and_then(|data| data.get("message")),
    ]
    .into_iter()
    .flatten()
    .find_map(|candidate| candidate.as_str().map(ToOwned::to_owned));
    message
}

#[cfg(test)]
mod tests {
    use super::{build_document_url, extract_error_message, validate_account_name, YuqueBook};

    #[test]
    fn builds_document_url_from_namespace() {
        let book = YuqueBook { namespace: Some("team/book".into()) };
        assert_eq!(
            build_document_url(Some(&book), "folder-images"),
            Some("https://www.yuque.com/team/book/folder-images".into())
        );
    }

    #[test]
    fn extracts_nested_error_message() {
        assert_eq!(
            extract_error_message(r#"{"data":{"message":"token 无效"}}"#),
            Some("token 无效".into())
        );
    }

    #[test]
    fn accepts_multibyte_account_names_by_character_count() {
        assert!(validate_account_name(&"账号".repeat(40)).is_ok());
        assert!(validate_account_name(&"账号".repeat(41)).is_err());
        assert!(validate_account_name("账号\n名称").is_err());
    }
}
