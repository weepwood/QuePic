use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::{credentials, database, yuque_attachment, AppState};

const DEFAULT_FOLDER: &str = "未分类";
const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "pdf", "doc", "docx", "docm", "dot", "dotx", "dotm", "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "ppt", "pptx", "pptm", "pot", "potx", "potm", "pps", "ppsx", "ppsm", "txt", "md", "csv", "tsv", "rtf",
    "odt", "ods", "odp", "wps", "wpt", "et", "ett", "dps", "dpt", "pages", "numbers", "key", "json", "xml", "yaml", "yml", "log", "ics", "msg", "epub", "mobi", "jpg",
    "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "svg", "ico", "psd", "ai", "sketch", "fig",
    "xmind", "mmap", "mindnode", "rp", "rplib", "eps", "dwg", "dxf", "zip", "rar", "7z", "tar", "gz", "tgz", "bz2",
    "xz", "mp3", "m4a", "wav", "flac", "ogg", "mp4", "mov", "m4v", "webm", "avi", "mkv",
];

#[derive(Debug, Clone, Serialize)]
pub struct DriveFileRecord {
    pub id: i64,
    pub sha256: String,
    pub file_name: String,
    pub extension: String,
    pub mime_type: String,
    pub file_size: i64,
    pub remote_url: String,
    pub account_name: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub local_path: Option<String>,
    pub uploaded_at: String,
}

#[derive(Debug, Serialize)]
pub struct DriveLocalFile {
    pub local_path: String,
    pub file_name: String,
    pub extension: String,
    pub mime_type: String,
    pub file_size: i64,
    pub supported: bool,
    pub validation_message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DriveUploadInput {
    pub local_path: String,
    pub account_name: String,
    pub folder: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub attachable_id: Option<i64>,
    #[serde(default)]
    pub referer_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DriveUploadResult {
    pub file: DriveFileRecord,
    pub deduplicated: bool,
}

#[derive(Debug, Serialize)]
pub struct DriveSaveResult {
    pub cancelled: bool,
    pub path: Option<String>,
}

pub fn initialize(path: &Path) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS drive_folders (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS drive_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sha256 TEXT NOT NULL,
                file_name TEXT NOT NULL,
                extension TEXT NOT NULL DEFAULT '',
                mime_type TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                remote_url TEXT NOT NULL,
                account_name TEXT NOT NULL,
                folder TEXT NOT NULL DEFAULT '未分类',
                local_path TEXT,
                uploaded_at TEXT NOT NULL,
                UNIQUE(account_name, sha256)
            );

            CREATE TABLE IF NOT EXISTS drive_file_tags (
                file_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY(file_id, tag),
                FOREIGN KEY(file_id) REFERENCES drive_files(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_drive_files_uploaded_at
            ON drive_files(uploaded_at DESC, id DESC);

            CREATE INDEX IF NOT EXISTS idx_drive_files_folder
            ON drive_files(folder);

            CREATE INDEX IF NOT EXISTS idx_drive_files_name
            ON drive_files(file_name);

            CREATE INDEX IF NOT EXISTS idx_drive_file_tags_tag
            ON drive_file_tags(tag);
            "#,
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT OR IGNORE INTO drive_folders (name, created_at) VALUES (?1, ?2)",
            params![DEFAULT_FOLDER, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pick_drive_files(app: AppHandle) -> Result<Vec<DriveLocalFile>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("选择要上传到语雀云盘的附件")
        .blocking_pick_files()
        .unwrap_or_default();

    selected
        .into_iter()
        .map(|file_path| {
            let path = file_path
                .into_path()
                .map_err(|error| format!("无法读取所选文件路径：{error}"))?;
            describe_local_file(&path)
        })
        .collect()
}

#[tauri::command]
pub fn list_drive_files(state: State<'_, AppState>) -> Result<Vec<DriveFileRecord>, String> {
    let _database_guard = state.try_database_read()?;
    list_files(&state.database_path)
}

#[tauri::command]
pub fn list_drive_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let _database_guard = state.try_database_read()?;
    list_folders(&state.database_path)
}

#[tauri::command]
pub fn create_drive_folder(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let _database_guard = state.try_database_read()?;
    let name = normalize_folder(&name)?;
    let connection = open_connection(&state.database_path)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO drive_folders (name, created_at) VALUES (?1, ?2)",
            params![&name, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    Ok(name)
}

#[tauri::command]
pub fn list_drive_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let _database_guard = state.try_database_read()?;
    let connection = open_connection(&state.database_path)?;
    let mut statement = connection
        .prepare("SELECT DISTINCT tag FROM drive_file_tags ORDER BY tag COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn update_drive_file_folder(
    state: State<'_, AppState>,
    id: i64,
    folder: String,
) -> Result<DriveFileRecord, String> {
    let _database_guard = state.try_database_read()?;
    update_folder(&state.database_path, id, &folder)
}

#[tauri::command]
pub fn update_drive_file_tags(
    state: State<'_, AppState>,
    id: i64,
    tags: Vec<String>,
) -> Result<DriveFileRecord, String> {
    let _database_guard = state.try_database_read()?;
    update_tags(&state.database_path, id, &tags)
}

#[tauri::command]
pub fn delete_drive_file(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let _database_guard = state.try_database_read()?;
    let connection = open_connection(&state.database_path)?;
    let changed = connection
        .execute("DELETE FROM drive_files WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("云盘文件记录不存在。".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn upload_drive_file(
    state: State<'_, AppState>,
    input: DriveUploadInput,
) -> Result<DriveUploadResult, String> {
    let database_path = state.database_path.clone();
    let database_gate = state.database_gate.clone();
    let upload_gate = state.upload_gate.clone();
    drop(state);

    let _database_guard = database_gate.read_owned().await;
    let account_name = normalize_account_name(&input.account_name)?;
    let folder = normalize_folder(&input.folder)?;
    let tags = normalize_tags(&input.tags)?;
    validate_context(input.attachable_id, input.referer_url.as_deref())?;

    let local_path = PathBuf::from(input.local_path.trim());
    let descriptor = describe_local_file(&local_path)?;
    if !descriptor.supported {
        return Err(descriptor
            .validation_message
            .unwrap_or_else(|| "语雀网页当前不支持该附件格式。".into()));
    }
    let sha256 = hash_file(local_path.clone()).await?;
    if let Some(existing) = find_by_hash(&database_path, &account_name, &sha256)? {
        let existing = update_file_metadata(
            &database_path,
            existing.id,
            &folder,
            &tags,
            Some(&descriptor.local_path),
        )?;
        return Ok(DriveUploadResult {
            file: existing,
            deduplicated: true,
        });
    }

    let cookie = credentials::load(&account_name)?;
    let upload_guard = upload_gate.lock().await;
    if let Some(existing) = find_by_hash(&database_path, &account_name, &sha256)? {
        drop(upload_guard);
        let existing = update_file_metadata(
            &database_path,
            existing.id,
            &folder,
            &tags,
            Some(&descriptor.local_path),
        )?;
        return Ok(DriveUploadResult {
            file: existing,
            deduplicated: true,
        });
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
    let remote_url = yuque_attachment::upload(
        &cookie,
        &local_path,
        &descriptor.file_name,
        &descriptor.mime_type,
        input.attachable_id,
        input.referer_url.as_deref(),
    )
    .await?;
    database::mark_upload_attempt_success(&database_path, attempt_id)?;

    let record = DriveFileRecord {
        id: 0,
        sha256,
        file_name: descriptor.file_name,
        extension: descriptor.extension,
        mime_type: descriptor.mime_type,
        file_size: descriptor.file_size,
        remote_url,
        account_name,
        folder,
        tags,
        local_path: Some(descriptor.local_path),
        uploaded_at: Utc::now().to_rfc3339(),
    };
    let saved = insert_file(&database_path, &record)?;
    drop(upload_guard);
    Ok(DriveUploadResult {
        file: saved,
        deduplicated: false,
    })
}

#[tauri::command]
pub async fn save_drive_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<DriveSaveResult, String> {
    let _database_guard = state.try_database_read()?;
    let record =
        find_by_id(&state.database_path, id)?.ok_or_else(|| "云盘文件记录不存在。".to_string())?;
    drop(state);

    let mut dialog = app
        .dialog()
        .file()
        .set_title("下载语雀云盘原始文件")
        .set_file_name(&record.file_name);
    if !record.extension.is_empty() {
        dialog = dialog.add_filter("原始附件", &[record.extension.as_str()]);
    }
    let Some(selected) = dialog.blocking_save_file() else {
        return Ok(DriveSaveResult {
            cancelled: true,
            path: None,
        });
    };
    let mut target = selected
        .into_path()
        .map_err(|error| format!("无法读取附件保存路径：{error}"))?;
    if target.extension().is_none() && !record.extension.is_empty() {
        target.set_extension(&record.extension);
    }

    let cookie = credentials::load(&record.account_name)?;
    let temporary = temporary_download_path(&target);
    let _ = tokio::fs::remove_file(&temporary).await;
    if let Err(error) = yuque_attachment::download_to(&cookie, &record.remote_url, &temporary).await
    {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    if target.is_file() {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|error| format!("覆盖已有文件失败：{error}"))?;
    }
    tokio::fs::rename(&temporary, &target)
        .await
        .map_err(|error| format!("完成附件保存失败：{error}"))?;

    Ok(DriveSaveResult {
        cancelled: false,
        path: Some(target.to_string_lossy().into_owned()),
    })
}

fn describe_local_file(path: &Path) -> Result<DriveLocalFile, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("读取文件信息失败：{error}"))?;
    if !metadata.is_file() {
        return Err("只能上传普通文件，不能上传目录或特殊设备。".into());
    }
    let file_size = i64::try_from(metadata.len()).map_err(|_| "文件大小超出支持范围。")?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "附件文件名不是有效 UTF-8 文本。".to_string())?;
    let file_name = sanitize_file_name(file_name)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let supported_extension = SUPPORTED_EXTENSIONS.contains(&extension.as_str());
    let supported_size = metadata.len() > 0 && metadata.len() <= MAX_FILE_BYTES;
    let validation_message = if metadata.len() == 0 {
        Some("语雀网页不接受空附件。".into())
    } else if metadata.len() > MAX_FILE_BYTES {
        Some("文件超过 QuePic 当前 1 GB 上传保护上限。".into())
    } else if !supported_extension {
        Some(format!(
            "扩展名 .{} 不在当前语雀网页附件格式清单中；可先压缩为 ZIP。",
            if extension.is_empty() {
                "(无扩展名)"
            } else {
                &extension
            }
        ))
    } else {
        None
    };
    Ok(DriveLocalFile {
        local_path: path.to_string_lossy().into_owned(),
        file_name,
        extension: extension.clone(),
        mime_type: mime_type_for_extension(&extension).into(),
        file_size,
        supported: supported_extension && supported_size,
        validation_message,
    })
}

async fn hash_file(path: PathBuf) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = File::open(&path).map_err(|error| format!("打开附件失败：{error}"))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|error| format!("读取附件失败：{error}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })
    .await
    .map_err(|error| format!("计算附件摘要任务失败：{error}"))?
}

fn insert_file(path: &Path, record: &DriveFileRecord) -> Result<DriveFileRecord, String> {
    let mut connection = open_connection(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            r#"
            INSERT INTO drive_files (
                sha256, file_name, extension, mime_type, file_size, remote_url,
                account_name, folder, local_path, uploaded_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
            params![
                &record.sha256,
                &record.file_name,
                &record.extension,
                &record.mime_type,
                record.file_size,
                &record.remote_url,
                &record.account_name,
                &record.folder,
                &record.local_path,
                &record.uploaded_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    let id = transaction.last_insert_rowid();
    transaction
        .execute(
            "INSERT OR IGNORE INTO drive_folders (name, created_at) VALUES (?1, ?2)",
            params![&record.folder, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    for tag in &record.tags {
        transaction
            .execute(
                "INSERT OR IGNORE INTO drive_file_tags (file_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    find_by_id(path, id)?.ok_or_else(|| "保存云盘文件索引后无法重新读取记录。".into())
}

fn list_files(path: &Path) -> Result<Vec<DriveFileRecord>, String> {
    let connection = open_connection(path)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, sha256, file_name, extension, mime_type, file_size, remote_url,
                   account_name, folder, local_path, uploaded_at
            FROM drive_files
            ORDER BY uploaded_at DESC, id DESC
            "#,
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], map_file)
        .map_err(|error| error.to_string())?;
    let mut files = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for file in &mut files {
        file.tags = load_tags(&connection, file.id)?;
    }
    Ok(files)
}

fn find_by_id(path: &Path, id: i64) -> Result<Option<DriveFileRecord>, String> {
    let connection = open_connection(path)?;
    let mut file = connection
        .query_row(
            r#"
            SELECT id, sha256, file_name, extension, mime_type, file_size, remote_url,
                   account_name, folder, local_path, uploaded_at
            FROM drive_files WHERE id = ?1
            "#,
            [id],
            map_file,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(file) = file.as_mut() {
        file.tags = load_tags(&connection, file.id)?;
    }
    Ok(file)
}

fn find_by_hash(
    path: &Path,
    account_name: &str,
    sha256: &str,
) -> Result<Option<DriveFileRecord>, String> {
    let connection = open_connection(path)?;
    let mut file = connection
        .query_row(
            r#"
            SELECT id, sha256, file_name, extension, mime_type, file_size, remote_url,
                   account_name, folder, local_path, uploaded_at
            FROM drive_files WHERE account_name = ?1 AND sha256 = ?2
            "#,
            params![account_name, sha256],
            map_file,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(file) = file.as_mut() {
        file.tags = load_tags(&connection, file.id)?;
    }
    Ok(file)
}

fn update_file_metadata(
    path: &Path,
    id: i64,
    folder: &str,
    tags: &[String],
    local_path: Option<&str>,
) -> Result<DriveFileRecord, String> {
    let mut connection = open_connection(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE drive_files SET folder = ?2, local_path = COALESCE(?3, local_path) WHERE id = ?1",
            params![id, folder, local_path],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO drive_folders (name, created_at) VALUES (?1, ?2)",
            params![folder, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM drive_file_tags WHERE file_id = ?1", [id])
        .map_err(|error| error.to_string())?;
    for tag in tags {
        transaction
            .execute(
                "INSERT OR IGNORE INTO drive_file_tags (file_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    find_by_id(path, id)?.ok_or_else(|| "云盘文件记录不存在。".into())
}

fn update_folder(path: &Path, id: i64, folder: &str) -> Result<DriveFileRecord, String> {
    let existing = find_by_id(path, id)?.ok_or_else(|| "云盘文件记录不存在。".to_string())?;
    let folder = normalize_folder(folder)?;
    update_file_metadata(path, id, &folder, &existing.tags, None)
}

fn update_tags(path: &Path, id: i64, tags: &[String]) -> Result<DriveFileRecord, String> {
    let existing = find_by_id(path, id)?.ok_or_else(|| "云盘文件记录不存在。".to_string())?;
    let tags = normalize_tags(tags)?;
    update_file_metadata(path, id, &existing.folder, &tags, None)
}

fn list_folders(path: &Path) -> Result<Vec<String>, String> {
    let connection = open_connection(path)?;
    let mut statement = connection
        .prepare(
            "SELECT name FROM drive_folders ORDER BY CASE WHEN name = '未分类' THEN 0 ELSE 1 END, name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn load_tags(connection: &Connection, id: i64) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT tag FROM drive_file_tags WHERE file_id = ?1 ORDER BY tag COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn map_file(row: &rusqlite::Row<'_>) -> rusqlite::Result<DriveFileRecord> {
    Ok(DriveFileRecord {
        id: row.get(0)?,
        sha256: row.get(1)?,
        file_name: row.get(2)?,
        extension: row.get(3)?,
        mime_type: row.get(4)?,
        file_size: row.get(5)?,
        remote_url: row.get(6)?,
        account_name: row.get(7)?,
        folder: row.get(8)?,
        tags: Vec::new(),
        local_path: row.get(9)?,
        uploaded_at: row.get(10)?,
    })
}

fn open_connection(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn normalize_account_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("上传账号不能为空。".into());
    }
    if value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err("上传账号名称无效。".into());
    }
    Ok(value.to_string())
}

fn normalize_folder(value: &str) -> Result<String, String> {
    let value = value.trim();
    let value = if value.is_empty() {
        DEFAULT_FOLDER
    } else {
        value
    };
    if value.chars().count() > 100 || value.chars().any(char::is_control) {
        return Err("云盘文件夹名称无效。".into());
    }
    Ok(value.to_string())
}

fn normalize_tags(values: &[String]) -> Result<Vec<String>, String> {
    let mut tags = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || tags.iter().any(|tag| tag == value) {
            continue;
        }
        if value.chars().count() > 50 || value.chars().any(char::is_control) {
            return Err("云盘标签不能超过 50 个字符，也不能包含控制字符。".into());
        }
        tags.push(value.to_string());
        if tags.len() > 30 {
            return Err("单个云盘文件最多设置 30 个标签。".into());
        }
    }
    Ok(tags)
}

fn validate_context(attachable_id: Option<i64>, referer_url: Option<&str>) -> Result<(), String> {
    match (attachable_id, referer_url) {
        (Some(id), Some(url)) if id > 0 && url.starts_with("https://www.yuque.com/") => Ok(()),
        (None, None) => Ok(()),
        (Some(_), Some(_)) => Err("语雀附件上传上下文无效。".into()),
        _ => Err("附件上传上下文必须同时包含文档 ID 和文档 URL。".into()),
    }
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
        .take(220)
        .collect();
    if sanitized.is_empty() {
        return Err("附件文件名无效。".into());
    }
    Ok(sanitized)
}

fn temporary_download_path(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("quepic-download")
        .to_string();
    name.push_str(".quepic-part");
    target.with_file_name(name)
}

fn mime_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" | "dotx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docm" | "dotm" => "application/vnd.ms-word.document.macroenabled.12",
        "dot" => "application/msword",
        "xls" | "xlt" => "application/vnd.ms-excel",
        "xlsx" | "xltx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsm" | "xltm" => "application/vnd.ms-excel.sheet.macroenabled.12",
        "xlsb" => "application/vnd.ms-excel.sheet.binary.macroenabled.12",
        "ppt" | "pot" | "pps" => "application/vnd.ms-powerpoint",
        "pptx" | "potx" | "ppsx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pptm" | "potm" | "ppsm" => "application/vnd.ms-powerpoint.presentation.macroenabled.12",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "zip" => "application/zip",
        "rar" => "application/vnd.rar",
        "7z" => "application/x-7z-compressed",
        "tar" => "application/x-tar",
        "gz" | "tgz" => "application/gzip",
        "bz2" => "application/x-bzip2",
        "xz" => "application/x-xz",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::{mime_type_for_extension, normalize_folder, normalize_tags, SUPPORTED_EXTENSIONS};

    #[test]
    fn exposes_common_yuque_attachment_formats() {
        for extension in ["pdf", "docx", "xlsx", "pptx", "wps", "zip", "mp4", "xmind"] {
            assert!(SUPPORTED_EXTENSIONS.contains(&extension));
        }
        assert_eq!(mime_type_for_extension("pdf"), "application/pdf");
    }

    #[test]
    fn normalizes_drive_taxonomy() {
        assert_eq!(normalize_folder(" ").unwrap(), "未分类");
        assert_eq!(
            normalize_tags(&["资料".into(), "资料".into()]).unwrap(),
            vec!["资料"]
        );
    }
}
