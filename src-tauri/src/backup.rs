use std::{
    fs::{self, File},
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::Utc;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::{accounts, database, preview, AppState};

const BACKUP_FORMAT_VERSION: u32 = 1;
const MAX_ARCHIVE_ENTRIES: usize = 200_000;
const MAX_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortableSettings {
    pub active_account: String,
    pub allow_wordpress_fallback: bool,
    pub upload_category: String,
    pub book_id: String,
    #[serde(default)]
    pub account_names: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupManifest {
    format_version: u32,
    created_at: String,
    includes_library: bool,
    includes_cache: bool,
    credentials_included: bool,
}

#[derive(Debug, Serialize)]
pub struct BackupResult {
    pub cancelled: bool,
    pub path: Option<String>,
    pub includes_library: bool,
    pub includes_cache: bool,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub cancelled: bool,
    pub settings: Option<PortableSettings>,
    pub restored_library: bool,
    pub restored_cache: bool,
    pub restored_cache_files: usize,
}

#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: PortableSettings,
    include_library: bool,
    include_cache: bool,
) -> Result<BackupResult, String> {
    let include_library = include_library || include_cache;
    let default_name = format!(
        "QuePic-backup-{}.quepic-backup",
        Utc::now().format("%Y%m%d-%H%M%S")
    );
    let selected = app
        .dialog()
        .file()
        .set_title("导出 QuePic 备份")
        .set_file_name(&default_name)
        .add_filter("QuePic 备份", &["quepic-backup"])
        .blocking_save_file();

    let Some(selected) = selected else {
        return Ok(BackupResult {
            cancelled: true,
            path: None,
            includes_library: include_library,
            includes_cache: include_cache,
        });
    };
    let mut target = selected
        .into_path()
        .map_err(|error| format!("无法读取备份保存路径：{error}"))?;
    if target.extension().and_then(|value| value.to_str()) != Some("quepic-backup") {
        target.set_extension("quepic-backup");
    }

    settings.account_names = accounts::account_names(&state.database_path)?;
    let database_path = state.database_path.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();
    let cache_lock = state.cache_lock.clone();
    let upload_gate = state.upload_gate.clone();
    drop(state);

    let _upload_guard = upload_gate.lock().await;
    let exported_path = tauri::async_runtime::spawn_blocking(move || {
        let _cache_guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        create_backup_archive(
            &target,
            &database_path,
            &preview_cache_dir,
            &settings,
            include_library,
            include_cache,
        )?;
        Ok::<_, String>(target)
    })
    .await
    .map_err(|error| format!("导出备份任务失败：{error}"))??;

    Ok(BackupResult {
        cancelled: false,
        path: Some(exported_path.to_string_lossy().into_owned()),
        includes_library: include_library,
        includes_cache: include_cache,
    })
}

#[tauri::command]
pub async fn import_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    restore_library: bool,
    restore_cache: bool,
) -> Result<ImportResult, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("导入 QuePic 备份")
        .add_filter("QuePic 备份", &["quepic-backup"])
        .blocking_pick_file();

    let Some(selected) = selected else {
        return Ok(ImportResult {
            cancelled: true,
            settings: None,
            restored_library: false,
            restored_cache: false,
            restored_cache_files: 0,
        });
    };
    let source = selected
        .into_path()
        .map_err(|error| format!("无法读取备份文件路径：{error}"))?;

    let database_path = state.database_path.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();
    let cache_lock = state.cache_lock.clone();
    let upload_gate = state.upload_gate.clone();
    drop(state);

    let _upload_guard = upload_gate.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _cache_guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        restore_backup_archive(
            &source,
            &database_path,
            &preview_cache_dir,
            restore_library || restore_cache,
            restore_cache,
        )
    })
    .await
    .map_err(|error| format!("导入备份任务失败：{error}"))?
}

fn create_backup_archive(
    target: &Path,
    database_path: &Path,
    preview_cache_dir: &Path,
    settings: &PortableSettings,
    include_library: bool,
    include_cache: bool,
) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建备份目录：{error}"))?;
    }
    let temporary_archive = temporary_sibling(target, "part");
    let temporary_root = temporary_directory("quepic-export")?;
    let snapshot_path = temporary_root.join("library.sqlite");

    let result = (|| {
        let output = File::create(&temporary_archive)
            .map_err(|error| format!("无法创建备份文件：{error}"))?;
        let mut archive = ZipWriter::new(output);
        let manifest = BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            created_at: Utc::now().to_rfc3339(),
            includes_library: include_library,
            includes_cache: include_cache,
            credentials_included: false,
        };
        write_json(&mut archive, "manifest.json", &manifest)?;
        write_json(&mut archive, "settings.json", settings)?;

        if include_library {
            snapshot_database(database_path, &snapshot_path)?;
            add_file(&mut archive, &snapshot_path, "library.sqlite")?;
        }
        if include_cache && preview_cache_dir.exists() {
            add_directory(&mut archive, preview_cache_dir, "cache")?;
        }
        archive
            .finish()
            .map_err(|error| format!("无法完成备份压缩包：{error}"))?
            .sync_all()
            .map_err(|error| format!("无法同步备份文件：{error}"))?;
        Ok::<_, String>(())
    })();

    let _ = fs::remove_dir_all(&temporary_root);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary_archive);
        return Err(error);
    }
    if target.exists() {
        fs::remove_file(target).map_err(|error| format!("无法覆盖已有备份文件：{error}"))?;
    }
    fs::rename(&temporary_archive, target).map_err(|error| format!("无法提交备份文件：{error}"))?;
    Ok(())
}

fn restore_backup_archive(
    source: &Path,
    database_path: &Path,
    preview_cache_dir: &Path,
    restore_library: bool,
    restore_cache: bool,
) -> Result<ImportResult, String> {
    let file = File::open(source).map_err(|error| format!("无法打开备份文件：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("备份文件格式无效：{error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("备份文件包含过多条目，已拒绝导入。".into());
    }

    let manifest: BackupManifest = read_json(&mut archive, "manifest.json")?;
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err(format!(
            "不支持的备份格式版本：{}。当前仅支持版本 {}。",
            manifest.format_version, BACKUP_FORMAT_VERSION
        ));
    }
    if manifest.credentials_included {
        return Err("该备份声称包含凭据，QuePic 已拒绝导入。".into());
    }
    let settings: PortableSettings = read_json(&mut archive, "settings.json")?;
    if !restore_library {
        accounts::import_account_names(database_path, &settings.account_names)?;
    }

    let temporary_root = temporary_directory("quepic-import")?;
    let imported_database = temporary_root.join("library.sqlite");
    let imported_cache = temporary_root.join("cache");
    let mut total_bytes = 0_u64;
    let mut cache_files = 0_usize;

    let extract_result = (|| {
        if restore_library {
            if !manifest.includes_library {
                return Err("该备份不包含图片索引，无法执行完整恢复。".into());
            }
            extract_entry(
                &mut archive,
                "library.sqlite",
                &imported_database,
                &mut total_bytes,
            )?;
        }
        if restore_cache {
            if !manifest.includes_cache {
                return Err("该备份不包含图片缓存。".into());
            }
            cache_files = extract_cache_entries(&mut archive, &imported_cache, &mut total_bytes)?;
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = extract_result {
        let _ = fs::remove_dir_all(&temporary_root);
        return Err(error);
    }

    let restore_result = if restore_library {
        restore_library_transaction(
            database_path,
            &imported_database,
            preview_cache_dir,
            restore_cache.then_some(imported_cache.as_path()),
            &settings.account_names,
        )
    } else {
        Ok(())
    };

    let _ = fs::remove_dir_all(&temporary_root);
    restore_result?;
    Ok(ImportResult {
        cancelled: false,
        settings: Some(settings),
        restored_library: restore_library,
        restored_cache: restore_library && restore_cache,
        restored_cache_files: if restore_library && restore_cache {
            cache_files
        } else {
            0
        },
    })
}

fn snapshot_database(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_file(target).map_err(|error| format!("无法清理旧数据库快照：{error}"))?;
    }
    let connection =
        Connection::open(source).map_err(|error| format!("无法打开本地数据库：{error}"))?;
    connection
        .execute_batch("PRAGMA wal_checkpoint(FULL);")
        .map_err(|error| format!("无法同步本地数据库：{error}"))?;
    let escaped = target.to_string_lossy().replace('\'', "''");
    connection
        .execute_batch(&format!("VACUUM INTO '{escaped}';"))
        .map_err(|error| format!("无法创建数据库快照：{error}"))
}

fn restore_library_transaction(
    database_path: &Path,
    imported_database: &Path,
    preview_cache_dir: &Path,
    imported_cache: Option<&Path>,
    account_names: &[String],
) -> Result<(), String> {
    validate_database(imported_database)?;

    let staged_database = temporary_sibling(database_path, "restore");
    let staged_cache = temporary_sibling(preview_cache_dir, "restore");
    let database_backup = temporary_sibling(database_path, "before-import");
    let cache_backup = temporary_sibling(preview_cache_dir, "before-import");

    remove_path(&staged_database);
    remove_path(&staged_cache);
    remove_path(&database_backup);
    remove_path(&cache_backup);

    let preparation_result = (|| {
        fs::copy(imported_database, &staged_database)
            .map_err(|error| format!("无法暂存导入数据库：{error}"))?;
        validate_database(&staged_database)?;
        fs::create_dir_all(&staged_cache).map_err(|error| format!("无法暂存导入缓存：{error}"))?;
        if let Some(imported_cache) = imported_cache {
            copy_directory_contents(imported_cache, &staged_cache)?;
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = preparation_result {
        remove_path(&staged_database);
        remove_path(&staged_cache);
        return Err(error);
    }

    remove_sqlite_sidecars(database_path);
    let had_database = database_path.exists();
    let had_cache = preview_cache_dir.exists();

    if had_database {
        fs::rename(database_path, &database_backup)
            .map_err(|error| format!("无法备份当前数据库：{error}"))?;
    }
    if had_cache {
        if let Err(error) = fs::rename(preview_cache_dir, &cache_backup) {
            if had_database {
                let _ = fs::rename(&database_backup, database_path);
            }
            remove_path(&staged_database);
            remove_path(&staged_cache);
            return Err(format!("无法备份当前图片缓存：{error}"));
        }
    }

    let commit_result = (|| {
        fs::rename(&staged_database, database_path)
            .map_err(|error| format!("无法替换当前数据库：{error}"))?;
        fs::rename(&staged_cache, preview_cache_dir)
            .map_err(|error| format!("无法替换当前图片缓存：{error}"))?;

        database::initialize(database_path)?;
        accounts::initialize(database_path)?;
        accounts::import_account_names(database_path, account_names)?;
        database::clear_previews(database_path)?;
        if imported_cache.is_some() {
            reindex_cache(database_path, preview_cache_dir)?;
        }
        Ok::<_, String>(())
    })();

    if let Err(error) = commit_result {
        let rollback_errors = rollback_restore(
            database_path,
            &database_backup,
            had_database,
            preview_cache_dir,
            &cache_backup,
            had_cache,
        );
        remove_path(&staged_database);
        remove_path(&staged_cache);
        if rollback_errors.is_empty() {
            return Err(format!("恢复备份失败，已恢复原数据：{error}"));
        }
        return Err(format!(
            "恢复备份失败：{error}；自动回滚不完整：{}",
            rollback_errors.join("；")
        ));
    }

    remove_path(&database_backup);
    remove_path(&cache_backup);
    Ok(())
}

fn rollback_restore(
    database_path: &Path,
    database_backup: &Path,
    had_database: bool,
    preview_cache_dir: &Path,
    cache_backup: &Path,
    had_cache: bool,
) -> Vec<String> {
    let mut errors = Vec::new();
    remove_sqlite_sidecars(database_path);

    if database_path.exists() {
        if let Err(error) = fs::remove_file(database_path) {
            errors.push(format!("无法移除失败的导入数据库：{error}"));
        }
    }
    if had_database {
        if let Err(error) = fs::rename(database_backup, database_path) {
            errors.push(format!("无法恢复原数据库：{error}"));
        }
    }

    if preview_cache_dir.exists() {
        if let Err(error) = fs::remove_dir_all(preview_cache_dir) {
            errors.push(format!("无法移除失败的导入缓存：{error}"));
        }
    }
    if had_cache {
        if let Err(error) = fs::rename(cache_backup, preview_cache_dir) {
            errors.push(format!("无法恢复原图片缓存：{error}"));
        }
    } else if let Err(error) = fs::create_dir_all(preview_cache_dir) {
        errors.push(format!("无法重新创建图片缓存目录：{error}"));
    }

    errors
}

fn validate_database(path: &Path) -> Result<(), String> {
    let connection =
        Connection::open(path).map_err(|error| format!("无法打开导入数据库：{error}"))?;
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("无法检查导入数据库：{error}"))?;
    if integrity != "ok" {
        return Err(format!("导入数据库完整性检查失败：{integrity}"));
    }
    let assets_table: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'assets'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("无法验证导入数据库结构：{error}"))?;
    if assets_table != 1 {
        return Err("导入数据库缺少 assets 表。".into());
    }
    Ok(())
}

fn reindex_cache(database_path: &Path, cache_root: &Path) -> Result<(), String> {
    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT id, sha256 FROM assets")
        .map_err(|error| error.to_string())?;
    let assets = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    drop(connection);

    for (asset_id, sha256) in assets {
        if sha256.len() < 2 {
            continue;
        }
        let directory = cache_root.join(&sha256[..2]).join(&sha256);
        let original_path = find_cache_file(&directory, "original.");
        let thumbnail_path = find_cache_file(&directory, "preview.")
            .or_else(|| find_cache_file(&directory, "thumbnail."))
            .or_else(|| original_path.clone());
        if original_path.is_none() && thumbnail_path.is_none() {
            continue;
        }
        let cached = preview::CachedPreview {
            original_path: original_path.map(|path| path.to_string_lossy().into_owned()),
            thumbnail_path: thumbnail_path.map(|path| path.to_string_lossy().into_owned()),
            cache_bytes: 0,
            cached_at: Utc::now().to_rfc3339(),
        };
        database::upsert_cached_preview(database_path, asset_id, &cached, "imported_backup")?;
    }
    Ok(())
}

fn find_cache_file(directory: &Path, prefix: &str) -> Option<PathBuf> {
    fs::read_dir(directory)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.starts_with(prefix))
        })
}

fn write_json<W: Write + Seek, T: Serialize>(
    archive: &mut ZipWriter<W>,
    name: &str,
    value: &T,
) -> Result<(), String> {
    archive
        .start_file(name, archive_options())
        .map_err(|error| format!("无法创建备份条目 {name}：{error}"))?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("无法序列化备份条目 {name}：{error}"))?;
    archive
        .write_all(&bytes)
        .map_err(|error| format!("无法写入备份条目 {name}：{error}"))
}

fn add_file<W: Write + Seek>(
    archive: &mut ZipWriter<W>,
    source: &Path,
    name: &str,
) -> Result<(), String> {
    archive
        .start_file(name, archive_options())
        .map_err(|error| format!("无法创建备份条目 {name}：{error}"))?;
    let mut input = File::open(source).map_err(|error| format!("无法读取 {name}：{error}"))?;
    io::copy(&mut input, archive).map_err(|error| format!("无法压缩 {name}：{error}"))?;
    Ok(())
}

fn add_directory<W: Write + Seek>(
    archive: &mut ZipWriter<W>,
    source_root: &Path,
    archive_root: &str,
) -> Result<(), String> {
    let mut directories = vec![source_root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|error| format!("无法读取缓存目录：{error}"))?
        {
            let entry = entry.map_err(|error| format!("无法读取缓存条目：{error}"))?;
            let metadata = entry
                .file_type()
                .map_err(|error| format!("无法读取缓存条目类型：{error}"))?;
            let path = entry.path();
            if metadata.is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                directories.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(source_root)
                .map_err(|_| "缓存路径超出允许目录。".to_string())?;
            let name = format!(
                "{archive_root}/{}",
                relative.to_string_lossy().replace('\\', "/")
            );
            add_file(archive, &path, &name)?;
        }
    }
    Ok(())
}

fn read_json<R: Read + Seek, T: for<'de> Deserialize<'de>>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<T, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("备份缺少 {name}。"))?;
    if entry.size() > 4 * 1024 * 1024 {
        return Err(format!("备份条目 {name} 异常过大。"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取备份条目 {name}：{error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("无法解析备份条目 {name}：{error}"))
}

fn extract_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    target: &Path,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("备份缺少 {name}。"))?;
    account_archive_bytes(total_bytes, entry.size())?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建导入目录：{error}"))?;
    }
    let mut output = File::create(target).map_err(|error| format!("无法创建导入文件：{error}"))?;
    io::copy(&mut entry, &mut output).map_err(|error| format!("无法提取 {name}：{error}"))?;
    Ok(())
}

fn extract_cache_entries<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    target_root: &Path,
    total_bytes: &mut u64,
) -> Result<usize, String> {
    let mut extracted = 0_usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取备份条目：{error}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            return Err("备份包含不安全的路径。".into());
        };
        let Ok(relative) = enclosed.strip_prefix("cache") else {
            continue;
        };
        if relative.as_os_str().is_empty() || entry.is_dir() {
            continue;
        }
        account_archive_bytes(total_bytes, entry.size())?;
        let target = target_root.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建缓存导入目录：{error}"))?;
        }
        let mut output =
            File::create(&target).map_err(|error| format!("无法创建缓存文件：{error}"))?;
        io::copy(&mut entry, &mut output).map_err(|error| format!("无法提取缓存文件：{error}"))?;
        extracted += 1;
    }
    Ok(extracted)
}

fn account_archive_bytes(total: &mut u64, added: u64) -> Result<(), String> {
    *total = total.saturating_add(added);
    if *total > MAX_ARCHIVE_BYTES {
        return Err("备份解压后超过 20 GB 安全限制。".into());
    }
    Ok(())
}

fn copy_directory_contents(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("无法创建缓存目录：{error}"))?;
    if !source.exists() {
        return Ok(());
    }
    let mut stack = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((current_source, current_target)) = stack.pop() {
        fs::create_dir_all(&current_target)
            .map_err(|error| format!("无法创建缓存目录：{error}"))?;
        for entry in
            fs::read_dir(&current_source).map_err(|error| format!("无法读取导入缓存：{error}"))?
        {
            let entry = entry.map_err(|error| format!("无法读取导入缓存条目：{error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("无法读取缓存类型：{error}"))?;
            let destination = current_target.join(entry.file_name());
            if file_type.is_dir() {
                stack.push((entry.path(), destination));
            } else if file_type.is_file() {
                fs::copy(entry.path(), destination)
                    .map_err(|error| format!("无法恢复缓存文件：{error}"))?;
            }
        }
    }
    Ok(())
}

fn archive_options() -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600)
}

fn temporary_directory(prefix: &str) -> Result<PathBuf, String> {
    let path = std::env::temp_dir().join(format!("{prefix}-{}", nonce()));
    fs::create_dir_all(&path).map_err(|error| format!("无法创建临时目录：{error}"))?;
    Ok(path)
}

fn temporary_sibling(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("quepic-backup");
    path.with_file_name(format!(".{file_name}.{}.{}", nonce(), suffix))
}

fn remove_path(path: &Path) {
    if path.is_dir() {
        let _ = fs::remove_dir_all(path);
    } else {
        let _ = fs::remove_file(path);
    }
}

fn remove_sqlite_sidecars(path: &Path) {
    let _ = fs::remove_file(format!("{}-wal", path.to_string_lossy()));
    let _ = fs::remove_file(format!("{}-shm", path.to_string_lossy()));
}

fn nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_archives() {
        let mut total = MAX_ARCHIVE_BYTES;
        assert!(account_archive_bytes(&mut total, 1).is_err());
    }

    #[test]
    fn portable_settings_do_not_contain_secrets() {
        let settings = PortableSettings {
            active_account: "default".into(),
            allow_wordpress_fallback: false,
            upload_category: "未分类".into(),
            book_id: "123".into(),
            account_names: vec!["default".into()],
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("cookie"));
        assert!(!json.contains("token"));
    }

    #[test]
    fn restores_original_database_and_cache_when_commit_fails() {
        let root = temporary_directory("quepic-rollback-test").unwrap();
        let database_path = root.join("quepic.db");
        let imported_database = root.join("broken.sqlite");
        let cache_path = root.join("previews");

        database::initialize(&database_path).unwrap();
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch("CREATE TABLE rollback_marker (value TEXT NOT NULL); INSERT INTO rollback_marker VALUES ('keep');")
            .unwrap();
        drop(connection);

        fs::create_dir_all(&cache_path).unwrap();
        fs::write(cache_path.join("marker.txt"), b"keep").unwrap();

        let imported = Connection::open(&imported_database).unwrap();
        imported
            .execute_batch("CREATE TABLE assets (id INTEGER PRIMARY KEY);")
            .unwrap();
        drop(imported);

        let result =
            restore_library_transaction(&database_path, &imported_database, &cache_path, None, &[]);
        assert!(result.is_err());

        let restored = Connection::open(&database_path).unwrap();
        let marker: String = restored
            .query_row("SELECT value FROM rollback_marker", [], |row| row.get(0))
            .unwrap();
        assert_eq!(marker, "keep");
        assert_eq!(fs::read(cache_path.join("marker.txt")).unwrap(), b"keep");

        let _ = fs::remove_dir_all(root);
    }
}
