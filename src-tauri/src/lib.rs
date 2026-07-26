mod credentials;
mod database;
mod models;
mod yuque;

use std::{fs, path::PathBuf};

use chrono::Utc;
use models::{AssetRecord, CredentialStatus, UploadInput, UploadResult};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
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
            credential_status,
            clear_cookie,
            list_assets,
            delete_asset,
            upload_image,
        ])
        .run(tauri::generate_context!())
        .expect("QuePic 启动失败");
}
