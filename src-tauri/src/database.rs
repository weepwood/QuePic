use std::{path::Path, time::{Duration, SystemTime, UNIX_EPOCH}};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    models::{AssetRecord, CacheStats, UploadQuotaStatus},
    preview::CachedPreview,
};

pub const UPLOAD_HOURLY_LIMIT: i64 = 140;
pub const UPLOAD_MINIMUM_INTERVAL_SECONDS: i64 = 25;
const DEFAULT_CATEGORY: &str = "未分类";

pub fn initialize(path: &Path) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sha256 TEXT NOT NULL UNIQUE,
                file_name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                width INTEGER,
                height INTEGER,
                remote_url TEXT NOT NULL,
                account_name TEXT NOT NULL,
                uploaded_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS asset_previews (
                asset_id INTEGER PRIMARY KEY,
                original_path TEXT,
                thumbnail_path TEXT,
                preview_source TEXT NOT NULL DEFAULT 'missing',
                cache_status TEXT NOT NULL DEFAULT 'missing',
                cache_bytes INTEGER,
                cached_at TEXT,
                last_error TEXT,
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS asset_categories (
                asset_id INTEGER PRIMARY KEY,
                category TEXT NOT NULL DEFAULT '未分类',
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS upload_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_name TEXT NOT NULL,
                attempted_at INTEGER NOT NULL,
                succeeded INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_assets_uploaded_at
            ON assets(uploaded_at DESC);

            CREATE INDEX IF NOT EXISTS idx_assets_file_name
            ON assets(file_name);

            CREATE INDEX IF NOT EXISTS idx_asset_previews_status
            ON asset_previews(cache_status);

            CREATE INDEX IF NOT EXISTS idx_asset_categories_category
            ON asset_categories(category);

            CREATE INDEX IF NOT EXISTS idx_upload_attempts_account_time
            ON upload_attempts(account_name, attempted_at DESC);
            "#,
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn find_by_hash(path: &Path, sha256: &str) -> Result<Option<AssetRecord>, String> {
    query_one(path, "WHERE a.sha256 = ?1", rusqlite::params![sha256])
}

pub fn find_by_id(path: &Path, id: i64) -> Result<Option<AssetRecord>, String> {
    query_one(path, "WHERE a.id = ?1", rusqlite::params![id])
}

fn query_one<P>(path: &Path, clause: &str, parameters: P) -> Result<Option<AssetRecord>, String>
where
    P: rusqlite::Params,
{
    let connection = open_connection(path)?;
    let sql = format!("{} {clause}", asset_select());
    connection
        .query_row(&sql, parameters, map_asset)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn insert_asset(path: &Path, asset: &AssetRecord) -> Result<AssetRecord, String> {
    let mut connection = open_connection(path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction
        .execute(
            r#"
            INSERT INTO assets (
                sha256, file_name, mime_type, file_size, width, height,
                remote_url, account_name, uploaded_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                &asset.sha256,
                &asset.file_name,
                &asset.mime_type,
                asset.file_size,
                asset.width,
                asset.height,
                &asset.remote_url,
                &asset.account_name,
                &asset.uploaded_at,
            ],
        )
        .map_err(|error| error.to_string())?;

    let id = transaction.last_insert_rowid();
    transaction
        .execute(
            "INSERT INTO asset_categories (asset_id, category) VALUES (?1, ?2)",
            params![id, normalized_category(&asset.category)],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    find_by_id(path, id)?.ok_or_else(|| "保存图片索引后无法重新读取记录。".into())
}

pub fn update_asset_category(path: &Path, id: i64, category: &str) -> Result<AssetRecord, String> {
    let connection = open_connection(path)?;
    let changed = connection
        .execute(
            r#"
            INSERT INTO asset_categories (asset_id, category) VALUES (?1, ?2)
            ON CONFLICT(asset_id) DO UPDATE SET category = excluded.category
            "#,
            params![id, normalized_category(category)],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 || find_by_id(path, id)?.is_none() {
        return Err("图片记录不存在。".into());
    }
    find_by_id(path, id)?.ok_or_else(|| "更新图片分类后无法重新读取记录。".into())
}

pub fn upsert_cached_preview(
    path: &Path,
    asset_id: i64,
    preview: &CachedPreview,
    source: &str,
) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute(
            r#"
            INSERT INTO asset_previews (
                asset_id, original_path, thumbnail_path, preview_source,
                cache_status, cache_bytes, cached_at, last_error
            ) VALUES (?1, ?2, ?3, ?4, 'ready', ?5, ?6, NULL)
            ON CONFLICT(asset_id) DO UPDATE SET
                original_path = excluded.original_path,
                thumbnail_path = excluded.thumbnail_path,
                preview_source = excluded.preview_source,
                cache_status = 'ready',
                cache_bytes = excluded.cache_bytes,
                cached_at = excluded.cached_at,
                last_error = NULL
            "#,
            params![
                asset_id,
                &preview.original_path,
                &preview.thumbnail_path,
                source,
                preview.cache_bytes,
                &preview.cached_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn mark_preview_error(path: &Path, asset_id: i64, error: &str) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute(
            r#"
            INSERT INTO asset_previews (asset_id, preview_source, cache_status, last_error)
            VALUES (?1, 'missing', 'error', ?2)
            ON CONFLICT(asset_id) DO UPDATE SET
                preview_source = 'missing',
                cache_status = 'error',
                last_error = excluded.last_error
            "#,
            params![asset_id, error],
        )
        .map_err(|value| value.to_string())?;
    Ok(())
}

pub fn list_assets(path: &Path) -> Result<Vec<AssetRecord>, String> {
    let connection = open_connection(path)?;
    let sql = format!("{} ORDER BY a.uploaded_at DESC, a.id DESC", asset_select());
    let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], map_asset).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn delete_asset(path: &Path, id: i64) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute("DELETE FROM assets WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn clear_previews(path: &Path) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute("DELETE FROM asset_previews", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn cache_stats(path: &Path) -> Result<CacheStats, String> {
    let connection = open_connection(path)?;
    connection
        .query_row(
            r#"
            SELECT
                (SELECT COUNT(*) FROM assets),
                COALESCE(SUM(CASE WHEN cache_status = 'ready' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN cache_status = 'ready' THEN cache_bytes ELSE 0 END), 0)
            FROM asset_previews
            "#,
            [],
            |row| {
                Ok(CacheStats {
                    asset_count: row.get(0)?,
                    cached_count: row.get(1)?,
                    cache_bytes: row.get(2)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

pub fn upload_quota_status(path: &Path, account_name: &str) -> Result<UploadQuotaStatus, String> {
    let connection = open_connection(path)?;
    let now = unix_timestamp();
    connection
        .execute("DELETE FROM upload_attempts WHERE attempted_at < ?1", [now - 86_400])
        .map_err(|error| error.to_string())?;

    let (used, oldest, newest): (i64, Option<i64>, Option<i64>) = connection
        .query_row(
            r#"
            SELECT COUNT(*), MIN(attempted_at), MAX(attempted_at)
            FROM upload_attempts
            WHERE account_name = ?1 AND attempted_at > ?2
            "#,
            params![account_name, now - 3_600],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;

    let remaining = (UPLOAD_HOURLY_LIMIT - used).max(0);
    let hourly_wait = if used >= UPLOAD_HOURLY_LIMIT {
        oldest.map(|value| (value + 3_600 - now).max(1)).unwrap_or(1)
    } else {
        0
    };
    let pacing_wait = newest
        .map(|value| (value + UPLOAD_MINIMUM_INTERVAL_SECONDS - now).max(0))
        .unwrap_or(0);
    let retry_after_seconds = hourly_wait.max(pacing_wait);
    let reset_at = oldest
        .and_then(|value| DateTime::<Utc>::from_timestamp(value + 3_600, 0))
        .map(|value| value.to_rfc3339());

    Ok(UploadQuotaStatus {
        account_name: account_name.to_string(),
        used,
        limit: UPLOAD_HOURLY_LIMIT,
        remaining,
        retry_after_seconds,
        reset_at,
        minimum_interval_seconds: UPLOAD_MINIMUM_INTERVAL_SECONDS,
    })
}

pub fn record_upload_attempt(path: &Path, account_name: &str) -> Result<i64, String> {
    let connection = open_connection(path)?;
    connection
        .execute(
            "INSERT INTO upload_attempts (account_name, attempted_at, succeeded) VALUES (?1, ?2, 0)",
            params![account_name, unix_timestamp()],
        )
        .map_err(|error| error.to_string())?;
    Ok(connection.last_insert_rowid())
}

pub fn mark_upload_attempt_success(path: &Path, attempt_id: i64) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute("UPDATE upload_attempts SET succeeded = 1 WHERE id = ?1", [attempt_id])
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

fn asset_select() -> &'static str {
    r#"
    SELECT
        a.id, a.sha256, a.file_name, a.mime_type, a.file_size, a.width, a.height,
        a.remote_url, a.account_name, a.uploaded_at,
        COALESCE(c.category, '未分类'),
        p.original_path, p.thumbnail_path,
        COALESCE(p.preview_source, 'missing'),
        COALESCE(p.cache_status, 'missing'),
        p.cache_bytes, p.cached_at, p.last_error
    FROM assets a
    LEFT JOIN asset_categories c ON c.asset_id = a.id
    LEFT JOIN asset_previews p ON p.asset_id = a.id
    "#
}

fn map_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<AssetRecord> {
    Ok(AssetRecord {
        id: row.get(0)?,
        sha256: row.get(1)?,
        file_name: row.get(2)?,
        mime_type: row.get(3)?,
        file_size: row.get(4)?,
        width: row.get(5)?,
        height: row.get(6)?,
        remote_url: row.get(7)?,
        account_name: row.get(8)?,
        uploaded_at: row.get(9)?,
        category: row.get(10)?,
        original_path: row.get(11)?,
        thumbnail_path: row.get(12)?,
        preview_source: row.get(13)?,
        cache_status: row.get(14)?,
        cache_bytes: row.get(15)?,
        cached_at: row.get(16)?,
        last_error: row.get(17)?,
    })
}

fn normalized_category(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() { DEFAULT_CATEGORY.to_string() } else { value.to_string() }
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_database() -> std::path::PathBuf {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("quepic-db-{unique}.sqlite"))
    }

    fn test_asset() -> AssetRecord {
        AssetRecord {
            id: 0,
            sha256: "a".repeat(64),
            file_name: "test.png".into(),
            mime_type: "image/png".into(),
            file_size: 128,
            width: Some(16),
            height: Some(16),
            remote_url: "https://cdn.nlark.com/yuque/test.png".into(),
            account_name: "default".into(),
            uploaded_at: "2026-07-27T00:00:00Z".into(),
            category: "测试".into(),
            original_path: None,
            thumbnail_path: None,
            preview_source: "missing".into(),
            cache_status: "missing".into(),
            cache_bytes: None,
            cached_at: None,
            last_error: None,
        }
    }

    fn cleanup_database(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(format!("{}-wal", path.to_string_lossy()));
        let _ = std::fs::remove_file(format!("{}-shm", path.to_string_lossy()));
    }

    #[test]
    fn stores_and_updates_categories() {
        let path = temporary_database();
        initialize(&path).unwrap();
        let asset = insert_asset(&path, &test_asset()).unwrap();
        assert_eq!(asset.category, "测试");
        let updated = update_asset_category(&path, asset.id, "截图").unwrap();
        assert_eq!(updated.category, "截图");
        cleanup_database(&path);
    }

    #[test]
    fn reports_upload_quota_and_spacing() {
        let path = temporary_database();
        initialize(&path).unwrap();
        let before = upload_quota_status(&path, "default").unwrap();
        assert_eq!(before.used, 0);
        let id = record_upload_attempt(&path, "default").unwrap();
        mark_upload_attempt_success(&path, id).unwrap();
        let after = upload_quota_status(&path, "default").unwrap();
        assert_eq!(after.used, 1);
        assert!(after.retry_after_seconds > 0);
        cleanup_database(&path);
    }
}
