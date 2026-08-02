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
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use chrono::Utc;
use models::{
    AssetRecord, CacheStats, CredentialStatus, PreviewResult, UploadInput, UploadQuotaStatus,
    UploadResult,
};
use preview::CachedPreview;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use url::Url;

const NO_TOKEN_MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const TOKEN_MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
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
    database_gate: Arc<tokio::sync::RwLock<()>>,
    preview_limiter: Arc<remote_preview::RequestLimiter>,
}

impl AppState {
    pub(crate) fn try_database_read(
        &self,
    ) -> Result<tokio::sync::OwnedRwLockReadGuard<()>, String> {
        self.database_gate
            .clone()
            .try_read_owned()
            .map_err(|_| "QuePic 正在导入或导出备份，数据库暂时不可用，请稍后重试。".to_string())
    }
}

#[tauri::command]
fn save_cookie(account_name: String, cookie: String) -> Result<CredentialStatus, String> {
    let account_name = normalize_account_name(&account_name)?;
    credentials::save(&account_name, &cookie)?;
    Ok(CredentialStatus {
        configured: true,
        account_name,
    })
}

#[tauri::command]
async fn open_yuque_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(YUQUE_LOGIN_WINDOW) {
        window
            .show()
            .map_err(|error| format!("无法显示语雀登录窗口：{error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("无法聚焦语雀登录窗口：{error}"))?;
        window
            .navigate(
                Url::parse(YUQUE_LOGIN_URL)
                    .map_err(|error| format!("语雀登录地址无效：{error}"))?,
            )
            .map_err(|error| format!("无法打开语雀登录页：{error}"))?;
        return Ok(());
    }

    let login_url =
        Url::parse(YUQUE_LOGIN_URL).map_err(|error| format!("语雀登录地址无效：{error}"))?;
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
    let upload_url =
        Url::parse(YUQUE_UPLOAD_URL).map_err(|error| format!("语雀上传地址无效：{error}"))?;

    let cookies =
        tauri::async_runtime::spawn_blocking(move || cookie_window.cookies_for_url(upload_url))
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
    Ok(CredentialStatus {
        configured: true,
        account_name,
    })
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
fn reveal_cookie(account_name: String) -> Result<String, String> {
    let account_name = normalize_account_name(&account_name)?;
    credentials::load(&account_name)
}

#[tauri::command]
fn clear_cookie(account_name: String) -> Result<(), String> {
    let account_name = normalize_account_name(&account_name)?;
    credentials::clear(&account_name)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "外部链接无效。".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("仅允许使用系统浏览器打开 HTTP 或 HTTPS 链接。".into());
    }
    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("无法调用系统浏览器：{error}"))
}

#[tauri::command]
fn list_assets(state: State<'_, AppState>) -> Result<Vec<AssetRecord>, String> {
    let _database_guard = state.try_database_read()?;
    database::list_assets(&state.database_path)
}

#[tauri::command]
fn update_asset_category(
    state: State<'_, AppState>,
    id: i64,
    category: String,
) -> Result<AssetRecord, String> {
    let _database_guard = state.try_database_read()?;
    let category = normalize_category(&category)?;
    database::update_asset_category(&state.database_path, id, &category)
}

#[tauri::command]
fn list_library_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let _database_guard = state.try_database_read()?;
    database::list_library_folders(&state.database_path)
}

#[tauri::command]
fn create_library_folder(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let _database_guard = state.try_database_read()?;
    database::create_library_folder(&state.database_path, &name)
}

#[tauri::command]
fn list_asset_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let _database_guard = state.try_database_read()?;
    database::list_asset_tags(&state.database_path)
}

#[tauri::command]
fn update_asset_tags(
    state: State<'_, AppState>,
    id: i64,
    tags: Vec<String>,
) -> Result<AssetRecord, String> {
    let _database_guard = state.try_database_read()?;
    database::update_asset_tags(&state.database_path, id, &tags)
}

#[tauri::command]
fn cache_stats(state: State<'_, AppState>) -> Result<CacheStats, String> {
    let _database_guard = state.try_database_read()?;
    shared_cache_stats(&state.database_path)
}

#[tauri::command]
fn upload_quota_status(
    state: State<'_, AppState>,
    account_name: String,
) -> Result<UploadQuotaStatus, String> {
    let _database_guard = state.try_database_read()?;
    let account_name = normalize_account_name(&account_name)?;
    database::upload_quota_status(&state.database_path, &account_name)
}

#[tauri::command]
async fn clear_preview_cache(state: State<'_, AppState>) -> Result<CacheStats, String> {
    let database_path = state.database_path.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();
    let cache_lock = state.cache_lock.clone();
    let database_gate = state.database_gate.clone();
    drop(state);

    let _database_guard = database_gate.read_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        preview::clear_cache(&preview_cache_dir)?;
        database::clear_previews(&database_path)?;
        shared_cache_stats(&database_path)
    })
    .await
    .map_err(|error| format!("清理图片缓存任务失败：{error}"))?
}

#[tauri::command]
fn delete_asset(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let _database_guard = state.try_database_read()?;
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
    let database_gate = state.database_gate.clone();
    drop(state);

    let _database_guard = database_gate.read_owned().await;
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

    let public_error =
        match remote_preview::download_preview(preview_limiter, &asset.remote_url, prefer_original)
            .await
        {
            Ok(downloaded) => {
                let cached = cache_preview_variant_task(
                    cache_lock.clone(),
                    preview_cache_dir.clone(),
                    database_path.clone(),
                    asset_id,
                    asset.sha256.clone(),
                    downloaded.mime_type,
                    downloaded.bytes,
                    "remote_url".into(),
                    prefer_original,
                )
                .await?;
                let path = cached_path(&cached, prefer_original)?;
                return Ok(local_preview_result(asset_id, path, "remote_url"));
            }
            Err(error) => error,
        };

    let session_url = if prefer_original {
        remote_preview::original_image_url(&asset.remote_url)?
    } else {
        asset.remote_url.clone()
    };
    let session_result = match credentials::load(&asset.account_name) {
        Ok(cookie) => yuque::download_image(&cookie, &session_url).await,
        Err(error) => Err(error),
    };

    match session_result {
        Ok(downloaded) => {
            let cached = cache_preview_variant_task(
                cache_lock,
                preview_cache_dir,
                database_path.clone(),
                asset_id,
                asset.sha256,
                downloaded.mime_type,
                downloaded.bytes,
                "yuque_session".into(),
                prefer_original,
            )
            .await?;
            let path = cached_path(&cached, prefer_original)?;
            Ok(local_preview_result(asset_id, path, "yuque_session"))
        }
        Err(session_error) => {
            let combined_error = format!("{public_error}；语雀会话回源失败：{session_error}");
            let _ = database::mark_preview_error(&database_path, asset_id, &combined_error);
            if allow_wordpress_fallback && !prefer_original {
                let proxy_url = yuque::wordpress_proxy_url(&asset.remote_url, Some(640))?;
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

#[derive(Debug, Serialize)]
struct SaveOriginalResult {
    cancelled: bool,
    path: Option<String>,
}

#[tauri::command]
async fn save_original_image(
    app: AppHandle,
    state: State<'_, AppState>,
    asset_id: i64,
) -> Result<SaveOriginalResult, String> {
    let _database_guard = state.try_database_read()?;
    let asset = database::find_by_id(&state.database_path, asset_id)?
        .ok_or_else(|| "图片记录不存在。".to_string())?;
    let preview_limiter = state.preview_limiter.clone();
    drop(state);

    let file_name = sanitize_file_name(&asset.file_name)?;
    let extension = Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_string);
    let dialog = app
        .dialog()
        .file()
        .set_title("保存 QuePic 原图")
        .set_file_name(&file_name);
    let selected = if let Some(extension) = extension.as_deref() {
        dialog.add_filter("图片", &[extension]).blocking_save_file()
    } else {
        dialog.blocking_save_file()
    };
    let Some(selected) = selected else {
        return Ok(SaveOriginalResult {
            cancelled: true,
            path: None,
        });
    };
    let mut target = selected
        .into_path()
        .map_err(|error| format!("无法读取原图保存路径：{error}"))?;
    if target.extension().is_none() {
        if let Some(extension) = extension {
            target.set_extension(extension);
        }
    }

    let downloaded_bytes =
        match remote_preview::download_preview(preview_limiter, &asset.remote_url, true).await {
            Ok(image) => image.bytes,
            Err(public_error) => {
                let cookie = credentials::load(&asset.account_name)?;
                let original_url = remote_preview::original_image_url(&asset.remote_url)?;
                yuque::download_image(&cookie, &original_url)
                    .await
                    .map_err(|session_error| {
                        format!("原图下载失败：{public_error}；语雀会话回源失败：{session_error}")
                    })?
                    .bytes
            }
        };
    let saved_path = target.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs::write(&target, downloaded_bytes).map_err(|error| format!("保存原图失败：{error}"))
    })
    .await
    .map_err(|error| format!("保存原图任务失败：{error}"))??;

    Ok(SaveOriginalResult {
        cancelled: false,
        path: Some(saved_path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
async fn upload_image(
    state: State<'_, AppState>,
    input: UploadInput,
) -> Result<UploadResult, String> {
    let account_name = normalize_account_name(&input.account_name)?;
    let token_configured = openapi_token::configured(&account_name)?;
    validate_upload(&input, token_configured)?;
    let database_path = state.database_path.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();
    let cache_lock = state.cache_lock.clone();
    let upload_gate = state.upload_gate.clone();
    let database_gate = state.database_gate.clone();
    drop(state);

    let _database_guard = database_gate.read_owned().await;
    let category = normalize_category(&input.category)?;
    let file_name = sanitize_file_name(&input.file_name)?;
    let mut hasher = Sha256::new();
    hasher.update(&input.bytes);
    let sha256 = format!("{:x}", hasher.finalize());
    let cache_bytes = input.bytes.clone();

    if let Some(existing) =
        database::find_by_hash_for_account(&database_path, &account_name, &sha256)?
    {
        return reuse_existing_asset(
            cache_lock,
            preview_cache_dir,
            database_path,
            existing,
            category,
            input.tags.clone(),
            sha256,
            input.mime_type,
            cache_bytes,
        )
        .await;
    }

    let cookie = credentials::load(&account_name)?;
    let upload_guard = upload_gate.lock().await;

    if let Some(existing) =
        database::find_by_hash_for_account(&database_path, &account_name, &sha256)?
    {
        drop(upload_guard);
        return reuse_existing_asset(
            cache_lock,
            preview_cache_dir,
            database_path,
            existing,
            category,
            input.tags.clone(),
            sha256,
            input.mime_type,
            cache_bytes,
        )
        .await;
    }

    let quota = database::upload_quota_status(&database_path, &account_name)?;
    if quota.remaining <= 0 {
        let reset = quota.reset_at.unwrap_or_else(|| "稍后".into());
        return Err(format!(
            "当前账号本整点小时已达到 {} 次上传尝试；额度会在 {reset} 整点重置。",
            quota.limit
        ));
    }
    let attempt_id = database::record_upload_attempt(&database_path, &account_name)?;
    let file_size = input.bytes.len() as i64;
    let remote_url = yuque::upload(
        &cookie,
        &file_name,
        &input.mime_type,
        input.bytes,
        input.attachable_id,
        &input.referer_url,
    )
    .await?;
    database::mark_upload_attempt_success(&database_path, attempt_id)?;

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
        tags: input.tags.clone(),
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
    drop(upload_guard);

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
    Ok(UploadResult {
        asset: refreshed,
        deduplicated,
    })
}

async fn reuse_existing_asset(
    cache_lock: Arc<Mutex<()>>,
    preview_cache_dir: PathBuf,
    database_path: PathBuf,
    existing: AssetRecord,
    category: String,
    tags: Vec<String>,
    sha256: String,
    mime_type: String,
    cache_bytes: Vec<u8>,
) -> Result<UploadResult, String> {
    let existing = database::update_asset_category(&database_path, existing.id, &category)?;
    let existing = if tags.is_empty() {
        existing
    } else {
        database::update_asset_tags(&database_path, existing.id, &tags)?
    };
    let original_missing = {
        let _guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        !preview::original_exists(existing.original_path.as_deref())
    };

    if original_missing {
        let _ = cache_and_record_task(
            cache_lock,
            preview_cache_dir,
            database_path.clone(),
            existing.id,
            sha256,
            mime_type,
            cache_bytes,
            "local".into(),
        )
        .await;
    }

    let asset = database::find_by_id(&database_path, existing.id)?.unwrap_or(existing);
    Ok(UploadResult {
        asset,
        deduplicated: true,
    })
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
    cache_preview_task(
        cache_lock,
        cache_dir,
        database_path,
        asset_id,
        sha256,
        mime_type,
        bytes,
        source,
        true,
    )
    .await
}

async fn cache_thumbnail_and_record_task(
    cache_lock: Arc<Mutex<()>>,
    cache_dir: PathBuf,
    database_path: PathBuf,
    asset_id: i64,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
    source: String,
) -> Result<CachedPreview, String> {
    cache_preview_task(
        cache_lock,
        cache_dir,
        database_path,
        asset_id,
        sha256,
        mime_type,
        bytes,
        source,
        false,
    )
    .await
}

async fn cache_preview_variant_task(
    cache_lock: Arc<Mutex<()>>,
    cache_dir: PathBuf,
    database_path: PathBuf,
    asset_id: i64,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
    source: String,
    original: bool,
) -> Result<CachedPreview, String> {
    if original {
        cache_and_record_task(
            cache_lock,
            cache_dir,
            database_path,
            asset_id,
            sha256,
            mime_type,
            bytes,
            source,
        )
        .await
    } else {
        cache_thumbnail_and_record_task(
            cache_lock,
            cache_dir,
            database_path,
            asset_id,
            sha256,
            mime_type,
            bytes,
            source,
        )
        .await
    }
}

async fn cache_preview_task(
    cache_lock: Arc<Mutex<()>>,
    cache_dir: PathBuf,
    database_path: PathBuf,
    asset_id: i64,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
    source: String,
    original: bool,
) -> Result<CachedPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        if database::find_by_id(&database_path, asset_id)?.is_none() {
            return Err("图片记录已删除，已取消建立缓存。".into());
        }
        let cached = if original {
            preview::cache_image(&cache_dir, &sha256, &mime_type, &bytes)?
        } else {
            preview::cache_thumbnail(&cache_dir, &sha256, &mime_type, &bytes)?
        };
        database::upsert_cached_preview(&database_path, asset_id, &cached, &source)
            .map_err(|error| format!("图片缓存已生成，但保存缓存索引失败：{error}"))?;
        Ok(cached)
    })
    .await
    .map_err(|error| format!("建立图片缓存任务失败：{error}"))?
}

fn cached_path(preview: &CachedPreview, prefer_original: bool) -> Result<String, String> {
    let path = if prefer_original {
        preview.original_path.as_ref()
    } else {
        preview.thumbnail_path.as_ref()
    };
    path.cloned().ok_or_else(|| {
        if prefer_original {
            "原图缓存没有生成有效文件。".to_string()
        } else {
            "图片预览缓存没有生成有效文件。".to_string()
        }
    })
}

fn shared_cache_stats(path: &Path) -> Result<CacheStats, String> {
    let assets = database::list_assets(path)?;
    let mut asset_count = 0_i64;
    let mut cached_count = 0_i64;
    let mut cache_bytes = 0_i64;
    let mut counted_hashes = HashSet::new();

    for asset in assets {
        asset_count += 1;
        if asset.cache_status == "ready" {
            cached_count += 1;
            if counted_hashes.insert(asset.sha256) {
                cache_bytes = cache_bytes.saturating_add(asset.cache_bytes.unwrap_or(0));
            }
        }
    }

    Ok(CacheStats {
        asset_count,
        cached_count,
        cache_bytes,
    })
}

fn existing_local_path(asset: &AssetRecord, prefer_original: bool) -> Option<String> {
    if prefer_original {
        return asset
            .original_path
            .as_deref()
            .filter(|path| preview::original_exists(Some(path)))
            .map(ToOwned::to_owned);
    }

    [
        asset.thumbnail_path.as_deref(),
        asset.original_path.as_deref(),
    ]
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

fn maximum_upload_bytes(token_configured: bool) -> usize {
    if token_configured {
        TOKEN_MAX_IMAGE_BYTES
    } else {
        NO_TOKEN_MAX_IMAGE_BYTES
    }
}

fn validate_upload(input: &UploadInput, token_configured: bool) -> Result<(), String> {
    if input.bytes.is_empty() {
        return Err("图片内容为空。".into());
    }
    let maximum_bytes = maximum_upload_bytes(token_configured);
    if input.bytes.len() > maximum_bytes {
        let limit_mb = maximum_bytes / 1024 / 1024;
        let guidance = if token_configured {
            "当前账号已配置 Token。"
        } else {
            "保存 OpenAPI Token 后可提升到 50 MB。"
        };
        return Err(format!("图片超过当前 {limit_mb} MB 上传限制。{guidance}"));
    }
    if !ALLOWED_MIME_TYPES.contains(&input.mime_type.as_str()) {
        return Err(format!("不支持的图片格式：{}", input.mime_type));
    }
    if input.attachable_id <= 0 {
        return Err("尚未配置有效的账号上传上下文文档。".into());
    }
    yuque::normalize_document_url(&input.referer_url)?;
    Ok(())
}

fn normalize_account_name(value: &str) -> Result<String, String> {
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
    Ok(value.to_string())
}

fn normalize_category(value: &str) -> Result<String, String> {
    let value = value.trim();
    let value = if value.is_empty() {
        DEFAULT_CATEGORY
    } else {
        value
    };
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

#[cfg(test)]
mod tests {
    use super::{maximum_upload_bytes, NO_TOKEN_MAX_IMAGE_BYTES, TOKEN_MAX_IMAGE_BYTES};

    #[test]
    fn applies_token_tier_upload_limits() {
        assert_eq!(maximum_upload_bytes(false), NO_TOKEN_MAX_IMAGE_BYTES);
        assert_eq!(maximum_upload_bytes(true), TOKEN_MAX_IMAGE_BYTES);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
                database_gate: Arc::new(tokio::sync::RwLock::new(())),
                preview_limiter: Arc::new(remote_preview::RequestLimiter::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_cookie,
            open_external_url,
            open_yuque_login,
            capture_yuque_login,
            credential_status,
            reveal_cookie,
            clear_cookie,
            openapi_token::save_openapi_token,
            openapi_token::openapi_token_status,
            openapi_token::reveal_openapi_token,
            openapi_token::clear_openapi_token,
            accounts::list_account_profiles,
            accounts::save_account_profile,
            backup::export_backup,
            backup::import_backup,
            list_assets,
            update_asset_category,
            list_library_folders,
            create_library_folder,
            list_asset_tags,
            update_asset_tags,
            cache_stats,
            upload_quota_status,
            clear_preview_cache,
            delete_asset,
            ensure_preview,
            save_original_image,
            upload_image,
            yuque_openapi::create_yuque_document,
            yuque_openapi::resolve_upload_context,
            yuque_openapi::list_yuque_repositories,
            yuque_openapi::ensure_quepic_repository,
            yuque_openapi::list_yuque_documents,
            yuque_openapi::delete_yuque_document,
        ])
        .run(tauri::generate_context!())
        .expect("QuePic 启动失败");
}
