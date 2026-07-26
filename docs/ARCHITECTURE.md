# QuePic 架构设计

## 目标

QuePic 将远程上传与本地资产管理分离：语雀只承担图片托管，SQLite 保存本地索引，Cookie 只存在于操作系统密钥库。

## 数据流

```text
React 文件选择/拖放
  → 读取尺寸和预览
  → Tauri IPC 传入图片字节
  → Rust 校验大小、MIME 和文件名
  → 计算 SHA-256
  → 命中重复记录则返回历史链接
  → 从系统密钥库读取 Cookie
  → POST /api/upload/attach
  → 校验状态码和 data.url
  → 写入 SQLite assets
  → 返回图片 URL 与本地记录
```

## React 边界

React 负责页面、上传队列、预览、搜索和链接复制。React 不读取 Cookie、不直接带凭据请求语雀、不直接操作 SQLite，也没有 Shell 和任意文件系统权限。

## Rust 命令

- `save_cookie`
- `credential_status`
- `clear_cookie`
- `upload_image`
- `list_assets`
- `delete_asset`

## 数据库

MVP 使用 `assets` 表保存 SHA-256、文件名、类型、大小、尺寸、远程 URL、账号名称和上传时间。`sha256` 是唯一键，完全相同的图片不会重复上传。

后续将增加相册、标签、上传任务持久化、FTS5 搜索和多存储 Provider。
