use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::Utc;
use image::{codecs::jpeg::JpegEncoder, DynamicImage, Rgb, RgbImage};

const DISPLAY_EDGE: u32 = 2_400;
const REMOTE_PREVIEW_EDGE: u32 = 720;
const DISPLAY_JPEG_QUALITY: u8 = 82;
const REMOTE_PREVIEW_JPEG_QUALITY: u8 = 72;
const DISPLAY_CACHE_MAX_BYTES: usize = 820_000;
const THUMBNAIL_CACHE_MAX_BYTES: usize = 160_000;

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
            return Err(format!(
                "无法解码图片缓存，且源文件超过缩略图缓存上限：{error}"
            ));
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
    original_path.map(Path::new).is_some_and(|path| {
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
    max_bytes: usize,
    asset_dir: &Path,
    stem: &str,
) -> Result<PathBuf, String> {
    let mut edge = max_edge.max(320);
    let mut quality = jpeg_quality.max(38);
    let encoded = loop {
        let resized = flatten_on_white(image, edge);
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, quality)
            .encode_image(&DynamicImage::ImageRgb8(resized))
            .map_err(|error| format!("无法编码 JPEG 图片缓存：{error}"))?;
        if output.len() <= max_bytes {
            break output;
        }
        if quality > 38 {
            quality = quality.saturating_sub(8).max(38);
            continue;
        }
        if edge > 320 {
            edge = (edge.saturating_mul(3) / 4).max(320);
            quality = jpeg_quality.min(64).max(38);
            continue;
        }
        return Err(format!(
            "图片在最低缓存尺寸和质量下仍超过 {} KB，已拒绝写入超限缓存。",
            max_bytes / 1024
        ));
    };

    let target = asset_dir.join(format!("{stem}.jpg"));
    write_atomic(&target, &encoded)?;
    Ok(target)
}

fn flatten_on_white(image: &DynamicImage, max_edge: u32) -> RgbImage {
    let rgba = image.thumbnail(max_edge, max_edge).to_rgba8();
    let mut flattened = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u16::from(pixel[3]);
        let blend =
            |channel: u8| ((u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        flattened.put_pixel(
            x,
            y,
            Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
        );
    }
    flattened
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
    use std::io::Cursor;

    use image::{GenericImageView, ImageFormat, Rgba, RgbaImage};

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
    fn builds_bounded_display_and_thumbnail_cache() {
        let root = temp_root("original");
        let source = encoded_png(2_400, 1_600);
        let cached = cache_image(&root, &"b".repeat(64), "image/png", &source).unwrap();
        let original = cached.original_path.as_deref().unwrap();
        let preview = cached.thumbnail_path.as_deref().unwrap();
        assert!(original.ends_with("original.jpg"));
        assert!(fs::metadata(original).unwrap().len() <= DISPLAY_CACHE_MAX_BYTES as u64);
        assert!(fs::metadata(preview).unwrap().len() <= THUMBNAIL_CACHE_MAX_BYTES as u64);
        assert!(cached.cache_bytes <= (DISPLAY_CACHE_MAX_BYTES + THUMBNAIL_CACHE_MAX_BYTES) as i64);
        assert!(image::open(preview).unwrap().dimensions().0 <= REMOTE_PREVIEW_EDGE);
        assert!(image::open(preview).unwrap().dimensions().1 <= REMOTE_PREVIEW_EDGE);
        assert!(original_exists(Some(original)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transparent_pixels_are_composited_on_white() {
        let mut source = RgbaImage::new(8, 8);
        for pixel in source.pixels_mut() {
            *pixel = Rgba([255, 0, 0, 0]);
        }
        let flattened = flatten_on_white(&DynamicImage::ImageRgba8(source), 8);
        assert_eq!(flattened.get_pixel(0, 0).0, [255, 255, 255]);
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
