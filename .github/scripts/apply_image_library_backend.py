from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, path: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}\n--- old ---\n{old}")
    return text.replace(old, new, 1)


def replace_regex(text: str, pattern: str, replacement: str, path: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{path}: regex expected one match, found {count}\n{pattern}")
    return updated


# Cargo dependency: use the official Tauri system opener instead of WebView window.open.
path = "src-tauri/Cargo.toml"
text = read(path)
text = replace_once(
    text,
    'tauri-plugin-dialog = "2"\n',
    'tauri-plugin-dialog = "2"\ntauri-plugin-opener = "2"\n',
    path,
)
write(path, text)


# Asset/tag model.
path = "src-tauri/src/models.rs"
text = read(path)
text = replace_once(
    text,
    '    pub category: String,\n    pub original_path: Option<String>,',
    '    pub category: String,\n    pub tags: Vec<String>,\n    pub original_path: Option<String>,',
    path,
)
text = replace_once(
    text,
    '    pub category: String,\n    pub attachable_id: i64,',
    '    pub category: String,\n    #[serde(default)]\n    pub tags: Vec<String>,\n    pub attachable_id: i64,',
    path,
)
write(path, text)


# Database: independent folder registry + multi-tag relation.
path = "src-tauri/src/database.rs"
text = read(path)
text = replace_once(
    text,
    'use std::{\n    fs,',
    'use std::{\n    collections::HashMap,\n    fs,',
    path,
)
text = replace_once(
    text,
    '''            CREATE TABLE IF NOT EXISTS asset_categories (
                asset_id INTEGER PRIMARY KEY,
                category TEXT NOT NULL DEFAULT '未分类',
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS upload_attempts (''',
    '''            CREATE TABLE IF NOT EXISTS library_folders (
                name TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS asset_categories (
                asset_id INTEGER PRIMARY KEY,
                category TEXT NOT NULL DEFAULT '未分类',
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS asset_tags (
                asset_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY(asset_id, tag),
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS upload_attempts (''',
    path,
)
text = replace_once(
    text,
    '    migrate_asset_hash_scope(&mut connection)?;\n\n    connection',
    '''    migrate_asset_hash_scope(&mut connection)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO library_folders (name, created_at) VALUES (?1, ?2)",
            params![DEFAULT_CATEGORY, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            r#"
            INSERT OR IGNORE INTO library_folders (name, created_at)
            SELECT DISTINCT category, ?1 FROM asset_categories
            WHERE TRIM(category) <> ''
            "#,
            [Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;

    connection''',
    path,
)
text = replace_once(
    text,
    '''            CREATE INDEX IF NOT EXISTS idx_asset_categories_category
            ON asset_categories(category);

            CREATE INDEX IF NOT EXISTS idx_upload_attempts_account_time''',
    '''            CREATE INDEX IF NOT EXISTS idx_asset_categories_category
            ON asset_categories(category);

            CREATE INDEX IF NOT EXISTS idx_asset_tags_tag
            ON asset_tags(tag);

            CREATE INDEX IF NOT EXISTS idx_upload_attempts_account_time''',
    path,
)

text = replace_regex(
    text,
    r'''fn query_one<P>\(path: &Path, clause: &str, parameters: P\) -> Result<Option<AssetRecord>, String>\nwhere\n    P: rusqlite::Params,\n\{.*?\n\}\n\npub fn insert_asset''',
    '''fn query_one<P>(path: &Path, clause: &str, parameters: P) -> Result<Option<AssetRecord>, String>
where
    P: rusqlite::Params,
{
    let connection = open_connection(path)?;
    let sql = format!("{} {clause}", asset_select());
    let mut asset = connection
        .query_row(&sql, parameters, map_asset)
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(asset) = asset.as_mut() {
        asset.tags = load_asset_tags(&connection, asset.id)?;
    }
    Ok(asset)
}

pub fn insert_asset''',
    path,
)

text = replace_once(
    text,
    '''    let id = transaction.last_insert_rowid();
    transaction
        .execute(
            "INSERT INTO asset_categories (asset_id, category) VALUES (?1, ?2)",
            params![id, normalized_category(&asset.category)],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;''',
    '''    let id = transaction.last_insert_rowid();
    let category = normalized_category(&asset.category);
    transaction
        .execute(
            "INSERT OR IGNORE INTO library_folders (name, created_at) VALUES (?1, ?2)",
            params![&category, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO asset_categories (asset_id, category) VALUES (?1, ?2)",
            params![id, &category],
        )
        .map_err(|error| error.to_string())?;
    for tag in normalized_tags(&asset.tags)? {
        transaction
            .execute(
                "INSERT OR IGNORE INTO asset_tags (asset_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;''',
    path,
)

text = replace_regex(
    text,
    r'''pub fn update_asset_category\(path: &Path, id: i64, category: &str\) -> Result<AssetRecord, String> \{.*?\n\}\n\npub fn upsert_cached_preview''',
    '''pub fn update_asset_category(path: &Path, id: i64, category: &str) -> Result<AssetRecord, String> {
    let mut connection = open_connection(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let exists = transaction
        .query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)", [id], |row| {
            row.get::<_, bool>(0)
        })
        .map_err(|error| error.to_string())?;
    if !exists {
        return Err("图片记录不存在。".into());
    }
    let category = normalized_category(category);
    transaction
        .execute(
            "INSERT OR IGNORE INTO library_folders (name, created_at) VALUES (?1, ?2)",
            params![&category, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            r#"
            INSERT INTO asset_categories (asset_id, category) VALUES (?1, ?2)
            ON CONFLICT(asset_id) DO UPDATE SET category = excluded.category
            "#,
            params![id, category],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    find_by_id(path, id)?.ok_or_else(|| "更新图片文件夹后无法重新读取记录。".into())
}

pub fn list_library_folders(path: &Path) -> Result<Vec<String>, String> {
    let connection = open_connection(path)?;
    let mut statement = connection
        .prepare("SELECT name FROM library_folders ORDER BY CASE WHEN name = '未分类' THEN 0 ELSE 1 END, name COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn create_library_folder(path: &Path, name: &str) -> Result<String, String> {
    let name = normalized_folder(name)?;
    let connection = open_connection(path)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO library_folders (name, created_at) VALUES (?1, ?2)",
            params![&name, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    Ok(name)
}

pub fn list_asset_tags(path: &Path) -> Result<Vec<String>, String> {
    let connection = open_connection(path)?;
    let mut statement = connection
        .prepare("SELECT DISTINCT tag FROM asset_tags ORDER BY tag COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn update_asset_tags(path: &Path, id: i64, tags: &[String]) -> Result<AssetRecord, String> {
    let tags = normalized_tags(tags)?;
    let mut connection = open_connection(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let exists = transaction
        .query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1)", [id], |row| {
            row.get::<_, bool>(0)
        })
        .map_err(|error| error.to_string())?;
    if !exists {
        return Err("图片记录不存在。".into());
    }
    transaction
        .execute("DELETE FROM asset_tags WHERE asset_id = ?1", [id])
        .map_err(|error| error.to_string())?;
    for tag in tags {
        transaction
            .execute(
                "INSERT INTO asset_tags (asset_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    find_by_id(path, id)?.ok_or_else(|| "更新图片标签后无法重新读取记录。".into())
}

pub fn upsert_cached_preview''',
    path,
)

text = replace_regex(
    text,
    r'''pub fn list_assets\(path: &Path\) -> Result<Vec<AssetRecord>, String> \{.*?\n\}\n\npub fn delete_asset''',
    '''pub fn list_assets(path: &Path) -> Result<Vec<AssetRecord>, String> {
    let connection = open_connection(path)?;
    let sql = format!("{} ORDER BY a.uploaded_at DESC, a.id DESC", asset_select());
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], map_asset)
        .map_err(|error| error.to_string())?;
    let mut assets = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    hydrate_asset_tags(&connection, &mut assets)?;
    Ok(assets)
}

pub fn delete_asset''',
    path,
)

text = replace_once(
    text,
    '        category: row.get(10)?,\n        original_path: row.get(11)?,',
    '        category: row.get(10)?,\n        tags: Vec::new(),\n        original_path: row.get(11)?,',
    path,
)
text = replace_once(
    text,
    '''fn normalized_category(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        DEFAULT_CATEGORY.to_string()
    } else {
        value.to_string()
    }
}

fn unix_timestamp''',
    '''fn normalized_category(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        DEFAULT_CATEGORY.to_string()
    } else {
        value.to_string()
    }
}

fn normalized_folder(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("文件夹名称不能为空。".into());
    }
    if value.chars().count() > 64 || value.chars().any(char::is_control) {
        return Err("文件夹名称无效或超过 64 个字符。".into());
    }
    Ok(value.to_string())
}

fn normalized_tags(values: &[String]) -> Result<Vec<String>, String> {
    let mut tags = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.chars().count() > 48 || value.chars().any(char::is_control) {
            return Err("标签名称无效或超过 48 个字符。".into());
        }
        if !tags.iter().any(|existing| existing == value) {
            tags.push(value.to_string());
        }
    }
    if tags.len() > 20 {
        return Err("每张图片最多设置 20 个标签。".into());
    }
    Ok(tags)
}

fn load_asset_tags(connection: &Connection, asset_id: i64) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT tag FROM asset_tags WHERE asset_id = ?1 ORDER BY tag COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    statement
        .query_map([asset_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn hydrate_asset_tags(connection: &Connection, assets: &mut [AssetRecord]) -> Result<(), String> {
    if assets.is_empty() {
        return Ok(());
    }
    let mut statement = connection
        .prepare("SELECT asset_id, tag FROM asset_tags ORDER BY tag COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| error.to_string())?;
    let mut tags_by_asset: HashMap<i64, Vec<String>> = HashMap::new();
    for row in rows {
        let (asset_id, tag) = row.map_err(|error| error.to_string())?;
        tags_by_asset.entry(asset_id).or_default().push(tag);
    }
    for asset in assets {
        asset.tags = tags_by_asset.remove(&asset.id).unwrap_or_default();
    }
    Ok(())
}

fn unix_timestamp''',
    path,
)
text = replace_once(
    text,
    '            category: "测试".into(),\n            original_path: None,',
    '            category: "测试".into(),\n            tags: vec!["演示".into()],\n            original_path: None,',
    path,
)
write(path, text)


# Bounded cache: display cache + thumbnail together stay below roughly 1 MB.
path = "src-tauri/src/preview.rs"
text = read(path)
text = replace_once(
    text,
    'use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat};\n\nconst DISPLAY_EDGE: u32 = 1_600;\nconst REMOTE_PREVIEW_EDGE: u32 = 640;\nconst DISPLAY_JPEG_QUALITY: u8 = 80;\nconst REMOTE_PREVIEW_JPEG_QUALITY: u8 = 76;',
    'use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat};\n\nconst DISPLAY_EDGE: u32 = 2_400;\nconst REMOTE_PREVIEW_EDGE: u32 = 720;\nconst DISPLAY_JPEG_QUALITY: u8 = 82;\nconst REMOTE_PREVIEW_JPEG_QUALITY: u8 = 72;\nconst DISPLAY_CACHE_MAX_BYTES: usize = 820_000;\nconst THUMBNAIL_CACHE_MAX_BYTES: usize = 160_000;',
    path,
)
text = replace_regex(
    text,
    r'''pub fn cache_image\(\n    cache_root: &Path,\n    sha256: &str,\n    mime_type: &str,\n    bytes: &\[u8\],\n\) -> Result<CachedPreview, String> \{.*?\n\}\n\npub fn cache_thumbnail''',
    '''pub fn cache_image(
    cache_root: &Path,
    sha256: &str,
    _mime_type: &str,
    bytes: &[u8],
) -> Result<CachedPreview, String> {
    validate_cache_input(sha256, bytes)?;
    let asset_dir = asset_cache_dir(cache_root, sha256)?;
    fs::create_dir_all(&asset_dir).map_err(|error| format!("无法创建图片缓存目录：{error}"))?;
    let image = image::load_from_memory(bytes)
        .map_err(|error| format!("无法解码图片以生成压缩缓存：{error}"))?;
    let display_path = encode_resized_image(
        &image,
        DISPLAY_EDGE,
        DISPLAY_JPEG_QUALITY,
        DISPLAY_CACHE_MAX_BYTES,
        &asset_dir,
        "original",
    )?;
    let thumbnail_path = encode_resized_image(
        &image,
        REMOTE_PREVIEW_EDGE,
        REMOTE_PREVIEW_JPEG_QUALITY,
        THUMBNAIL_CACHE_MAX_BYTES,
        &asset_dir,
        "preview",
    )?;

    cleanup_stale_files(&asset_dir, &[&display_path, &thumbnail_path]);
    let cache_bytes = combined_file_size(Some(&display_path), Some(&thumbnail_path))?;
    Ok(CachedPreview {
        original_path: Some(path_to_string(&display_path)),
        thumbnail_path: Some(path_to_string(&thumbnail_path)),
        cache_bytes,
        cached_at: Utc::now().to_rfc3339(),
    })
}

pub fn cache_thumbnail''',
    path,
)
text = replace_once(
    text,
    '''        Ok(image) => encode_resized_image(
            &image,
            REMOTE_PREVIEW_EDGE,
            REMOTE_PREVIEW_JPEG_QUALITY,
            &asset_dir,
            "preview",
        )?,
        Err(_) => {
            let path = asset_dir.join(format!("preview.{}", extension_for_mime(mime_type)));
            write_atomic(&path, bytes)?;
            path
        }''',
    '''        Ok(image) => encode_resized_image(
            &image,
            REMOTE_PREVIEW_EDGE,
            REMOTE_PREVIEW_JPEG_QUALITY,
            THUMBNAIL_CACHE_MAX_BYTES,
            &asset_dir,
            "preview",
        )?,
        Err(_) if bytes.len() <= THUMBNAIL_CACHE_MAX_BYTES => {
            let path = asset_dir.join(format!("preview.{}", extension_for_mime(mime_type)));
            write_atomic(&path, bytes)?;
            path
        }
        Err(error) => {
            return Err(format!("无法解码图片缓存，且源文件超过缩略图缓存上限：{error}"));
        }''',
    path,
)
text = replace_regex(
    text,
    r'''fn encode_resized_image\(\n    image: &DynamicImage,\n    max_edge: u32,\n    jpeg_quality: u8,\n    asset_dir: &Path,\n    stem: &str,\n\) -> Result<PathBuf, String> \{.*?\n\}\n\nfn cleanup_stale_files''',
    '''fn encode_resized_image(
    image: &DynamicImage,
    max_edge: u32,
    jpeg_quality: u8,
    max_bytes: usize,
    asset_dir: &Path,
    stem: &str,
) -> Result<PathBuf, String> {
    let mut edge = max_edge.max(320);
    let mut quality = jpeg_quality.max(38);
    let encoded = loop {
        let resized = image.thumbnail(edge, edge).to_rgb8();
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, quality)
            .encode_image(&DynamicImage::ImageRgb8(resized))
            .map_err(|error| format!("无法编码 JPEG 图片缓存：{error}"))?;
        if output.len() <= max_bytes || edge <= 320 {
            break output;
        }
        if quality > 52 {
            quality = quality.saturating_sub(8);
        } else {
            edge = (edge.saturating_mul(3) / 4).max(320);
            quality = jpeg_quality.min(72);
        }
    };

    let target = asset_dir.join(format!("{stem}.jpg"));
    write_atomic(&target, &encoded)?;
    Ok(target)
}

fn cleanup_stale_files''',
    path,
)
text = text.replace('fn preserves_exact_original_and_builds_display_preview()', 'fn builds_bounded_display_and_thumbnail_cache()', 1)
text = replace_once(
    text,
    '''        assert!(original.ends_with("original.png"));
        assert_eq!(fs::read(original).unwrap(), source);
        assert!(image::open(preview).unwrap().dimensions().0 <= DISPLAY_EDGE);
        assert!(image::open(preview).unwrap().dimensions().1 <= DISPLAY_EDGE);
        assert!(original_exists(Some(original)));''',
    '''        assert!(original.ends_with("original.jpg"));
        assert!(fs::metadata(original).unwrap().len() <= DISPLAY_CACHE_MAX_BYTES as u64);
        assert!(fs::metadata(preview).unwrap().len() <= THUMBNAIL_CACHE_MAX_BYTES as u64);
        assert!(cached.cache_bytes <= (DISPLAY_CACHE_MAX_BYTES + THUMBNAIL_CACHE_MAX_BYTES) as i64);
        assert!(image::open(preview).unwrap().dimensions().0 <= REMOTE_PREVIEW_EDGE);
        assert!(image::open(preview).unwrap().dimensions().1 <= REMOTE_PREVIEW_EDGE);
        assert!(original_exists(Some(original)));''',
    path,
)
write(path, text)


# Rust commands: opener, folders, tags, exact original save, plugin registration.
path = "src-tauri/src/lib.rs"
text = read(path)
text = replace_once(
    text,
    '''#[tauri::command]
fn list_assets(state: State<'_, AppState>) -> Result<Vec<AssetRecord>, String> {''',
    '''#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "外部链接无效。".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("仅允许使用系统浏览器打开 HTTP 或 HTTPS 链接。".into());
    }
    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("无法调用系统浏览器：{error}"))
}

#[tauri::command]
fn list_assets(state: State<'_, AppState>) -> Result<Vec<AssetRecord>, String> {''',
    path,
)
text = replace_once(
    text,
    '''#[tauri::command]
fn cache_stats(state: State<'_, AppState>) -> Result<CacheStats, String> {''',
    '''#[tauri::command]
fn list_library_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let _database_guard = state.try_database_read()?;
    database::list_library_folders(&state.database_path)
}

#[tauri::command]
fn create_library_folder(
    state: State<'_, AppState>,
    name: String,
) -> Result<String, String> {
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
fn cache_stats(state: State<'_, AppState>) -> Result<CacheStats, String> {''',
    path,
)

text = replace_regex(
    text,
    r'''#\[tauri::command\]\nfn save_original_image\(.*?\n\}\n\n#\[tauri::command\]\nasync fn upload_image''',
    '''#[tauri::command]
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

    let downloaded = match remote_preview::download_preview(
        preview_limiter,
        &asset.remote_url,
        true,
    )
    .await
    {
        Ok(image) => image,
        Err(public_error) => {
            let cookie = credentials::load(&asset.account_name)?;
            let original_url = remote_preview::original_image_url(&asset.remote_url)?;
            yuque::download_image(&cookie, &original_url)
                .await
                .map_err(|session_error| {
                    format!("原图下载失败：{public_error}；语雀会话回源失败：{session_error}")
                })?
        }
    };
    let saved_path = target.clone();
    tauri::async_runtime::spawn_blocking(move || {
        fs::write(&target, downloaded.bytes).map_err(|error| format!("保存原图失败：{error}"))
    })
    .await
    .map_err(|error| format!("保存原图任务失败：{error}"))??;

    Ok(SaveOriginalResult {
        cancelled: false,
        path: Some(saved_path.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
async fn upload_image''',
    path,
)

text = replace_once(
    text,
    '''        category,
        original_path: None,''',
    '''        category,
        tags: input.tags.clone(),
        original_path: None,''',
    path,
)
text = replace_once(
    text,
    '''            existing,
            category,
            sha256,''',
    '''            existing,
            category,
            input.tags.clone(),
            sha256,''',
    path,
)
text = replace_once(
    text,
    '''            existing,
            category,
            sha256,
            input.mime_type,''',
    '''            existing,
            category,
            input.tags.clone(),
            sha256,
            input.mime_type,''',
    path,
)
text = replace_once(
    text,
    '''    existing: AssetRecord,
    category: String,
    sha256: String,''',
    '''    existing: AssetRecord,
    category: String,
    tags: Vec<String>,
    sha256: String,''',
    path,
)
text = replace_once(
    text,
    '''    let existing = database::update_asset_category(&database_path, existing.id, &category)?;
    let original_missing = {''',
    '''    let existing = database::update_asset_category(&database_path, existing.id, &category)?;
    let existing = database::update_asset_tags(&database_path, existing.id, &tags)?;
    let original_missing = {''',
    path,
)
text = replace_once(
    text,
    '''        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {''',
    '''        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {''',
    path,
)
text = replace_once(
    text,
    '''            save_cookie,
            open_yuque_login,''',
    '''            save_cookie,
            open_external_url,
            open_yuque_login,''',
    path,
)
text = replace_once(
    text,
    '''            list_assets,
            update_asset_category,
            cache_stats,''',
    '''            list_assets,
            update_asset_category,
            list_library_folders,
            create_library_folder,
            list_asset_tags,
            update_asset_tags,
            cache_stats,''',
    path,
)
write(path, text)


# Yuque daily documents must be attached to the repository TOC.
path = "src-tauri/src/yuque_openapi.rs"
text = read(path)
text = replace_once(
    text,
    '''    pub title: String,
    pub body: String,
}''',
    '''    pub title: String,
    pub body: String,
    #[serde(default)]
    pub ensure_in_toc: bool,
}''',
    path,
)
text = replace_once(
    text,
    '''struct YuqueBook {
    id: Option<i64>,
    namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]''',
    '''struct YuqueBook {
    id: Option<i64>,
    namespace: Option<String>,
}

#[derive(Debug, Deserialize)]
struct YuqueTocNode {
    #[serde(default)]
    id: Option<i64>,
    #[serde(default)]
    doc_id: Option<i64>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    children: Vec<YuqueTocNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]''',
    path,
)
text = replace_once(
    text,
    '''        let updated = update_document(
            &client,
            &token,
            repo.id,
            existing.id,
            &existing.title,
            &merged_body,
        )
        .await?;
        return Ok(document_result(updated, &namespace, false));''',
    '''        let updated = update_document(
            &client,
            &token,
            repo.id,
            existing.id,
            &existing.title,
            &merged_body,
        )
        .await?;
        if input.ensure_in_toc {
            ensure_document_in_toc(&client, &token, repo.id, &updated).await?;
        }
        return Ok(document_result(updated, &namespace, false));''',
    path,
)
text = replace_once(
    text,
    '''    let created = create_document(&client, &token, repo.id, title, body).await?;
    Ok(document_result(created, &namespace, true))
}

async fn fetch_current_user''',
    '''    let created = create_document(&client, &token, repo.id, title, body).await?;
    if input.ensure_in_toc {
        ensure_document_in_toc(&client, &token, repo.id, &created).await?;
    }
    Ok(document_result(created, &namespace, true))
}

async fn ensure_document_in_toc(
    client: &Client,
    token: &str,
    repository_id: i64,
    document: &YuqueDocument,
) -> Result<(), String> {
    let endpoint = format!("{YUQUE_API_BASE}/repos/{repository_id}/toc");
    let text = request_text(
        client
            .get(&endpoint)
            .header("X-Auth-Token", token)
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| format!("读取语雀目录失败：{error}"))?,
        "读取语雀目录",
    )
    .await?;
    let nodes = serde_json::from_str::<YuqueApiResponse<Vec<YuqueTocNode>>>(&text)
        .map(|payload| payload.data)
        .map_err(|error| format!("解析语雀目录失败：{error}"))?;
    if toc_contains_document(&nodes, document) {
        return Ok(());
    }

    request_text(
        client
            .post(endpoint)
            .header("X-Auth-Token", token)
            .header(ACCEPT, "application/json")
            .json(&json!({
                "action": "appendNode",
                "action_mode": "child",
                "target_uuid": "",
                "type": "DOC",
                "title": document.title,
                "doc_id": document.id,
                "url": document.slug,
            }))
            .send()
            .await
            .map_err(|error| format!("将语雀文档插入目录失败：{error}"))?,
        "将语雀文档插入目录",
    )
    .await?;
    Ok(())
}

fn toc_contains_document(nodes: &[YuqueTocNode], document: &YuqueDocument) -> bool {
    nodes.iter().any(|node| {
        node.doc_id == Some(document.id)
            || node.id == Some(document.id)
            || node.url.as_deref() == Some(document.slug.as_str())
            || node.slug.as_deref() == Some(document.slug.as_str())
            || toc_contains_document(&node.children, document)
    })
}

async fn fetch_current_user''',
    path,
)
write(path, text)


# TypeScript contracts and invoke wrappers.
path = "src/types.ts"
text = read(path)
text = replace_once(
    text,
    '  category: string;\n  original_path: string | null;',
    '  category: string;\n  tags: string[];\n  original_path: string | null;',
    path,
)
text = replace_once(
    text,
    '  category: string;\n  createdAt: number;',
    '  category: string;\n  tags: string[];\n  createdAt: number;',
    path,
)
# There are two queue interfaces with the same shape.
text = replace_once(
    text,
    '  category: string;\n  createdAt: number;',
    '  category: string;\n  tags: string[];\n  createdAt: number;',
    path,
)
text = replace_once(
    text,
    '  body: string;\n}',
    '  body: string;\n  ensure_in_toc?: boolean;\n}',
    path,
)
write(path, text)

path = "src/lib/uploadQueueStore.ts"
text = read(path)
text = replace_once(
    text,
    '    category: item.category,\n    createdAt: item.createdAt,',
    '    category: item.category,\n    tags: item.tags,\n    createdAt: item.createdAt,',
    path,
)
write(path, text)

path = "src/lib/tauri.ts"
text = read(path)
text = replace_once(
    text,
    '''export async function listAssets(): Promise<AssetRecord[]> {
  return invoke<AssetRecord[]>('list_assets');
}

export async function deleteAsset''',
    '''export async function openExternalUrl(url: string): Promise<void> {
  return invoke('open_external_url', { url });
}

export async function listAssets(): Promise<AssetRecord[]> {
  return invoke<AssetRecord[]>('list_assets');
}

export async function listLibraryFolders(): Promise<string[]> {
  return invoke<string[]>('list_library_folders');
}

export async function createLibraryFolder(name: string): Promise<string> {
  return invoke<string>('create_library_folder', { name });
}

export async function listAssetTags(): Promise<string[]> {
  return invoke<string[]>('list_asset_tags');
}

export async function updateAssetTags(id: number, tags: string[]): Promise<AssetRecord> {
  return invoke<AssetRecord>('update_asset_tags', { id, tags });
}

export async function deleteAsset''',
    path,
)
text = replace_once(
    text,
    '''  height: number | null,
  category: string,
): Promise<UploadResult> {''',
    '''  height: number | null,
  category: string,
  tags: string[],
): Promise<UploadResult> {''',
    path,
)
text = replace_once(
    text,
    '''      category,
      attachable_id: context.attachable_id,''',
    '''      category,
      tags,
      attachable_id: context.attachable_id,''',
    path,
)
text = replace_once(
    text,
    '''        title,
        body: `# ${title}\\n\\n> QuePic 每日图片记录`,
      });''',
    '''        title,
        body: '> QuePic 每日图片记录',
        ensure_in_toc: true,
      });''',
    path,
)
text = replace_once(
    text,
    '''    title: document.title,
    body,
  });''',
    '''    title: document.title,
    body,
    ensure_in_toc: true,
  });''',
    path,
)
write(path, text)

print("backend patch applied")
