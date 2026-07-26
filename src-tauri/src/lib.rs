mod credentials;
mod database;
mod models;
mod yuque;

use std::{fs, path::PathBuf};

use chrono::Utc;
use models::{AssetRecord, CredentialStatus, UploadInput, UploadResult};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use url::Url;

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const YUQUE_LOGIN_WINDOW: &str = "yuque-login";
const YUQUE_LOGIN_URL: &str = "https://www.yuque.com/login";
const YUQUE_UPLOAD_URL: &str = "https://www.yuque.com/api/upload/attach";
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

    // Tauri 在 Windows WebView2 上同步读取 Cookie 可能死锁，因此放入独立阻塞线程。
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
fn clear_cookie(account_name: String) -> Result<(), String> {
    let account_name = normalize_account_name(&account_name)?;
    credentials::clear(&account_name)
}

#[tauri::command]
fn list_assets(state: State<'_, AppState>) -> Result<Vec<AssetRecord>, String> {
    database::list_assets(&state.database_path)
}

#[tauri::command]
fn delete_asset(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    database::delete_asset(&state.database_path, id)
}

#[tauri::command]
async fn upload_image(
    state: State<'_, AppState>,
    input: UploadInput,
) -> Result<UploadResult, String> {
    validate_upload(&input)?;
    let database_path = state.database_path.clone();
    drop(state);

    let account_name = normalize_account_name(&input.account_name)?;
    let file_name = sanitize_file_name(&input.file_name)?;
    let mut hasher = Sha256::new();
    hasher.update(&input.bytes);
    let sha256 = format!("{:x}", hasher.finalize());

    if let Some(asset) = database::find_by_hash(&database_path, &sha256)? {
        return Ok(UploadResult {
            asset,
            deduplicated: true,
        });
    }

    let cookie = credentials::load(&account_name)?;
    let file_size = input.bytes.len() as i64;
    let remote_url = yuque::upload(
        &cookie,
        &file_name,
        &input.mime_type,
        input.bytes,
    )
    .await?;

    let asset = AssetRecord {
        id: 0,
        sha256,
        file_name,
        mime_type: input.mime_type,
        file_size,
        width: input.width.filter(|value| *value > 0),
        height: input.height.filter(|value| *value > 0),
        remote_url,
        account_name,
        uploaded_at: Utc::now().to_rfc3339(),
    };

    let saved_asset = match database::insert_asset(&database_path, &asset) {
        Ok(saved) => saved,
        Err(error) => {
            if let Some(existing) = database::find_by_hash(&database_path, &asset.sha256)? {
                existing
            } else {
                return Err(format!("图片已上传，但保存本地索引失败：{error}"));
            }
        }
    };

    Ok(UploadResult {
        asset: saved_asset,
        deduplicated: false,
    })
}

fn validate_upload(input: &UploadInput) -> Result<(), String> {
    if input.bytes.is_empty() {
        return Err("图片内容为空。".into());
    }
    if input.bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 25 MB 限制。".into());
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
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let database_path = app_data_dir.join("quepic.db");
            database::initialize(&database_path).map_err(std::io::Error::other)?;
            app.manage(AppState { database_path });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_cookie,
            open_yuque_login,
            capture_yuque_login,
            credential_status,
            clear_cookie,
            list_assets,
            delete_asset,
            upload_image,
        ])
        .run(tauri::generate_context!())
        .expect("QuePic 启动失败");
}
