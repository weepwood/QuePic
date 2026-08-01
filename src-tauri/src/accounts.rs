use std::{path::Path, time::Duration};

use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::{credentials, openapi_token, AppState};

const DEFAULT_ACCOUNT: &str = "default";

#[derive(Debug, Clone, Serialize)]
pub struct AccountProfile {
    pub account_name: String,
    pub credential_configured: bool,
    pub token_configured: bool,
    pub asset_count: i64,
    pub cached_count: i64,
    pub updated_at: Option<String>,
}

pub fn initialize(path: &Path) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS account_profiles (
                account_name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .map_err(|error| error.to_string())?;
    upsert_name(&connection, DEFAULT_ACCOUNT)?;
    Ok(())
}

#[tauri::command]
pub fn list_account_profiles(state: State<'_, AppState>) -> Result<Vec<AccountProfile>, String> {
    let names = account_names(&state.database_path)?;
    names
        .into_iter()
        .map(|account_name| profile(&state.database_path, &account_name))
        .collect()
}

#[tauri::command]
pub fn save_account_profile(
    state: State<'_, AppState>,
    account_name: String,
) -> Result<AccountProfile, String> {
    let account_name = normalize_account_name(&account_name)?;
    let connection = open_connection(&state.database_path)?;
    upsert_name(&connection, &account_name)?;
    profile(&state.database_path, &account_name)
}

pub fn import_account_names(path: &Path, account_names: &[String]) -> Result<(), String> {
    let connection = open_connection(path)?;
    for account_name in account_names {
        let account_name = normalize_account_name(account_name)?;
        upsert_name(&connection, &account_name)?;
    }
    Ok(())
}

pub fn account_names(path: &Path) -> Result<Vec<String>, String> {
    let connection = open_connection(path)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT account_name FROM account_profiles
            UNION
            SELECT account_name FROM assets
            UNION
            SELECT account_name FROM upload_attempts
            ORDER BY account_name COLLATE NOCASE
            "#,
        )
        .map_err(|error| error.to_string())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if names.is_empty() {
        Ok(vec![DEFAULT_ACCOUNT.into()])
    } else {
        Ok(names)
    }
}

fn profile(path: &Path, account_name: &str) -> Result<AccountProfile, String> {
    let connection = open_connection(path)?;
    let (asset_count, cached_count, updated_at): (i64, i64, Option<String>) = connection
        .query_row(
            r#"
            SELECT
                COUNT(DISTINCT a.id),
                COUNT(DISTINCT CASE WHEN p.cache_status = 'ready' THEN a.id END),
                MAX(ap.updated_at)
            FROM (SELECT ?1 AS account_name) requested
            LEFT JOIN assets a ON a.account_name = requested.account_name
            LEFT JOIN asset_previews p ON p.asset_id = a.id
            LEFT JOIN account_profiles ap ON ap.account_name = requested.account_name
            "#,
            [account_name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;

    let credential_configured = credentials::configured(account_name)?;
    let token_configured = openapi_token::openapi_token_status(account_name.to_string())?.configured;

    Ok(AccountProfile {
        account_name: account_name.to_string(),
        credential_configured,
        token_configured,
        asset_count,
        cached_count,
        updated_at,
    })
}

fn upsert_name(connection: &Connection, account_name: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            r#"
            INSERT INTO account_profiles (account_name, created_at, updated_at)
            VALUES (?1, ?2, ?2)
            ON CONFLICT(account_name) DO UPDATE SET updated_at = excluded.updated_at
            "#,
            params![account_name, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::{account_names, import_account_names, initialize};
    use crate::database;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn stores_multiple_account_names() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("quepic-accounts-{unique}.sqlite"));
        database::initialize(&path).unwrap();
        initialize(&path).unwrap();
        import_account_names(&path, &["工作".into(), "个人".into()]).unwrap();
        let names = account_names(&path).unwrap();
        assert!(names.contains(&"default".to_string()));
        assert!(names.contains(&"工作".to_string()));
        assert!(names.contains(&"个人".to_string()));
        let _ = std::fs::remove_file(path);
    }
}
