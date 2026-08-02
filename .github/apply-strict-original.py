from pathlib import Path

root = Path('.')
path = root / 'src-tauri/src/lib.rs'
text = path.read_text(encoding='utf-8')
old = '''fn existing_local_path(asset: &AssetRecord, prefer_original: bool) -> Option<String> {
    let candidates = if prefer_original {
        [
            asset.original_path.as_deref(),
            asset.thumbnail_path.as_deref(),
        ]
    } else {
        [
            asset.thumbnail_path.as_deref(),
            asset.original_path.as_deref(),
        ]
    };
    candidates
        .into_iter()
        .flatten()
        .find(|path| Path::new(path).is_file())
        .map(ToOwned::to_owned)
}
'''
new = '''fn existing_local_path(asset: &AssetRecord, prefer_original: bool) -> Option<String> {
    if prefer_original {
        return asset
            .original_path
            .as_deref()
            .filter(|path| Path::new(path).is_file())
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
if old not in text:
    raise SystemExit('未找到 existing_local_path')
path.write_text(text.replace(old, new, 1), encoding='utf-8')

for temporary in [root / '.github/apply-strict-original.py', root / '.github/apply-strict-original.trigger']:
    if temporary.exists():
        temporary.unlink()

ci = root / '.github/workflows/ci.yml'
ci_text = ci.read_text(encoding='utf-8')
start = ci_text.find('  apply_strict_original:\n')
if start >= 0:
    end = ci_text.find('  frontend:\n', start)
    if end < 0:
        raise SystemExit('无法恢复 CI')
    ci_text = ci_text[:start] + ci_text[end:]
ci_text = ci_text.replace('permissions:\n  contents: write\n', 'permissions:\n  contents: read\n', 1)
ci.write_text(ci_text, encoding='utf-8')
