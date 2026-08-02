use std::time::Duration;

use reqwest::{header::ACCEPT, redirect::Policy, Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::openapi_token;

const YUQUE_API_BASE: &str = "https://www.yuque.com/api/v2";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct SaveYuqueDocumentInput {
    pub account_name: String,
    pub knowledge_base_url: String,
    pub document_url: Option<String>,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct ResolveUploadContextInput {
    pub account_name: String,
    pub document_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UploadContextResult {
    pub account_name: String,
    pub attachable_id: i64,
    pub document_url: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct YuqueDocumentResult {
    pub id: i64,
    pub title: String,
    pub slug: String,
    pub url: Option<String>,
    pub created: bool,
    pub namespace: String,
}

#[derive(Debug, Deserialize)]
struct YuqueRepoResponse {
    data: YuqueRepo,
}

#[derive(Debug, Deserialize)]
struct YuqueRepo {
    id: i64,
    namespace: Option<String>,
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
    format: Option<String>,
    body: Option<String>,
    body_draft: Option<String>,
    book: Option<YuqueBook>,
}

#[derive(Debug, Deserialize)]
struct YuqueBook {
    namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct YuqueLocation {
    namespace: String,
    document_slug: Option<String>,
}

#[tauri::command]
pub async fn resolve_upload_context(
    input: ResolveUploadContextInput,
) -> Result<UploadContextResult, String> {
    let account_name = validate_account_name(&input.account_name)?.to_string();
    let token = openapi_token::load(&account_name)?;
    let location = parse_yuque_url(&input.document_url, true)?;
    let slug = location
        .document_slug
        .as_deref()
        .ok_or_else(|| "上传上下文 URL 缺少文档标识。".to_string())?;
    let client = secure_client()?;
    let repo = fetch_repo(&client, &token, &location.namespace).await?;
    let namespace = repo
        .namespace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&location.namespace)
        .to_string();
    let document = fetch_document(&client, &token, &namespace, slug).await?;
    if document.id <= 0 {
        return Err("语雀返回的上传上下文文档 ID 无效。".into());
    }
    let document_url = build_document_url(&namespace, &document.slug)
        .ok_or_else(|| "无法生成上传上下文文档 URL。".to_string())?;
    Ok(UploadContextResult {
        account_name,
        attachable_id: document.id,
        document_url,
        title: document.title,
    })
}

#[tauri::command]
pub async fn create_yuque_document(
    input: SaveYuqueDocumentInput,
) -> Result<YuqueDocumentResult, String> {
    let account_name = validate_account_name(&input.account_name)?;
    let token = openapi_token::load(account_name)?;
    let knowledge_base = parse_yuque_url(&input.knowledge_base_url, false)?;
    let title = validate_title(&input.title)?;
    let body = input.body.trim();
    if body.is_empty() {
        return Err("文档正文不能为空。".into());
    }

    let document_location = input
        .document_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_yuque_url(value, true))
        .transpose()?;
    if document_location
        .as_ref()
        .is_some_and(|location| location.namespace != knowledge_base.namespace)
    {
        return Err("目标文档与目标知识库不属于同一个语雀知识库。".into());
    }

    let client = secure_client()?;
    let repo = fetch_repo(&client, &token, &knowledge_base.namespace).await?;
    let namespace = repo
        .namespace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&knowledge_base.namespace)
        .to_string();

    if let Some(location) = document_location {
        let slug = location
            .document_slug
            .as_deref()
            .ok_or_else(|| "目标文档 URL 缺少文档标识。".to_string())?;
        let existing = fetch_document(&client, &token, &namespace, slug).await?;
        if existing
            .format
            .as_deref()
            .is_some_and(|format| !format.eq_ignore_ascii_case("markdown"))
        {
            return Err("目标文档不是 Markdown 格式。为避免破坏 Lake 文档，请新建 Markdown 文档后重试。".into());
        }
        let existing_body = existing.body.as_deref().or(existing.body_draft.as_deref());
        let merged_body = append_markdown(existing_body, body);
        let updated = update_document(
            &client,
            &token,
            repo.id,
            existing.id,
            &existing.title,
            &merged_body,
        )
        .await?;
        return Ok(document_result(updated, &namespace, false));
    }

    let created = create_document(&client, &token, repo.id, title, body).await?;
    Ok(document_result(created, &namespace, true))
}

async fn fetch_repo(client: &Client, token: &str, namespace: &str) -> Result<YuqueRepo, String> {
    let endpoint = format!("{YUQUE_API_BASE}/repos/{namespace}");
    let text = request_text(
        client
            .get(endpoint)
            .header("X-Auth-Token", token)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| format!("读取语雀知识库失败：{error}"))?,
        "读取语雀知识库",
    )
    .await?;
    serde_json::from_str::<YuqueRepoResponse>(&text)
        .map(|payload| payload.data)
        .map_err(|error| format!("解析语雀知识库响应失败：{error}"))
}

async fn fetch_document(
    client: &Client,
    token: &str,
    namespace: &str,
    slug: &str,
) -> Result<YuqueDocument, String> {
    let endpoint = format!("{YUQUE_API_BASE}/repos/{namespace}/docs/{slug}?raw=1");
    let text = request_text(
        client
            .get(endpoint)
            .header("X-Auth-Token", token)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| format!("读取目标语雀文档失败：{error}"))?,
        "读取目标语雀文档",
    )
    .await?;
    parse_document(&text, "解析目标语雀文档")
}

async fn create_document(
    client: &Client,
    token: &str,
    book_id: i64,
    title: &str,
    body: &str,
) -> Result<YuqueDocument, String> {
    let endpoint = format!("{YUQUE_API_BASE}/repos/{book_id}/docs");
    let text = request_text(
        client
            .post(endpoint)
            .header("X-Auth-Token", token)
            .header(ACCEPT, "application/json")
            .json(&json!({ "title": title, "format": "markdown", "body": body }))
            .send()
            .await
            .map_err(|error| format!("创建语雀文档请求失败：{error}"))?,
        "创建语雀文档",
    )
    .await?;
    parse_document(&text, "解析语雀文档响应")
}

async fn update_document(
    client: &Client,
    token: &str,
    book_id: i64,
    document_id: i64,
    title: &str,
    body: &str,
) -> Result<YuqueDocument, String> {
    let endpoint = format!("{YUQUE_API_BASE}/repos/{book_id}/docs/{document_id}");
    let text = request_text(
        client
            .put(endpoint)
            .header("X-Auth-Token", token)
            .header(ACCEPT, "application/json")
            .json(&json!({ "title": title, "format": "markdown", "body": body }))
            .send()
            .await
            .map_err(|error| format!("更新语雀文档请求失败：{error}"))?,
        "更新语雀文档",
    )
    .await?;
    parse_document(&text, "解析语雀文档响应")
}

fn parse_document(text: &str, action: &str) -> Result<YuqueDocument, String> {
    serde_json::from_str::<YuqueResponse>(text)
        .map(|payload| payload.data)
        .map_err(|error| format!("{action}失败：{error}"))
}

async fn request_text(response: Response, action: &str) -> Result<String, String> {
    if response.status().is_redirection() {
        return Err(format!("{action}时语雀返回重定向，QuePic 已拒绝继续请求。"));
    }
    if response.content_length().unwrap_or(0) as usize > MAX_RESPONSE_BYTES {
        return Err(format!("{action}时语雀响应体异常过大。"));
    }

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("{action}响应读取失败：{error}"))?;
    if text.len() > MAX_RESPONSE_BYTES {
        return Err(format!("{action}时语雀响应体异常过大。"));
    }
    if status.is_success() {
        return Ok(text);
    }

    let message = extract_error_message(&text)
        .unwrap_or_else(|| text.trim().to_string())
        .trim()
        .to_string();
    let message = if message.is_empty() {
        "语雀未返回错误详情。".to_string()
    } else {
        message
    };
    Err(format!("{action}失败（HTTP {}）：{message}", status.as_u16()))
}

fn secure_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("无法初始化语雀 OpenAPI 客户端：{error}"))
}

fn parse_yuque_url(raw_url: &str, require_document: bool) -> Result<YuqueLocation, String> {
    let raw_url = raw_url.trim();
    if raw_url.is_empty() {
        return Err(if require_document {
            "目标文档 URL 不能为空。".into()
        } else {
            "目标知识库 URL 不能为空。".into()
        });
    }

    let parsed = Url::parse(raw_url).map_err(|_| "请输入完整的语雀网页 URL。".to_string())?;
    if parsed.scheme() != "https" {
        return Err("语雀 URL 必须使用 HTTPS。".into());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "www.yuque.com" && host != "yuque.com" {
        return Err("只支持 yuque.com 的知识库或文档 URL。".into());
    }

    let segments = parsed
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() < 2 {
        return Err("语雀 URL 中缺少知识库路径，例如 /weepwood/index。".into());
    }
    if require_document && segments.len() < 3 {
        return Err("目标文档 URL 中缺少文档标识。".into());
    }
    if segments.iter().take(3).any(|segment| !is_safe_path_segment(segment)) {
        return Err("语雀 URL 包含不支持的路径字符。".into());
    }

    Ok(YuqueLocation {
        namespace: format!("{}/{}", segments[0], segments[1]),
        document_slug: segments.get(2).map(|value| (*value).to_string()),
    })
}

fn is_safe_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
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

fn validate_title(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("文档标题不能为空。".into());
    }
    if value.chars().count() > 200 {
        return Err("文档标题不能超过 200 个字符。".into());
    }
    Ok(value)
}

fn append_markdown(existing: Option<&str>, addition: &str) -> String {
    let existing = existing.unwrap_or_default().trim();
    if existing.is_empty() {
        addition.trim().to_string()
    } else {
        format!("{existing}\n\n{}", addition.trim())
    }
}

fn document_result(document: YuqueDocument, namespace: &str, created: bool) -> YuqueDocumentResult {
    let resolved_namespace = document
        .book
        .as_ref()
        .and_then(|book| book.namespace.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(namespace)
        .to_string();
    let url = build_document_url(&resolved_namespace, &document.slug);
    YuqueDocumentResult {
        id: document.id,
        title: document.title,
        slug: document.slug,
        url,
        created,
        namespace: resolved_namespace,
    }
}

fn build_document_url(namespace: &str, slug: &str) -> Option<String> {
    let namespace = namespace.trim().trim_matches('/');
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
    use super::{
        append_markdown, build_document_url, extract_error_message, parse_yuque_url,
        validate_account_name,
    };

    #[test]
    fn parses_knowledge_base_from_document_url() {
        let location = parse_yuque_url(
            "https://www.yuque.com/weepwood/index/dvezaglsvggap7g5",
            false,
        )
        .unwrap();
        assert_eq!(location.namespace, "weepwood/index");
        assert_eq!(location.document_slug.as_deref(), Some("dvezaglsvggap7g5"));
    }

    #[test]
    fn requires_slug_for_document_target() {
        assert!(parse_yuque_url("https://www.yuque.com/weepwood/index", true).is_err());
        assert!(parse_yuque_url(
            "https://www.yuque.com/weepwood/index/dvezaglsvggap7g5",
            true
        )
        .is_ok());
    }

    #[test]
    fn rejects_non_yuque_or_insecure_urls() {
        assert!(parse_yuque_url("http://www.yuque.com/weepwood/index", false).is_err());
        assert!(parse_yuque_url("https://example.com/weepwood/index", false).is_err());
    }

    #[test]
    fn appends_without_destroying_existing_markdown() {
        assert_eq!(append_markdown(Some("原有正文"), "![图片](url)"), "原有正文\n\n![图片](url)");
        assert_eq!(append_markdown(None, "![图片](url)"), "![图片](url)");
    }

    #[test]
    fn builds_document_url_from_namespace() {
        assert_eq!(
            build_document_url("team/book", "folder-images"),
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
