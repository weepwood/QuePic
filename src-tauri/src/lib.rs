mod accounts;
mod backup;
mod credentials;
mod database;
mod models;
mod openapi_token;
mod preview;
mod remote_preview;
mod yuque;
mod yuque_openapi;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::Utc;
use models::{
    AssetRecord, CacheStats, CredentialStatus, PreviewResult, UploadInput, UploadQuotaStatus,
    UploadResult,
};
use preview::CachedPreview;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const YUQUE_LOGIN_WINDOW: &str = "yuque-login";
const YUQUE_LOGIN_URL: &str = "https://www.yuque.com/login";
const YUQUE_UPLOAD_URL: &str = "https://www.yuque.com/api/upload/attach";
const DEFAULT_CATEGORY: &str = "未分类";
const ALLOWED_MIME_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "image/bmp",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "image/tiff",
    "image/avif",
];

struct AppState {
    database_path: PathBuf,
    preview_cache_dir: PathBuf,
    cache_lock: Arc<Mutex<()>>,
    upload_gate: Arc<tokio::sync::Mutex<()>>,
    preview_limiter: Arc<remote_preview::RequestLimiter>,
}

#[tauri::command]
fn save_cookie(account_name: String, cookie: String) -> Result<CredentialStatus, String> {
    let account_name = normalize_account_name(&account_name)?;
    credentials::save(&account_name, &cookie)?;
    Ok(CredentialStatus { configured: true, account_name })
}

#[tauri::command]
async fn open_yuque_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(YUQUE_LOGIN_WINDOW) {
        window.show().map_err(|error| format!("无法显示语雀登录窗口：{error}"))?;
        window.set_focus().map_err(|error| format!("无法聚焦语雀登录窗口：{error}"))?;
        window
            .navigate(Url::parse(YUQUE_LOGIN_URL).map_err(|error| format!("语雀登录地址无效：{error}"))?)
            .map_err(|error| format!("无法打开语雀登录页：{error}"))?;
        return Ok(());
    }

    let login_url = Url::parse(YUQUE_LOGIN_URL).map_err(|error| format!("语雀登录地址无效：{error}"))?;
    WebviewWindowBuilder::new(&app, YUQUE_LOGIN_WINDOW, WebviewUrl::External(login_url))
        .title("登录语雀 · QuePic")
        .inner_size(1120.0, 760.0)
        .min_inner_size(900.0, 620.0)
        .center()
        .resizable(true)
        .devtools(false)
        .on_navigation(|url| matches!(url.scheme(), "https" | "about"))
        .build()
        .map_err(|error| format!("无法创建语雀登录窗口：{error}"))?;
    Ok(())
}

#[tauri::command]
async fn capture_yuque_login(
    app: AppHandle,
    account_name: String,
) -> Result<CredentialStatus, String> {
    let account_name = normalize_account_name(&account_name)?;
    let window = app
        .get_webview_window(YUQUE_LOGIN_WINDOW)
        .ok_or_else(|| "请先点击“登录语雀”并在登录窗口中完成登录。".to_string())?;
    let cookie_window = window.clone();
    let upload_url = Url::parse(YUQUE_UPLOAD_URL).map_err(|error| format!("语雀上传地址无效：{error}"))?;

    let cookies = tauri::async_runtime::spawn_blocking(move || cookie_window.cookies_for_url(upload_url))
        .await
        .map_err(|error| format!("读取语雀登录会话失败：{error}"))?
        .map_err(|error| format!("无法读取语雀 Cookie：{error}"))?;

    let cookie_header = cookies
        .iter()
        .filter(|cookie| !cookie.name().trim().is_empty())
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect::<Vec<_>>()
        .join("; ");

    if cookie_header.len() < 16 || !cookie_header.contains('=') {
        return Err("尚未检测到有效的语雀登录会话，请在登录窗口完成登录后重试。".into());
    }

    credentials::save(&account_name, &cookie_header)?;
    let _ = window.close();
    Ok(CredentialStatus { configured: true, account_name })
}

#[tauri::command]
fn credential_status(account_name: String) -> Result<CredentialStatus, String> {
    let account_name = normalize_account_name(&account_name)?;
    Ok(CredentialStatus {
        configured: credentials::configured(&account_name)?,
        account_name,
    })
}

#[tauri::command]
fn clear_cookie(account_name: String) -> Result<(), String> {
    let account_name = normalize_account_name(&account_name)?;
    credentials::clear(&account_name)
}

#[tauri::command]
fn list_assets(state: State<'_, AppState>) -> Result<Vec<AssetRecord>, String> {
    database::list_assets(&state.database_path)
}

#[tauri::command]
fn update_asset_category(
    state: State<'_, AppState>,
    id: i64,
    category: String,
) -> Result<AssetRecord, String> {
    let category = normalize_category(&category)?;
    database::update_asset_category(&state.database_path, id, &category)
}

#[tauri::command]
fn cache_stats(state: State<'_, AppState>) -> Result<CacheStats, String> {
    database::cache_stats(&state.database_path)
}

#[tauri::command]
fn upload_quota_status(
    state: State<'_, AppState>,
    account_name: String,
) -> Result<UploadQuotaStatus, String> {
    let account_name = normalize_account_name(&account_name)?;
    database::upload_quota_status(&state.database_path, &account_name)
}

#[tauri::command]
async fn clear_preview_cache(state: State<'_, AppState>) -> Result<CacheStats, String> {
    let database_path = state.database_path.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();
    let cache_lock = state.cache_lock.clone();
    drop(state);

    tauri::async_runtime::spawn_blocking(move || {
        let _guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        preview::clear_cache(&preview_cache_dir)?;
        database::clear_previews(&database_path)?;
        database::cache_stats(&database_path)
    })
    .await
    .map_err(|error| format!("清理图片缓存任务失败：{error}"))?
}

#[tauri::command]
fn delete_asset(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let asset = database::find_by_id(&state.database_path, id)?;
    database::delete_asset(&state.database_path, id)?;

    if let Some(asset) = asset {
        if database::hash_reference_count(&state.database_path, &asset.sha256)? == 0 {
            let _guard = state
                .cache_lock
                .lock()
                .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
            preview::remove_asset_cache(&state.preview_cache_dir, &asset.sha256)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn ensure_preview(
    state: State<'_, AppState>,
    asset_id: i64,
    prefer_original: bool,
    allow_wordpress_fallback: bool,
    force_refresh: bool,
) -> Result<PreviewResult, String> {
    let database_path = state.database_path.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();
    let cache_lock = state.cache_lock.clone();
    let preview_limiter = state.preview_limiter.clone();
    drop(state);

    let asset = database::find_by_id(&database_path, asset_id)?
        .ok_or_else(|| "图片记录不存在。".to_string())?;

    if !force_refresh {
        let existing = {
            let _guard = cache_lock
                .lock()
                .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
            existing_local_path(&asset, prefer_original)
        };
        if let Some(path) = existing {
            return Ok(local_preview_result(asset_id, path, "local"));
        }
    }

    let public_error = match remote_preview::download_thumbnail(preview_limiter, &asset.remote_url).await {
        Ok(downloaded) => {
            let preview = cache_and_record_task(
                cache_lock.clone(),
                preview_cache_dir.clone(),
                database_path.clone(),
                asset_id,
                asset.sha256.clone(),
                downloaded.mime_type,
                downloaded.bytes,
                "remote_url".into(),
            )
            .await?;
            let path = if prefer_original { preview.original_path } else { preview.thumbnail_path };
            return Ok(local_preview_result(asset_id, path, "remote_url"));
        }
        Err(error) => error,
    };

    let session_result = match credentials::load(&asset.account_name) {
        Ok(cookie) => yuque::download_image(&cookie, &asset.remote_url).await,
        Err(error) => Err(error),
    };

    match session_result {
        Ok(downloaded) => {
            let preview = cache_and_record_task(
                cache_lock,
                preview_cache_dir,
                database_path.clone(),
                asset_id,
                asset.sha256,
                downloaded.mime_type,
                downloaded.bytes,
                "yuque_session".into(),
            )
            .await?;
            let path = if prefer_original { preview.original_path } else { preview.thumbnail_path };
            Ok(local_preview_result(asset_id, path, "yuque_session"))
        }
        Err(session_error) => {
            let combined_error = format!("{public_error}；语雀会话回源失败：{session_error}");
            let _ = database::mark_preview_error(&database_path, asset_id, &combined_error);
            if allow_wordpress_fallback {
                let width = if prefer_original { Some(1_024) } else { Some(640) };
                let proxy_url = yuque::wordpress_proxy_url(&asset.remote_url, width)?;
                return Ok(PreviewResult {
                    asset_id,
                    local_path: None,
                    proxy_url: Some(proxy_url),
                    source: "wordpress_proxy".into(),
                    cached: false,
                    last_error: Some(combined_error),
                });
            }
            Err(combined_error)
        }
    }
}

#[tauri::command]
async fn upload_image(
    state: State<'_, AppState>,
    input: UploadInput,
) -> Result<UploadResult, String> {
    validate_upload(&input)?;
    let database_path = state.database_path.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();
    let cache_lock = state.cache_lock.clone();
    let upload_gate = state.upload_gate.clone();
    drop(state);

    let account_name = normalize_account_name(&input.account_name)?;
    let category = normalize_category(&input.category)?;
    let file_name = sanitize_file_name(&input.file_name)?;
    let mut hasher = Sha256::new();
    hasher.update(&input.bytes);
    let sha256 = format!("{:x}", hasher.finalize());
    let cache_bytes = input.bytes.clone();

    if let Some(existing) =
        database::find_by_hash_for_account(&database_path, &account_name, &sha256)?
    {
        let existing = database::update_asset_category(&database_path, existing.id, &category)?;
        let preview_missing = {
            let _guard = cache_lock
                .lock()
                .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
            !preview::preview_exists(existing.original_path.as_deref(), existing.thumbnail_path.as_deref())
        };
        if preview_missing {
            let _ = cache_and_record_task(
                cache_lock,
                preview_cache_dir,
                database_path.clone(),
                existing.id,
                sha256,
                input.mime_type.clone(),
                cache_bytes,
                "local".into(),
            )
            .await;
        }
        let asset = database::find_by_id(&database_path, existing.id)?.unwrap_or(existing);
        return Ok(UploadResult { asset, deduplicated: true });
    }

    let cookie = credentials::load(&account_name)?;
    let upload_guard = upload_gate.lock().await;
    let quota = database::upload_quota_status(&database_path, &account_name)?;
    if quota.remaining <= 0 {
        let reset = quota.reset_at.unwrap_or_else(|| "稍后".into());
        return Err(format!("当前账号过去一小时已达到 {} 次上传尝试，请在 {reset} 后继续。", quota.limit));
    }
    if quota.retry_after_seconds > 0 {
        tokio::time::sleep(Duration::from_secs(quota.retry_after_seconds as u64)).await;
    }

    let attempt_id = database::record_upload_attempt(&database_path, &account_name)?;
    let file_size = input.bytes.len() as i64;
    let remote_url = yuque::upload(&cookie, &file_name, &input.mime_type, input.bytes).await?;
    database::mark_upload_attempt_success(&database_path, attempt_id)?;
    drop(upload_guard);

    let asset = AssetRecord {
        id: 0,
        sha256: sha256.clone(),
        file_name,
        mime_type: input.mime_type.clone(),
        file_size,
        width: input.width.filter(|value| *value > 0),
        height: input.height.filter(|value| *value > 0),
        remote_url,
        account_name,
        uploaded_at: Utc::now().to_rfc3339(),
        category,
        original_path: None,
        thumbnail_path: None,
        preview_source: "missing".into(),
        cache_status: "missing".into(),
        cache_bytes: None,
        cached_at: None,
        last_error: None,
    };

    let (saved_asset, deduplicated) = match database::insert_asset(&database_path, &asset) {
        Ok(saved) => (saved, false),
        Err(error) => {
            if let Some(existing) = database::find_by_hash_for_account(
                &database_path,
                &asset.account_name,
                &asset.sha256,
            )? {
                (
                    database::update_asset_category(&database_path, existing.id, &asset.category)?,
                    true,
                )
            } else {
                return Err(format!("图片已上传，但保存本地索引失败：{error}"));
            }
        }
    };

    if let Err(error) = cache_and_record_task(
        cache_lock,
        preview_cache_dir,
        database_path.clone(),
        saved_asset.id,
        sha256,
        input.mime_type,
        cache_bytes,
        "local".into(),
    )
    .await
    {
        let _ = database::mark_preview_error(&database_path, saved_asset.id, &error);
    }

    let refreshed = database::find_by_id(&database_path, saved_asset.id)?.unwrap_or(saved_asset);
    Ok(UploadResult { asset: refreshed, deduplicated })
}

async fn cache_and_record_task(
    cache_lock: Arc<Mutex<()>>,
    cache_dir: PathBuf,
    database_path: PathBuf,
    asset_id: i64,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
    source: String,
) -> Result<CachedPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        if database::find_by_id(&database_path, asset_id)?.is_none() {
            return Err("图片记录已删除，已取消建立缓存。".into());
        }
        let cached = preview::cache_image(&cache_dir, &sha256, &mime_type, &bytes)?;
        database::upsert_cached_preview(&database_path, asset_id, &cached, &source)
            .map_err(|error| format!("图片缓存已生成，但保存缓存索引失败：{error}"))?;
        Ok(cached)
    })
    .await
    .map_err(|error| format!("建立图片缓存任务失败：{error}"))?
}

fn existing_local_path(asset: &AssetRecord, prefer_original: bool) -> Option<String> {
    let candidates = if prefer_original {
        [asset.original_path.as_deref(), asset.thumbnail_path.as_deref()]
    } else {
        [asset.thumbnail_path.as_deref(), asset.original_path.as_deref()]
    };
    candidates
        .into_iter()
        .flatten()
        .find(|path| Path::new(path).is_file())
        .map(ToOwned::to_owned)
}

fn local_preview_result(asset_id: i64, path: String, source: &str) -> PreviewResult {
    PreviewResult {
        asset_id,
        local_path: Some(path),
        proxy_url: None,
        source: source.into(),
        cached: true,
        last_error: None,
    }
}

fn validate_upload(input: &UploadInput) -> Result<(), String> {
    if input.bytes.is_empty() {
        return Err("图片内容为空。".into());
    }
    if input.bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 50 MB 限制。".into());
    }
    if !ALLOWED_MIME_TYPES.contains(&input.mime_type.as_str()) {
        return Err(format!("不支持的图片格式：{}", input.mime_type));
    }
    Ok(())
}

fn normalize_account_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("账号名称不能为空。".into());
    }
    if value.len() > 80 {
        return Err("账号名称过长。".into());
    }
    Ok(value.to_string())
}

fn normalize_category(value: &str) -> Result<String, String> {
    let value = value.trim();
    let value = if value.is_empty() { DEFAULT_CATEGORY } else { value };
    if value.chars().count() > 80 {
        return Err("图片分类不能超过 80 个字符。".into());
    }
    if value.chars().any(char::is_control) {
        return Err("图片分类包含无效控制字符。".into());
    }
    Ok(value.to_string())
}

fn sanitize_file_name(value: &str) -> Result<String, String> {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .take(180)
        .collect();
    if sanitized.is_empty() {
        return Err("图片文件名无效。".into());
    }
    Ok(sanitized)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let database_path = app_data_dir.join("quepic.db");
            database::initialize(&database_path).map_err(std::io::Error::other)?;
            accounts::initialize(&database_path).map_err(std::io::Error::other)?;

            let preview_cache_dir = app.path().app_cache_dir()?.join("previews");
            fs::create_dir_all(&preview_cache_dir)?;
            app.manage(AppState {
                database_path,
                preview_cache_dir,
                cache_lock: Arc::new(Mutex::new(())),
                upload_gate: Arc::new(tokio::sync::Mutex::new(())),
                preview_limiter: Arc::new(remote_preview::RequestLimiter::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_cookie,
            open_yuque_login,
            capture_yuque_login,
            credential_status,
            clear_cookie,
            openapi_token::save_openapi_token,
            openapi_token::openapi_token_status,
            openapi_token::clear_openapi_token,
            accounts::list_account_profiles,
            accounts::save_account_profile,
            backup::export_backup,
            backup::import_backup,
            list_assets,
            update_asset_category,
            cache_stats,
            upload_quota_status,
            clear_preview_cache,
            delete_asset,
            ensure_preview,
            upload_image,
            yuque_openapi::create_yuque_document,
        ])
        .run(tauri::generate_context!())
        .expect("QuePic 启动失败");
}
