from pathlib import Path
import base64
import io
import tarfile

parts_dir = Path("scripts/cloud-drive-payload")
payload = "".join(path.read_text(encoding="utf-8") for path in sorted(parts_dir.glob("part-*.txt")))
with tarfile.open(fileobj=io.BytesIO(base64.b64decode(payload)), mode="r:gz") as archive:
    archive.extractall(Path.cwd(), filter="data")

def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'missing integration anchor in {path}: {old!r}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once('src-tauri/src/lib.rs', 'mod database;\n', 'mod database;\nmod drive;\n')
replace_once('src-tauri/src/lib.rs', 'mod yuque;\n', 'mod yuque;\nmod yuque_attachment;\n')
replace_once(
    'src-tauri/src/lib.rs',
    '            accounts::initialize(&database_path).map_err(std::io::Error::other)?;\n',
    '            accounts::initialize(&database_path).map_err(std::io::Error::other)?;\n'
    '            drive::initialize(&database_path).map_err(std::io::Error::other)?;\n',
)
replace_once(
    'src-tauri/src/lib.rs',
    '            backup::import_backup,\n',
    '            backup::import_backup,\n'
    '            drive::pick_drive_files,\n'
    '            drive::list_drive_files,\n'
    '            drive::list_drive_folders,\n'
    '            drive::create_drive_folder,\n'
    '            drive::list_drive_tags,\n'
    '            drive::update_drive_file_folder,\n'
    '            drive::update_drive_file_tags,\n'
    '            drive::delete_drive_file,\n'
    '            drive::upload_drive_file,\n'
    '            drive::save_drive_file,\n',
)

replace_once(
    'src-tauri/Cargo.toml',
    'features = ["json", "multipart", "rustls-tls", "gzip", "brotli", "deflate", "zstd"]',
    'features = ["json", "multipart", "stream", "rustls-tls", "gzip", "brotli", "deflate", "zstd"]',
)
replace_once(
    'src-tauri/Cargo.toml',
    'tokio = { version = "1", features = ["sync", "time"] }',
    'tokio = { version = "1", features = ["sync", "time", "fs", "io-util"] }',
)
replace_once(
    'src-tauri/Cargo.toml',
    'description = "本地优先的语雀图片上传与管理工具"',
    'description = "本地优先的语雀文件与图片云盘管理工具"',
)

replace_once(
    'src/main.tsx',
    "import { AccountBackupManager } from './components/AccountBackupManager';\n",
    "import { AccountBackupManager } from './components/AccountBackupManager';\n"
    "import { CloudDriveManager } from './components/CloudDriveManager';\n",
)
replace_once(
    'src/main.tsx',
    "import './upload-log.css';\n",
    "import './upload-log.css';\nimport './cloud-drive.css';\n",
)
replace_once(
    'src/main.tsx',
    '    <AccountBackupManager />\n',
    '    <AccountBackupManager />\n    <CloudDriveManager />\n',
)

replace_once(
    'README.md',
    'QuePic 是一款使用 **React 19 + Tauri 2 + Rust + SQLite** 构建的本地优先语雀图片上传、整理和文档发布工具。',
    'QuePic 是一款使用 **React 19 + Tauri 2 + Rust + SQLite** 构建的本地优先语雀文件云盘、图片管理和文档发布工具。',
)
replace_once(
    'README.md',
    '应用通过独立语雀登录窗口获取网页会话，由 Rust 调用语雀网页图片上传接口；图片记录、文件夹、标签和缓存索引保存在本地 SQLite，预览文件保存在应用缓存目录。QuePic 与语雀官方无关。',
    '应用通过独立语雀登录窗口获取网页会话，由 Rust 调用语雀网页上传接口；通用附件和图片的记录、文件夹、标签及缓存索引保存在本地 SQLite，原始附件保存在语雀。QuePic 与语雀官方无关。',
)
anchor = '## 图片上传流程\n'
section = '''## 语雀云盘\n\n“语雀云盘”将通用附件与图片图库分开管理：\n\n- 从系统文件选择器读取本地真实路径；\n- Rust 按路径流式上传，避免把大文件完整复制到 WebView 内存；\n- 使用与语雀网页一致的 `multipart/form-data` 文件字段和附件上传模式；\n- 本地 SQLite 保存文件名、摘要、大小、类型、文件夹、标签、来源账号和语雀下载地址；\n- 点击下载时使用来源账号会话回源，并以临时文件原子落盘；\n- 删除默认只移除本地索引，不删除语雀服务器上的附件；\n- 支持 Office、PDF、文本、图片、设计文件、思维导图、压缩包、音频和视频等常见附件扩展名，最终是否接受仍以语雀服务端响应为准。\n\n附件上传和下载都限制为语雀/Nlark HTTPS 域名；下载仅在语雀域名发送 Cookie，并对安全重定向后的目标域名重新校验。\n\n'''
replace_once('README.md', anchor, section + anchor)

import shutil
shutil.rmtree(parts_dir)
Path('scripts/apply-cloud-drive-integration.py').unlink()
Path('.github/workflows/apply-cloud-drive-integration.yml').unlink()
