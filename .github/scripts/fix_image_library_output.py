from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != expected:
        raise SystemExit(f'{path}: expected {expected} matches, found {count}\n{old}')
    file.write_text(text.replace(old, new), encoding='utf-8')


replace_exact(
    'src/App.tsx',
    '''    accountName,
    category,
    createdAt: Date.now(),''',
    '''    accountName,
    category,
    tags: [],
    createdAt: Date.now(),''',
)
replace_exact(
    'src/App.tsx',
    'const result = await uploadImage(item.file, item.accountName, item.width, item.height, item.category);',
    'const result = await uploadImage(item.file, item.accountName, item.width, item.height, item.category, item.tags || []);',
)
replace_exact(
    'src/components/BatchDocumentUploader.tsx',
    'const upload = await uploadImage(file, accountName, null, null, folderName);',
    'const upload = await uploadImage(file, accountName, null, null, folderName, []);',
)

replace_exact('src-tauri/src/preview.rs', '    io::Cursor,\n', '')
replace_exact('src-tauri/src/preview.rs', 'DynamicImage, ImageFormat', 'DynamicImage')
replace_exact(
    'src-tauri/src/lib.rs',
    '    let downloaded = match remote_preview::download_preview(',
    '    let downloaded_bytes = match remote_preview::download_preview(',
)
replace_exact(
    'src-tauri/src/lib.rs',
    '        Ok(image) => image,\n        Err(public_error) => {',
    '        Ok(image) => image.bytes,\n        Err(public_error) => {',
)
replace_exact(
    'src-tauri/src/lib.rs',
    '''                .map_err(|session_error| {
                    format!("原图下载失败：{public_error}；语雀会话回源失败：{session_error}")
                })?''',
    '''                .map_err(|session_error| {
                    format!("原图下载失败：{public_error}；语雀会话回源失败：{session_error}")
                })?
                .bytes''',
)
replace_exact(
    'src-tauri/src/lib.rs',
    'fs::write(&target, downloaded.bytes)',
    'fs::write(&target, downloaded_bytes)',
)

shared_old = '''    statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())'''
shared_new = '''    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())'''
replace_exact('src-tauri/src/database.rs', shared_old, shared_new, expected=2)

tags_old = '''    statement
        .query_map([asset_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())'''
tags_new = '''    let rows = statement
        .query_map([asset_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())'''
replace_exact('src-tauri/src/database.rs', tags_old, tags_new)
