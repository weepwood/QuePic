use std::{path::Path, time::Duration};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use url::Url;

use crate::AppState;

const DEFAULT_ACCOUNT: &str = "default";
const DEFAULT_CATEGORY: &str = "未分类";
const MAX_SETTING_TEXT_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSettings {
    pub initialized: bool,
    pub active_account: String,
    pub primary_account: String,
    pub account_failover_enabled: bool,
    pub knowledge_base_url: String,
    pub document_url: String,
    pub upload_category: String,
    pub upload_tags: String,
    pub library_view: String,
    pub allow_wordpress_fallback: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            initialized: false,
            active_account: DEFAULT_ACCOUNT.into(),
            primary_account: DEFAULT_ACCOUNT.into(),
            account_failover_enabled: true,
            knowledge_base_url: String::new(),
            document_url: String::new(),
            upload_category: DEFAULT_CATEGORY.into(),
            upload_tags: String::new(),
            library_view: "original".into(),
            allow_wordpress_fallback: false,
        }
    }
}

pub fn initialize(path: &Path) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS app_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let _database_guard = state.try_database_read()?;
    load(&state.database_path)
}

#[tauri::command]
pub fn save_app_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let _database_guard = state.try_database_read()?;
    save(&state.database_path, settings)
}

pub fn load(path: &Path) -> Result<AppSettings, String> {
    let connection = open_connection(path)?;
    let value_json = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some(value_json) = value_json else {
        return Ok(AppSettings::default());
    };
    let mut settings: AppSettings = serde_json::from_str(&value_json)
        .map_err(|error| format!("无法解析应用设置：{error}"))?;
    settings.initialized = true;
    validate(&settings)?;
    Ok(settings)
}

pub fn save(path: &Path, mut settings: AppSettings) -> Result<AppSettings, String> {
    settings.initialized = true;
    normalize(&mut settings);
    validate(&settings)?;
    let value_json = serde_json::to_string(&settings)
        .map_err(|error| format!("无法序列化应用设置：{error}"))?;
    let connection = open_connection(path)?;
    connection
        .execute(
            r#"
            INSERT INTO app_settings (id, value_json, updated_at)
            VALUES (1, ?1, ?2)
            ON CONFLICT(id) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            "#,
            params![value_json, Utc::now().to_rfc3339()],
        )
        .map_err(|error| format!("无法保存应用设置：{error}"))?;
    Ok(settings)
}

fn normalize(settings: &mut AppSettings) {
    settings.active_account = settings.active_account.trim().to_string();
    settings.primary_account = settings.primary_account.trim().to_string();
    settings.knowledge_base_url = settings.knowledge_base_url.trim().to_string();
    settings.document_url = settings.document_url.trim().to_string();
    settings.upload_category = settings.upload_category.trim().to_string();
    settings.upload_tags = settings.upload_tags.trim().to_string();
    settings.library_view = settings.library_view.trim().to_string();
    if settings.upload_category.is_empty() {
        settings.upload_category = DEFAULT_CATEGORY.into();
    }
    if settings.library_view.is_empty() {
        settings.library_view = "original".into();
    }
}

fn validate(settings: &AppSettings) -> Result<(), String> {
    validate_text("当前账号", &settings.active_account, 80, false)?;
    validate_text("主账号", &settings.primary_account, 80, false)?;
    validate_text("上传文件夹", &settings.upload_category, 80, false)?;
    validate_text("上传标签", &settings.upload_tags, MAX_SETTING_TEXT_BYTES, true)?;
    if !matches!(settings.library_view.as_str(), "original" | "square") {
        return Err("图库显示模式只支持 original 或 square。".into());
    }
    validate_yuque_url("知识库地址", &settings.knowledge_base_url, false)?;
    validate_yuque_url("目标文档地址", &settings.document_url, true)?;

    if !settings.knowledge_base_url.is_empty() && !settings.document_url.is_empty() {
        let repository = parse_namespace(&settings.knowledge_base_url)?;
        let document = parse_namespace(&settings.document_url)?;
        if repository != document {
            return Err("目标文档与知识库不属于同一个语雀知识库。".into());
        }
    }
    Ok(())
}

fn validate_text(name: &str, value: &str, maximum: usize, allow_empty: bool) -> Result<(), String> {
    if !allow_empty && value.trim().is_empty() {
        return Err(format!("{name}不能为空。"));
    }
    if value.len() > maximum {
        return Err(format!("{name}超过允许长度。"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{name}包含无效控制字符。"));
    }
    Ok(())
}

fn validate_yuque_url(name: &str, value: &str, require_document: bool) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    let parsed = Url::parse(value).map_err(|_| format!("{name}无效。"))?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("yuque.com" | "www.yuque.com"))
    {
        return Err(format!("{name}必须是 HTTPS 语雀地址。"));
    }
    let segments = parsed
        .path_segments()
        .map(|segments| segments.filter(|segment| !segment.is_empty()).count())
        .unwrap_or(0);
    if segments < if require_document { 3 } else { 2 } {
        return Err(format!("{name}路径不完整。"));
    }
    Ok(())
}

fn parse_namespace(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value).map_err(|_| "语雀地址无效。".to_string())?;
    let segments = parsed
        .path_segments()
        .ok_or_else(|| "语雀地址路径无效。".to_string())?
        .filter(|segment| !segment.is_empty())
        .take(2)
        .collect::<Vec<_>>();
    if segments.len() != 2 {
        return Err("语雀知识库路径不完整。".into());
    }
    Ok(format!("{}/{}", segments[0], segments[1]))
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

#[cfg(test)]
mod tests {
    use super::{initialize, load, save, AppSettings};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_database() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("quepic-settings-{unique}.sqlite"))
    }

    #[test]
    fn returns_uninitialized_defaults() {
        let path = temporary_database();
        initialize(&path).unwrap();
        let settings = load(&path).unwrap();
        assert!(!settings.initialized);
        assert_eq!(settings.primary_account, "default");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stores_and_loads_settings() {
        let path = temporary_database();
        initialize(&path).unwrap();
        let settings = AppSettings {
            initialized: false,
            active_account: "工作".into(),
            primary_account: "工作".into(),
            account_failover_enabled: true,
            knowledge_base_url: "https://www.yuque.com/weepwood/index".into(),
            document_url: "https://www.yuque.com/weepwood/index/quepic".into(),
            upload_category: "截图".into(),
            upload_tags: "工作,资料".into(),
            library_view: "square".into(),
            allow_wordpress_fallback: false,
        };
        let saved = save(&path, settings).unwrap();
        assert!(saved.initialized);
        assert_eq!(load(&path).unwrap(), saved);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_invalid_update_without_overwriting_current_settings() {
        let path = temporary_database();
        initialize(&path).unwrap();
        let current = save(&path, AppSettings::default()).unwrap();
        let mut invalid = current.clone();
        invalid.document_url = "https://example.com/private".into();
        assert!(save(&path, invalid).is_err());
        assert_eq!(load(&path).unwrap(), current);
        let _ = std::fs::remove_file(path);
    }
}
