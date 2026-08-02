from pathlib import Path


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    start_index = text.index(start)
    end_index = text.index(end, start_index)
    file.write_text(text[:start_index] + replacement + text[end_index:], encoding="utf-8")


preview_source = r'''use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::Utc;
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat};

const DISPLAY_EDGE: u32 = 1_600;
const REMOTE_PREVIEW_EDGE: u32 = 640;
const DISPLAY_JPEG_QUALITY: u8 = 80;
const REMOTE_PREVIEW_JPEG_QUALITY: u8 = 76;

#[derive(Debug, Clone)]
pub struct CachedPreview {
    pub original_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub cache_bytes: i64,
    pub cached_at: String,
}

pub fn cache_image(
    cache_root: &Path,
    sha256: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<CachedPreview, String> {
    validate_cache_input(sha256, bytes)?;
    let asset_dir = asset_cache_dir(cache_root, sha256)?;
    fs::create_dir_all(&asset_dir).map_err(|error| format!("无法创建图片缓存目录：{error}"))?;

    let original_path = asset_dir.join(format!("original.{}", extension_for_mime(mime_type)));
    write_atomic(&original_path, bytes)?;
    let display_path = image::load_from_memory(bytes)
        .ok()
        .and_then(|image| {
            encode_resized_image(
                &image,
                DISPLAY_EDGE,
                DISPLAY_JPEG_QUALITY,
                &asset_dir,
                "preview",
            )
            .ok()
        })
        .unwrap_or_else(|| original_path.clone());

    cleanup_stale_files(&asset_dir, &[&original_path, &display_path]);
    let cache_bytes = combined_file_size(Some(&original_path), Some(&display_path))?;
    Ok(CachedPreview {
        original_path: Some(path_to_string(&original_path)),
        thumbnail_path: Some(path_to_string(&display_path)),
        cache_bytes,
        cached_at: Utc::now().to_rfc3339(),
    })
}

pub fn cache_thumbnail(
    cache_root: &Path,
    sha256: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<CachedPreview, String> {
    validate_cache_input(sha256, bytes)?;
    let asset_dir = asset_cache_dir(cache_root, sha256)?;
    fs::create_dir_all(&asset_dir).map_err(|error| format!("无法创建图片缓存目录：{error}"))?;

    let thumbnail_path = match image::load_from_memory(bytes) {
        Ok(image) => encode_resized_image(
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
        }
    };
    cleanup_stale_preview_files(&asset_dir, &thumbnail_path);
    Ok(CachedPreview {
        original_path: None,
        thumbnail_path: Some(path_to_string(&thumbnail_path)),
        cache_bytes: file_size(&thumbnail_path)?,
        cached_at: Utc::now().to_rfc3339(),
    })
}

pub fn original_exists(original_path: Option<&str>) -> bool {
    original_path
        .map(Path::new)
        .is_some_and(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.starts_with("original."))
        })
}

pub fn preview_exists(original_path: Option<&str>, thumbnail_path: Option<&str>) -> bool {
    original_exists(original_path)
        || thumbnail_path
            .map(Path::new)
            .map(Path::is_file)
            .unwrap_or(false)
}

pub fn remove_asset_cache(cache_root: &Path, sha256: &str) -> Result<(), String> {
    validate_sha256(sha256)?;
    let asset_dir = asset_cache_dir(cache_root, sha256)?;
    if asset_dir.exists() {
        fs::remove_dir_all(&asset_dir).map_err(|error| format!("无法删除图片缓存：{error}"))?;
    }
    remove_empty_parent(&asset_dir, cache_root);
    Ok(())
}

pub fn clear_cache(cache_root: &Path) -> Result<(), String> {
    if cache_root.exists() {
        fs::remove_dir_all(cache_root).map_err(|error| format!("无法清理图片缓存：{error}"))?;
    }
    fs::create_dir_all(cache_root).map_err(|error| format!("无法重新创建图片缓存目录：{error}"))
}

fn validate_cache_input(sha256: &str, bytes: &[u8]) -> Result<(), String> {
    validate_sha256(sha256)?;
    if bytes.is_empty() {
        return Err("无法缓存空图片。".into());
    }
    Ok(())
}

fn encode_resized_image(
    image: &DynamicImage,
    max_edge: u32,
    jpeg_quality: u8,
    asset_dir: &Path,
    stem: &str,
) -> Result<PathBuf, String> {
    let resized = image.thumbnail(max_edge, max_edge);
    let (extension, encoded) = if resized.color().has_alpha() {
        let mut output = Cursor::new(Vec::new());
        resized
            .write_to(&mut output, ImageFormat::WebP)
            .map_err(|error| format!("无法编码透明图片缓存：{error}"))?;
        ("webp", output.into_inner())
    } else {
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, jpeg_quality)
            .encode_image(&resized)
            .map_err(|error| format!("无法编码 JPEG 图片缓存：{error}"))?;
        ("jpg", output)
    };

    let target = asset_dir.join(format!("{stem}.{extension}"));
    write_atomic(&target, &encoded)?;
    Ok(target)
}

fn cleanup_stale_files(asset_dir: &Path, keep: &[&Path]) {
    let Ok(entries) = fs::read_dir(asset_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && !keep.iter().any(|candidate| **candidate == path) {
            let _ = fs::remove_file(path);
        }
    }
}

fn cleanup_stale_preview_files(asset_dir: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(asset_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_preview = path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("preview.") || value.starts_with("thumbnail."));
        if path.is_file() && is_preview && path != keep {
            let _ = fs::remove_file(path);
        }
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "图片缓存路径无效。".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = path.with_file_name(format!(".{file_name}.{nonce}.tmp"));
    let backup = path.with_file_name(format!(".{file_name}.{nonce}.bak"));

    fs::write(&temporary, bytes).map_err(|error| format!("无法写入图片缓存临时文件：{error}"))?;
    if !path.exists() {
        return fs::rename(&temporary, path)
            .map_err(|error| format!("无法提交图片缓存文件：{error}"));
    }

    fs::rename(path, &backup).map_err(|error| format!("无法备份旧图片缓存：{error}"))?;
    match fs::rename(&temporary, path) {
        Ok(()) => {
            let _ = fs::remove_file(backup);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&backup, path);
            let _ = fs::remove_file(temporary);
            Err(format!("无法提交图片缓存文件：{error}"))
        }
    }
}

fn combined_file_size(original: Option<&Path>, thumbnail: Option<&Path>) -> Result<i64, String> {
    let original_bytes = original.map(file_size).transpose()?.unwrap_or(0);
    let thumbnail_bytes = if original == thumbnail {
        0
    } else {
        thumbnail.map(file_size).transpose()?.unwrap_or(0)
    };
    Ok(original_bytes.saturating_add(thumbnail_bytes))
}

fn asset_cache_dir(cache_root: &Path, sha256: &str) -> Result<PathBuf, String> {
    validate_sha256(sha256)?;
    Ok(cache_root.join(&sha256[..2]).join(sha256))
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("图片摘要无效，拒绝访问缓存目录。".into());
    }
    Ok(())
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/tiff" => "tiff",
        "image/avif" => "avif",
        _ => "img",
    }
}

fn file_size(path: &Path) -> Result<i64, String> {
    let length = fs::metadata(path)
        .map_err(|error| format!("无法读取图片缓存大小：{error}"))?
        .len();
    Ok(i64::try_from(length).unwrap_or(i64::MAX))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn remove_empty_parent(asset_dir: &Path, cache_root: &Path) {
    if let Some(parent) = asset_dir.parent() {
        if parent != cache_root {
            let _ = fs::remove_dir(parent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgb, RgbImage};

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "quepic-preview-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn encoded_png(width: u32, height: u32) -> Vec<u8> {
        let mut source = RgbImage::new(width, height);
        for (x, y, pixel) in source.enumerate_pixels_mut() {
            *pixel = Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8]);
        }
        let source = DynamicImage::ImageRgb8(source);
        let mut encoded = Cursor::new(Vec::new());
        source.write_to(&mut encoded, ImageFormat::Png).unwrap();
        encoded.into_inner()
    }

    #[test]
    fn rejects_unsafe_cache_keys() {
        assert!(asset_cache_dir(Path::new("cache"), "../image").is_err());
        assert!(asset_cache_dir(Path::new("cache"), &"a".repeat(64)).is_ok());
    }

    #[test]
    fn preserves_exact_original_and_builds_display_preview() {
        let root = temp_root("original");
        let source = encoded_png(2_400, 1_600);
        let cached = cache_image(&root, &"b".repeat(64), "image/png", &source).unwrap();
        let original = cached.original_path.as_deref().unwrap();
        let preview = cached.thumbnail_path.as_deref().unwrap();
        assert!(original.ends_with("original.png"));
        assert_eq!(fs::read(original).unwrap(), source);
        assert!(image::open(preview).unwrap().dimensions().0 <= DISPLAY_EDGE);
        assert!(image::open(preview).unwrap().dimensions().1 <= DISPLAY_EDGE);
        assert!(original_exists(Some(original)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn thumbnail_cache_never_claims_an_original() {
        let root = temp_root("thumbnail");
        let source = encoded_png(1_800, 1_200);
        let cached = cache_thumbnail(&root, &"c".repeat(64), "image/png", &source).unwrap();
        assert!(cached.original_path.is_none());
        let thumbnail = cached.thumbnail_path.as_deref().unwrap();
        assert!(thumbnail.contains("preview."));
        assert!(image::open(thumbnail).unwrap().dimensions().0 <= REMOTE_PREVIEW_EDGE);
        assert!(!original_exists(Some(thumbnail)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn replaces_cache_file_without_losing_previous_content() {
        let root = temp_root("atomic");
        let path = root.join("image.bin");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        let _ = fs::remove_dir_all(root);
    }
}
'''
Path("src-tauri/src/preview.rs").write_text(preview_source, encoding="utf-8")

# Database: merge partial cache updates while preserving a true original.
database_path = Path("src-tauri/src/database.rs")
database_text = database_path.read_text(encoding="utf-8")
database_text = database_text.replace(
    "use std::{\n    path::Path,",
    "use std::{\n    fs,\n    path::Path,",
    1,
)
start = database_text.index("pub fn upsert_cached_preview(")
end = database_text.index("pub fn list_assets(", start)
database_replacement = r'''pub fn upsert_cached_preview(
    path: &Path,
    asset_id: i64,
    preview: &CachedPreview,
    source: &str,
) -> Result<(), String> {
    let connection = open_connection(path)?;
    let existing = connection
        .query_row(
            "SELECT original_path, thumbnail_path FROM asset_previews WHERE asset_id = ?1",
            [asset_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let original_path = preview.original_path.clone().or(existing.0);
    let thumbnail_path = preview.thumbnail_path.clone().or(existing.1);
    if original_path.is_none() && thumbnail_path.is_none() {
        return Err("图片缓存没有可用文件。".into());
    }
    let cache_bytes = combined_cache_bytes(original_path.as_deref(), thumbnail_path.as_deref());

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
                original_path,
                thumbnail_path,
                source,
                cache_bytes,
                &preview.cached_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn combined_cache_bytes(original_path: Option<&str>, thumbnail_path: Option<&str>) -> i64 {
    let original_bytes = original_path
        .and_then(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let thumbnail_bytes = if original_path == thumbnail_path {
        0
    } else {
        thumbnail_path
            .and_then(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    };
    i64::try_from(original_bytes.saturating_add(thumbnail_bytes)).unwrap_or(i64::MAX)
}

pub fn mark_preview_error(path: &Path, asset_id: i64, error: &str) -> Result<(), String> {
    let connection = open_connection(path)?;
    connection
        .execute(
            r#"
            INSERT INTO asset_previews (asset_id, preview_source, cache_status, last_error)
            VALUES (?1, 'missing', 'error', ?2)
            ON CONFLICT(asset_id) DO UPDATE SET
                preview_source = CASE
                    WHEN original_path IS NULL AND thumbnail_path IS NULL THEN 'missing'
                    ELSE preview_source
                END,
                cache_status = CASE
                    WHEN original_path IS NULL AND thumbnail_path IS NULL THEN 'error'
                    ELSE 'ready'
                END,
                last_error = excluded.last_error
            "#,
            params![asset_id, error],
        )
        .map_err(|value| value.to_string())?;
    Ok(())
}

'''
database_path.write_text(database_text[:start] + database_replacement + database_text[end:], encoding="utf-8")

# Backend: cache thumbnails separately, require a real original file, and never use transformed URLs as originals.
lib_path = Path("src-tauri/src/lib.rs")
lib_text = lib_path.read_text(encoding="utf-8")
ensure_start = lib_text.index("#[tauri::command]\nasync fn ensure_preview(")
ensure_end = lib_text.index("#[derive(Debug, Serialize)]\nstruct SaveOriginalResult", ensure_start)
ensure_replacement = r'''#[tauri::command]
async fn ensure_preview(
    state: State<'_, AppState>,
    asset_id: i64,
    prefer_original: bool,
    allow_wordpress_fallback: bool,
    force_refresh: bool,
) -> Result<PreviewResult, String> {
    let database_path = state.database_path.clone();
    let preview_cache_dir = state.preview_cache_dir.clone();
    let cache_lock = state.cache_lock.clone();
    let preview_limiter = state.preview_limiter.clone();
    drop(state);

    let asset = database::find_by_id(&database_path, asset_id)?
        .ok_or_else(|| "图片记录不存在。".to_string())?;

    if !force_refresh {
        let existing = {
            let _guard = cache_lock
                .lock()
                .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
            existing_local_path(&asset, prefer_original)
        };
        if let Some(path) = existing {
            return Ok(local_preview_result(asset_id, path, "local"));
        }
    }

    let public_error = match remote_preview::download_preview(
        preview_limiter,
        &asset.remote_url,
        prefer_original,
    )
    .await
    {
        Ok(downloaded) => {
            let cached = cache_preview_variant_task(
                cache_lock.clone(),
                preview_cache_dir.clone(),
                database_path.clone(),
                asset_id,
                asset.sha256.clone(),
                downloaded.mime_type,
                downloaded.bytes,
                "remote_url".into(),
                prefer_original,
            )
            .await?;
            let path = cached_path(&cached, prefer_original)?;
            return Ok(local_preview_result(asset_id, path, "remote_url"));
        }
        Err(error) => error,
    };

    let session_url = if prefer_original {
        remote_preview::original_image_url(&asset.remote_url)?
    } else {
        asset.remote_url.clone()
    };
    let session_result = match credentials::load(&asset.account_name) {
        Ok(cookie) => yuque::download_image(&cookie, &session_url).await,
        Err(error) => Err(error),
    };

    match session_result {
        Ok(downloaded) => {
            let cached = cache_preview_variant_task(
                cache_lock,
                preview_cache_dir,
                database_path.clone(),
                asset_id,
                asset.sha256,
                downloaded.mime_type,
                downloaded.bytes,
                "yuque_session".into(),
                prefer_original,
            )
            .await?;
            let path = cached_path(&cached, prefer_original)?;
            Ok(local_preview_result(asset_id, path, "yuque_session"))
        }
        Err(session_error) => {
            let combined_error = format!("{public_error}；语雀会话回源失败：{session_error}");
            let _ = database::mark_preview_error(&database_path, asset_id, &combined_error);
            if allow_wordpress_fallback && !prefer_original {
                let proxy_url = yuque::wordpress_proxy_url(&asset.remote_url, Some(640))?;
                return Ok(PreviewResult {
                    asset_id,
                    local_path: None,
                    proxy_url: Some(proxy_url),
                    source: "wordpress_proxy".into(),
                    cached: false,
                    last_error: Some(combined_error),
                });
            }
            Err(combined_error)
        }
    }
}

'''
lib_text = lib_text[:ensure_start] + ensure_replacement + lib_text[ensure_end:]
lib_text = lib_text.replace(
    '.filter(|path| Path::new(path).is_file())\n        .ok_or_else(|| "原图尚未缓存，请先打开“原图显示”，等待加载完成后再保存。".to_string())?;',
    '.filter(|path| preview::original_exists(Some(path)))\n        .ok_or_else(|| "原图尚未缓存，请先打开“原图显示”，等待加载完成后再保存。".to_string())?;',
    1,
)
reuse_start = lib_text.index("async fn reuse_existing_asset(")
reuse_end = lib_text.index("async fn cache_and_record_task(", reuse_start)
reuse_replacement = r'''async fn reuse_existing_asset(
    cache_lock: Arc<Mutex<()>>,
    preview_cache_dir: PathBuf,
    database_path: PathBuf,
    existing: AssetRecord,
    category: String,
    sha256: String,
    mime_type: String,
    cache_bytes: Vec<u8>,
) -> Result<UploadResult, String> {
    let existing = database::update_asset_category(&database_path, existing.id, &category)?;
    let original_missing = {
        let _guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        !preview::original_exists(existing.original_path.as_deref())
    };

    if original_missing {
        let _ = cache_and_record_task(
            cache_lock,
            preview_cache_dir,
            database_path.clone(),
            existing.id,
            sha256,
            mime_type,
            cache_bytes,
            "local".into(),
        )
        .await;
    }

    let asset = database::find_by_id(&database_path, existing.id)?.unwrap_or(existing);
    Ok(UploadResult {
        asset,
        deduplicated: true,
    })
}

'''
lib_text = lib_text[:reuse_start] + reuse_replacement + lib_text[reuse_end:]
cache_start = lib_text.index("async fn cache_and_record_task(")
cache_end = lib_text.index("fn shared_cache_stats(", cache_start)
cache_replacement = r'''async fn cache_and_record_task(
    cache_lock: Arc<Mutex<()>>,
    cache_dir: PathBuf,
    database_path: PathBuf,
    asset_id: i64,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
    source: String,
) -> Result<CachedPreview, String> {
    cache_preview_task(
        cache_lock,
        cache_dir,
        database_path,
        asset_id,
        sha256,
        mime_type,
        bytes,
        source,
        true,
    )
    .await
}

async fn cache_thumbnail_and_record_task(
    cache_lock: Arc<Mutex<()>>,
    cache_dir: PathBuf,
    database_path: PathBuf,
    asset_id: i64,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
    source: String,
) -> Result<CachedPreview, String> {
    cache_preview_task(
        cache_lock,
        cache_dir,
        database_path,
        asset_id,
        sha256,
        mime_type,
        bytes,
        source,
        false,
    )
    .await
}

async fn cache_preview_variant_task(
    cache_lock: Arc<Mutex<()>>,
    cache_dir: PathBuf,
    database_path: PathBuf,
    asset_id: i64,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
    source: String,
    original: bool,
) -> Result<CachedPreview, String> {
    if original {
        cache_and_record_task(
            cache_lock,
            cache_dir,
            database_path,
            asset_id,
            sha256,
            mime_type,
            bytes,
            source,
        )
        .await
    } else {
        cache_thumbnail_and_record_task(
            cache_lock,
            cache_dir,
            database_path,
            asset_id,
            sha256,
            mime_type,
            bytes,
            source,
        )
        .await
    }
}

async fn cache_preview_task(
    cache_lock: Arc<Mutex<()>>,
    cache_dir: PathBuf,
    database_path: PathBuf,
    asset_id: i64,
    sha256: String,
    mime_type: String,
    bytes: Vec<u8>,
    source: String,
    original: bool,
) -> Result<CachedPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = cache_lock
            .lock()
            .map_err(|_| "图片缓存锁已损坏，请重启 QuePic。".to_string())?;
        if database::find_by_id(&database_path, asset_id)?.is_none() {
            return Err("图片记录已删除，已取消建立缓存。".into());
        }
        let cached = if original {
            preview::cache_image(&cache_dir, &sha256, &mime_type, &bytes)?
        } else {
            preview::cache_thumbnail(&cache_dir, &sha256, &mime_type, &bytes)?
        };
        database::upsert_cached_preview(&database_path, asset_id, &cached, &source)
            .map_err(|error| format!("图片缓存已生成，但保存缓存索引失败：{error}"))?;
        Ok(cached)
    })
    .await
    .map_err(|error| format!("建立图片缓存任务失败：{error}"))?
}

fn cached_path(preview: &CachedPreview, prefer_original: bool) -> Result<String, String> {
    let path = if prefer_original {
        preview.original_path.as_ref()
    } else {
        preview.thumbnail_path.as_ref()
    };
    path.cloned().ok_or_else(|| {
        if prefer_original {
            "原图缓存没有生成有效文件。".to_string()
        } else {
            "图片预览缓存没有生成有效文件。".to_string()
        }
    })
}

'''
lib_text = lib_text[:cache_start] + cache_replacement + lib_text[cache_end:]
local_start = lib_text.index("fn existing_local_path(")
local_end = lib_text.index("fn local_preview_result(", local_start)
local_replacement = r'''fn existing_local_path(asset: &AssetRecord, prefer_original: bool) -> Option<String> {
    if prefer_original {
        return asset
            .original_path
            .as_deref()
            .filter(|path| preview::original_exists(Some(path)))
            .map(ToOwned::to_owned);
    }

    [
        asset.thumbnail_path.as_deref(),
        asset.original_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find(|path| Path::new(path).is_file())
    .map(ToOwned::to_owned)
}

'''
lib_path.write_text(lib_text[:local_start] + local_replacement + lib_text[local_end:], encoding="utf-8")

# Remote preview: strip OSS transformation parameters before claiming an original.
remote_path = Path("src-tauri/src/remote_preview.rs")
remote_text = remote_path.read_text(encoding="utf-8")
remote_text = remote_text.replace(
    "    let normalized = normalize_remote_url(remote_url)?;\n    let candidates = preview_candidates(&normalized, prefer_original);",
    "    let normalized = normalize_remote_url(remote_url)?;\n    let candidates = preview_candidates(&normalized, prefer_original);",
    1,
)
preview_candidates_start = remote_text.index("fn preview_candidates(")
preview_candidates_end = remote_text.index("fn normalize_remote_url(", preview_candidates_start)
preview_candidates_replacement = r'''fn preview_candidates(url: &Url, prefer_original: bool) -> Vec<Url> {
    if prefer_original {
        return vec![without_image_transform(url)];
    }

    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let has_transform = url.query_pairs().any(|(key, _)| key == "x-oss-process");
    let mut candidates = Vec::new();
    if (host == "nlark.com" || host.ends_with(".nlark.com")) && !has_transform {
        let mut optimized = url.clone();
        optimized
            .query_pairs_mut()
            .append_pair("x-oss-process", "image/resize,w_640,limit_1/format,webp");
        candidates.push(optimized);
    }
    candidates.push(url.clone());
    candidates
}

pub fn original_image_url(raw_url: &str) -> Result<String, String> {
    Ok(without_image_transform(&normalize_remote_url(raw_url)?).to_string())
}

fn without_image_transform(url: &Url) -> Url {
    let retained = url
        .query_pairs()
        .filter(|(key, _)| key != "x-oss-process")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let mut original = url.clone();
    original.set_query(None);
    if !retained.is_empty() {
        let mut pairs = original.query_pairs_mut();
        for (key, value) in retained {
            pairs.append_pair(&key, &value);
        }
    }
    original
}

'''
remote_text = remote_text[:preview_candidates_start] + preview_candidates_replacement + remote_text[preview_candidates_end:]
remote_text = remote_text.replace(
    "    use super::{normalize_remote_url, preview_candidates};",
    "    use super::{normalize_remote_url, original_image_url, preview_candidates};",
    1,
)
remote_text = remote_text.replace(
    "    fn uses_original_url_only_for_detail_preview() {\n        let url = normalize_remote_url(\"https://cdn.nlark.com/yuque/test.png\").unwrap();\n        assert_eq!(preview_candidates(&url, true), vec![url]);\n    }",
    "    fn strips_transform_for_original_download() {\n        let raw = \"https://cdn.nlark.com/yuque/test.png?token=abc&x-oss-process=image/resize,w_640\";\n        let original = original_image_url(raw).unwrap();\n        assert!(original.contains(\"token=abc\"));\n        assert!(!original.contains(\"x-oss-process\"));\n        let url = normalize_remote_url(raw).unwrap();\n        assert_eq!(preview_candidates(&url, true)[0].as_str(), original);\n    }",
    1,
)
remote_path.write_text(remote_text, encoding="utf-8")

# Backup restore: legacy preview.* files are thumbnails, only original.* is a true original.
backup_path = Path("src-tauri/src/backup.rs")
backup_text = backup_path.read_text(encoding="utf-8")
reindex_start = backup_text.index("fn reindex_cache(")
reindex_end = backup_text.index("fn find_cache_file(", reindex_start)
reindex_replacement = r'''fn reindex_cache(database_path: &Path, cache_root: &Path) -> Result<(), String> {
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

'''
backup_path.write_text(backup_text[:reindex_start] + reindex_replacement + backup_text[reindex_end:], encoding="utf-8")

# The detail drawer uses the lightweight preview; the dedicated viewer is the only full-original path.
app_path = Path("src/App.tsx")
app_text = app_path.read_text(encoding="utf-8")
app_text = app_text.replace(
    '<AssetPreview asset={selected} preferOriginal allowWordpressFallback={allowWordpressFallback}',
    '<AssetPreview asset={selected} allowWordpressFallback={allowWordpressFallback}',
    1,
)
app_text = app_text.replace(
    '<ExternalLink size={16} />浏览器打开</button>',
    '<ExternalLink size={16} />浏览器打开（可能下载）</button>',
    1,
)
app_path.write_text(app_text, encoding="utf-8")

print("original cache review fixes applied")
