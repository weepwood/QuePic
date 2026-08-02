use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::Utc;
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageFormat};

const PREVIEW_EDGE: u32 = 1_600;
const THUMBNAIL_EDGE: u32 = 320;
const PREVIEW_JPEG_QUALITY: u8 = 80;
const THUMBNAIL_JPEG_QUALITY: u8 = 72;

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

    let (preview_path, thumbnail_path) = if should_preserve_source(mime_type) {
        cache_preserved_source(&asset_dir, mime_type, bytes)?
    } else {
        match image::load_from_memory(bytes) {
            Ok(image) => cache_compact_raster(&asset_dir, &image)?,
            Err(_) => cache_preserved_source(&asset_dir, mime_type, bytes)?,
        }
    };

    cleanup_stale_files(&asset_dir, &[&preview_path, &thumbnail_path]);

    let preview_bytes = file_size(&preview_path)?;
    let thumbnail_bytes = if thumbnail_path == preview_path {
        0
    } else {
        file_size(&thumbnail_path)?
    };

    Ok(CachedPreview {
        original_path: path_to_string(&preview_path),
        thumbnail_path: path_to_string(&thumbnail_path),
        cache_bytes: preview_bytes.saturating_add(thumbnail_bytes),
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

fn cache_compact_raster(
    asset_dir: &Path,
    image: &DynamicImage,
) -> Result<(PathBuf, PathBuf), String> {
    let preview_path = encode_resized_image(
        image,
        PREVIEW_EDGE,
        PREVIEW_JPEG_QUALITY,
        asset_dir,
        "preview",
    )?;
    let thumbnail_path = encode_resized_image(
        image,
        THUMBNAIL_EDGE,
        THUMBNAIL_JPEG_QUALITY,
        asset_dir,
        "thumbnail",
    )?;
    Ok((preview_path, thumbnail_path))
}

fn cache_preserved_source(
    asset_dir: &Path,
    mime_type: &str,
    bytes: &[u8],
) -> Result<(PathBuf, PathBuf), String> {
    let preview_path = asset_dir.join(format!("preview.{}", extension_for_mime(mime_type)));
    write_atomic(&preview_path, bytes)?;

    let thumbnail_path = image::load_from_memory(bytes)
        .ok()
        .and_then(|image| {
            encode_resized_image(
                &image,
                THUMBNAIL_EDGE,
                THUMBNAIL_JPEG_QUALITY,
                asset_dir,
                "thumbnail",
            )
            .ok()
        })
        .unwrap_or_else(|| preview_path.clone());

    Ok((preview_path, thumbnail_path))
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

fn should_preserve_source(mime_type: &str) -> bool {
    matches!(mime_type, "image/gif" | "image/svg+xml" | "image/avif")
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
    fn compacts_large_opaque_images_into_two_smaller_jpegs() {
        let root = temp_root("compact");
        let mut source = RgbImage::new(2_400, 1_600);
        for (x, y, pixel) in source.enumerate_pixels_mut() {
            *pixel = Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8]);
        }
        let source = DynamicImage::ImageRgb8(source);
        let mut encoded_source = Cursor::new(Vec::new());
        source
            .write_to(&mut encoded_source, ImageFormat::Png)
            .unwrap();

        let cached = cache_image(
            &root,
            &"b".repeat(64),
            "image/png",
            encoded_source.get_ref(),
        )
        .unwrap();
        assert!(cached.original_path.ends_with("preview.jpg"));
        assert!(cached.thumbnail_path.ends_with("thumbnail.jpg"));
        assert!(cached.cache_bytes < encoded_source.get_ref().len() as i64);
        assert!(image::open(&cached.original_path).unwrap().dimensions().0 <= PREVIEW_EDGE);
        assert!(image::open(&cached.original_path).unwrap().dimensions().1 <= PREVIEW_EDGE);
        assert!(image::open(&cached.thumbnail_path).unwrap().dimensions().0 <= THUMBNAIL_EDGE);
        assert!(image::open(&cached.thumbnail_path).unwrap().dimensions().1 <= THUMBNAIL_EDGE);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_special_formats_and_removes_legacy_files_after_success() {
        let root = temp_root("preserve");
        let sha = "c".repeat(64);
        let asset_dir = asset_cache_dir(&root, &sha).unwrap();
        fs::create_dir_all(&asset_dir).unwrap();
        fs::write(asset_dir.join("original.gif"), b"legacy").unwrap();

        let cached = cache_image(
            &root,
            &sha,
            "image/svg+xml",
            b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
        )
        .unwrap();
        assert!(cached.original_path.ends_with("preview.svg"));
        assert_eq!(cached.original_path, cached.thumbnail_path);
        assert!(!asset_dir.join("original.gif").exists());
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
