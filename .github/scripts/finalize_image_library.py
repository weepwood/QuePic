from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}\n--- old ---\n{old}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


# Ensure the new gallery rules win over legacy ratio/viewer rules.
replace_once(
    'src/main.tsx',
    "import './queue-library.css';\nimport './library-overhaul.css';\nimport './account-backup.css';\nimport './ui-polish.css';\n// 原图查看器、图库比例和自动文档提示统一在视觉修正层之后加载。\nimport './original-viewer.css';\n",
    "import './queue-library.css';\nimport './account-backup.css';\nimport './ui-polish.css';\n// 原图查看器、图库比例和自动文档提示统一在视觉修正层之后加载。\nimport './original-viewer.css';\n// 新图库布局必须最后加载，以覆盖旧网格和详情预览规则。\nimport './library-overhaul.css';\n",
)

# Preserve transparent-image appearance by compositing onto white before JPEG encoding,
# and enforce the configured byte ceiling rather than silently returning an oversized file.
replace_once(
    'src-tauri/src/preview.rs',
    'use image::{codecs::jpeg::JpegEncoder, DynamicImage};',
    'use image::{codecs::jpeg::JpegEncoder, DynamicImage, Rgb, RgbImage};',
)
replace_once(
    'src-tauri/src/preview.rs',
    '''    let encoded = loop {
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
    };''',
    '''    let encoded = loop {
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
    };''',
)
replace_once(
    'src-tauri/src/preview.rs',
    '''fn cleanup_stale_files(asset_dir: &Path, keep: &[&Path]) {''',
    '''fn flatten_on_white(image: &DynamicImage, max_edge: u32) -> RgbImage {
    let rgba = image.thumbnail(max_edge, max_edge).to_rgba8();
    let mut flattened = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u16::from(pixel[3]);
        let blend = |channel: u8| {
            ((u16::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        };
        flattened.put_pixel(x, y, Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]));
    }
    flattened
}

fn cleanup_stale_files(asset_dir: &Path, keep: &[&Path]) {''',
)
replace_once(
    'src-tauri/src/preview.rs',
    '    use image::{GenericImageView, Rgb, RgbImage};',
    '    use std::io::Cursor;\n\n    use image::{GenericImageView, ImageFormat, Rgba, RgbaImage};',
)
replace_once(
    'src-tauri/src/preview.rs',
    '''    #[test]
    fn thumbnail_cache_never_claims_an_original() {''',
    '''    #[test]
    fn transparent_pixels_are_composited_on_white() {
        let mut source = RgbaImage::new(8, 8);
        for pixel in source.pixels_mut() {
            *pixel = Rgba([255, 0, 0, 0]);
        }
        let flattened = flatten_on_white(&DynamicImage::ImageRgba8(source), 8);
        assert_eq!(flattened.get_pixel(0, 0).0, [255, 255, 255]);
    }

    #[test]
    fn thumbnail_cache_never_claims_an_original() {''',
)

# Strengthen folder/tag persistence coverage.
replace_once(
    'src-tauri/src/database.rs',
    '''        let asset = insert_asset(&path, &test_asset("default")).unwrap();
        assert_eq!(asset.category, "测试");
        let updated = update_asset_category(&path, asset.id, "截图").unwrap();
        assert_eq!(updated.category, "截图");
        cleanup_database(&path);''',
    '''        let asset = insert_asset(&path, &test_asset("default")).unwrap();
        assert_eq!(asset.category, "测试");
        assert_eq!(asset.tags, vec!["演示"]);
        assert!(list_library_folders(&path).unwrap().contains(&"测试".to_string()));

        let updated = update_asset_category(&path, asset.id, "截图").unwrap();
        assert_eq!(updated.category, "截图");
        assert!(list_library_folders(&path).unwrap().contains(&"截图".to_string()));

        let retagged = update_asset_tags(
            &path,
            asset.id,
            &["参考".into(), "参考".into(), " UI ".into()],
        )
        .unwrap();
        assert_eq!(retagged.tags, vec!["UI", "参考"]);
        assert_eq!(list_asset_tags(&path).unwrap(), vec!["UI", "参考"]);
        cleanup_database(&path);''',
)

# Cover recursive Yuque TOC detection without making a network request.
replace_once(
    'src-tauri/src/yuque_openapi.rs',
    '''        append_markdown, build_document_url, extract_error_message, openapi_default_headers,
        parse_yuque_url, validate_account_name, validate_namespace, value_to_i64,
        BROWSER_ACCEPT_LANGUAGE, BROWSER_USER_AGENT,''',
    '''        append_markdown, build_document_url, extract_error_message, openapi_default_headers,
        parse_yuque_url, toc_contains_document, validate_account_name, validate_namespace,
        value_to_i64, YuqueDocument, YuqueTocNode, BROWSER_ACCEPT_LANGUAGE, BROWSER_USER_AGENT,''',
)
replace_once(
    'src-tauri/src/yuque_openapi.rs',
    '''    #[test]
    fn builds_document_url_from_namespace() {''',
    '''    #[test]
    fn finds_document_in_nested_repository_toc() {
        let document = YuqueDocument {
            id: 42,
            title: "每日图片 2026-08-02".into(),
            slug: "daily-2026-08-02".into(),
            format: Some("markdown".into()),
            body: None,
            body_draft: None,
            book_id: Some(7),
            book: None,
            updated_at: None,
            content_updated_at: None,
            word_count: None,
        };
        let nodes = vec![YuqueTocNode {
            id: None,
            doc_id: None,
            url: None,
            slug: None,
            children: vec![YuqueTocNode {
                id: None,
                doc_id: Some(42),
                url: Some("daily-2026-08-02".into()),
                slug: None,
                children: Vec::new(),
            }],
        }];
        assert!(toc_contains_document(&nodes, &document));
    }

    #[test]
    fn builds_document_url_from_namespace() {''',
)

# This repository intentionally does not commit dependency lockfiles yet.
Path('src-tauri/Cargo.lock').unlink(missing_ok=True)
print('final image library review fixes applied')
