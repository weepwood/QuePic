from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        if new in text:
            return text
        raise RuntimeError(f"missing replacement target: {label}")
    return text.replace(old, new, 1)


tauri_path = Path("src/lib/tauri.ts")
tauri_text = tauri_path.read_text(encoding="utf-8")
tauri_text = replace_once(
    tauri_text,
    """  const assetIds = [...new Set(images.map((image) => image.asset_id))].sort((left, right) => left - right);
  const batchMarker = `<!-- quepic-daily:${assetIds.join(',')} -->`;
  const body = [
    batchMarker,
    `## ${time}`,
    '',
    ...images.flatMap((image) => [
      `![${escapeMarkdownAlt(image.file_name)}](${image.remote_url})`,
      '',
    ]),
  ].join('\\n').trim();""",
    """  const body = [
    `## ${time}`,
    '',
    ...images.flatMap((image) => [
      `<!-- quepic-image:${image.asset_id} -->`,
      `![${escapeMarkdownAlt(image.file_name)}](${image.remote_url})`,
      '',
    ]),
  ].join('\\n').trim();""",
    "per-image daily markers",
)
tauri_path.write_text(tauri_text, encoding="utf-8")


yuque_path = Path("src-tauri/src/yuque_openapi.rs")
yuque_text = yuque_path.read_text(encoding="utf-8")
start = yuque_text.index("fn append_markdown(")
end = yuque_text.index("fn document_result(", start)
replacement = r'''fn append_markdown(existing: Option<&str>, addition: &str) -> String {
    let existing = existing.unwrap_or_default().trim();
    let addition = filter_new_daily_images(existing, addition);
    if addition.is_empty() {
        return existing.to_string();
    }
    if existing.is_empty() {
        addition
    } else {
        format!("{existing}\n\n{addition}")
    }
}

fn filter_new_daily_images(existing: &str, addition: &str) -> String {
    let lines = addition.lines().collect::<Vec<_>>();
    let marker_indexes = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| is_daily_image_marker(line.trim()).then_some(index))
        .collect::<Vec<_>>();
    if marker_indexes.is_empty() {
        return addition.trim().to_string();
    }

    let preamble = lines[..marker_indexes[0]].join("\n").trim().to_string();
    let mut blocks = Vec::new();
    for (position, start) in marker_indexes.iter().copied().enumerate() {
        let end = marker_indexes.get(position + 1).copied().unwrap_or(lines.len());
        let marker = lines[start].trim();
        if existing.contains(marker) {
            continue;
        }
        let block = lines[start..end].join("\n").trim().to_string();
        if !block.is_empty() {
            blocks.push(block);
        }
    }
    if blocks.is_empty() {
        return String::new();
    }

    let mut parts = Vec::with_capacity(blocks.len() + 1);
    if !preamble.is_empty() {
        parts.push(preamble);
    }
    parts.extend(blocks);
    parts.join("\n\n")
}

fn is_daily_image_marker(line: &str) -> bool {
    line.starts_with("<!-- quepic-image:") && line.ends_with(" -->")
}

'''
yuque_text = yuque_text[:start] + replacement + yuque_text[end:]
old_test = r'''    #[test]
    fn does_not_append_duplicate_daily_batch() {
        let batch = "<!-- quepic-daily:12,18 -->\n## 12:30:00\n\n![图片](url)";
        let existing = format!("原有正文\n\n{batch}");
        assert_eq!(append_markdown(Some(&existing), batch), existing);
    }
'''
new_test = r'''    #[test]
    fn does_not_append_duplicate_daily_images() {
        let addition = "## 12:30:00\n\n<!-- quepic-image:12 -->\n![图片12](url12)\n\n<!-- quepic-image:18 -->\n![图片18](url18)";
        let existing = "原有正文\n\n<!-- quepic-image:12 -->\n![图片12](url12)";
        let merged = append_markdown(Some(existing), addition);
        assert_eq!(merged.matches("quepic-image:12").count(), 1);
        assert_eq!(merged.matches("quepic-image:18").count(), 1);
        assert!(merged.contains("![图片18](url18)"));
        assert_eq!(append_markdown(Some(&merged), addition), merged);
    }
'''
yuque_text = replace_once(yuque_text, old_test, new_test, "per-image idempotency test")
yuque_path.write_text(yuque_text, encoding="utf-8")

print("per-image idempotency applied")
