use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::Utc;
use image::ImageFormat;

const THUMBNAIL_EDGE: u32 = 512;

#[derive(Debug, Clone)]
pub struct CachedPreview {
    pub original_path: String,
    pub thumbnail_path: String,
    pub cache_bytes: i64,
    pub cached_at: String,
}

pub fn cache_image(
    cache_root: &Path,
    sha256: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<CachedPreview, String> {
    validate_sha256(sha256)?;
    if bytes.is_empty() {
        return Err("无法缓存空图片。".into());
    }

    let asset_dir = asset_cache_dir(cache_root, sha256)?;
    fs::create_dir_all(&asset_dir).map_err(|error| format!("无法创建图片缓存目录：{error}"))?;

    let original_path = asset_dir.join(format!("original.{}", extension_for_mime(mime_type)));
    write_atomic(&original_path, bytes)?;

    let thumbnail_path = match generate_thumbnail(bytes, &asset_dir.join("thumbnail.png")) {
        Ok(path) => path,
        Err(_) => original_path.clone(),
    };

    let original_bytes = file_size(&original_path)?;
    let thumbnail_bytes = if thumbnail_path == original_path {
        0
    } else {
        file_size(&thumbnail_path)?
    };

    Ok(CachedPreview {
        original_path: path_to_string(&original_path),
        thumbnail_path: path_to_string(&thumbnail_path),
        cache_bytes: original_bytes.saturating_add(thumbnail_bytes),
        cached_at: Utc::now().to_rfc3339(),
    })
}

pub fn preview_exists(original_path: Option<&str>, thumbnail_path: Option<&str>) -> bool {
    let original_exists = original_path
        .map(Path::new)
        .map(Path::is_file)
        .unwrap_or(false);
    let thumbnail_exists = thumbnail_path
        .map(Path::new)
        .map(Path::is_file)
        .unwrap_or(false);
    original_exists || thumbnail_exists
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

fn generate_thumbnail(bytes: &[u8], target: &Path) -> Result<PathBuf, String> {
    let image = image::load_from_memory(bytes).map_err(|error| format!("无法解析图片以生成缩略图：{error}"))?;
    let thumbnail = image.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE);
    let mut output = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|error| format!("无法编码图片缩略图：{error}"))?;
    write_atomic(target, output.get_ref())?;
    Ok(target.to_path_buf())
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

    #[test]
    fn rejects_unsafe_cache_keys() {
        assert!(asset_cache_dir(Path::new("cache"), "../image").is_err());
        assert!(asset_cache_dir(Path::new("cache"), &"a".repeat(64)).is_ok());
    }

    #[test]
    fn maps_common_mime_extensions() {
        assert_eq!(extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(extension_for_mime("image/svg+xml"), "svg");
        assert_eq!(extension_for_mime("application/octet-stream"), "img");
    }

    #[test]
    fn replaces_cache_file_without_losing_previous_content() {
        let root = std::env::temp_dir().join(format!(
            "quepic-preview-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("image.bin");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        let _ = fs::remove_dir_all(root);
    }
}
