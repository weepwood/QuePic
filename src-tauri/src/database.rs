use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::models::AssetRecord;

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

            CREATE INDEX IF NOT EXISTS idx_assets_uploaded_at
            ON assets(uploaded_at DESC);

            CREATE INDEX IF NOT EXISTS idx_assets_file_name
            ON assets(file_name);
            "#,
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn find_by_hash(path: &Path, sha256: &str) -> Result<Option<AssetRecord>, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .query_row(
            r#"
            SELECT id, sha256, file_name, mime_type, file_size, width, height,
                   remote_url, account_name, uploaded_at
            FROM assets
            WHERE sha256 = ?1
            "#,
            [sha256],
            map_asset,
        )
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

    let mut saved = asset.clone();
    saved.id = connection.last_insert_rowid();
    Ok(saved)
}

pub fn list_assets(path: &Path) -> Result<Vec<AssetRecord>, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, sha256, file_name, mime_type, file_size, width, height,
                   remote_url, account_name, uploaded_at
            FROM assets
            ORDER BY uploaded_at DESC, id DESC
            "#,
        )
        .map_err(|error| error.to_string())?;
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
    })
}
