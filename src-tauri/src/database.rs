use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    models::{AssetRecord, CacheStats},
    preview::CachedPreview,
};

pub fn initialize(path: &Path) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

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

            CREATE INDEX IF NOT EXISTS idx_assets_uploaded_at
            ON assets(uploaded_at DESC);

            CREATE INDEX IF NOT EXISTS idx_assets_file_name
            ON assets(file_name);

            CREATE INDEX IF NOT EXISTS idx_asset_previews_status
            ON asset_previews(cache_status);
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
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let sql = format!("{} {clause}", asset_select());
    connection
        .query_row(&sql, parameters, map_asset)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn insert_asset(path: &Path, asset: &AssetRecord) -> Result<AssetRecord, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
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

    let id = connection.last_insert_rowid();
    drop(connection);
    find_by_id(path, id)?.ok_or_else(|| "保存图片索引后无法重新读取记录。".into())
}

pub fn upsert_cached_preview(
    path: &Path,
    asset_id: i64,
    preview: &CachedPreview,
) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT INTO asset_previews (
                asset_id, original_path, thumbnail_path, preview_source,
                cache_status, cache_bytes, cached_at, last_error
            ) VALUES (?1, ?2, ?3, 'local', 'ready', ?4, ?5, NULL)
            ON CONFLICT(asset_id) DO UPDATE SET
                original_path = excluded.original_path,
                thumbnail_path = excluded.thumbnail_path,
                preview_source = 'local',
                cache_status = 'ready',
                cache_bytes = excluded.cache_bytes,
                cached_at = excluded.cached_at,
                last_error = NULL
            "#,
            params![
                asset_id,
                &preview.original_path,
                &preview.thumbnail_path,
                preview.cache_bytes,
                &preview.cached_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn mark_preview_error(path: &Path, asset_id: i64, error: &str) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|value| value.to_string())?;
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
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let sql = format!("{} ORDER BY a.uploaded_at DESC, a.id DESC", asset_select());
    let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement.query_map([], map_asset).map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

pub fn delete_asset(path: &Path, id: i64) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM assets WHERE id = ?1", [id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn clear_previews(path: &Path) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute("DELETE FROM asset_previews", [])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn cache_stats(path: &Path) -> Result<CacheStats, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
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

fn asset_select() -> &'static str {
    r#"
    SELECT
        a.id, a.sha256, a.file_name, a.mime_type, a.file_size, a.width, a.height,
        a.remote_url, a.account_name, a.uploaded_at,
        p.original_path, p.thumbnail_path,
        COALESCE(p.preview_source, 'missing'),
        COALESCE(p.cache_status, 'missing'),
        p.cache_bytes, p.cached_at, p.last_error
    FROM assets a
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
        original_path: row.get(10)?,
        thumbnail_path: row.get(11)?,
        preview_source: row.get(12)?,
        cache_status: row.get(13)?,
        cache_bytes: row.get(14)?,
        cached_at: row.get(15)?,
        last_error: row.get(16)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_database() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("quepic-db-{unique}.sqlite"))
    }

    #[test]
    fn migrates_preview_table_and_reports_empty_stats() {
        let path = temporary_database();
        initialize(&path).unwrap();
        let stats = cache_stats(&path).unwrap();
        assert_eq!(stats.asset_count, 0);
        assert_eq!(stats.cached_count, 0);
        assert_eq!(stats.cache_bytes, 0);
        let _ = std::fs::remove_file(path);
    }
}
