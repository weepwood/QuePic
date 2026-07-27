# QuePic 架构设计

## 目标

QuePic 将远程上传、本地索引与本地预览分离：语雀只承担图片托管，SQLite 保存资产和缓存元数据，应用缓存目录保存原图与缩略图，Cookie 只存在于操作系统密钥库。

核心目标是让图片库不再依赖 WebView 直接访问带防盗链的语雀 CDN URL。

## 上传数据流

```text
React 文件选择/拖放
  → 读取尺寸和临时预览
  → Tauri IPC 传入图片字节
  → Rust 校验大小、MIME 和文件名
  → 计算 SHA-256
  → 命中重复记录时复用远程链接并补建本地缓存
  → 从系统密钥库读取 Cookie
  → POST /api/upload/attach
  → 校验状态码、响应结构和 data.url 域名
  → 写入 SQLite assets
  → 保存本地原图
  → 生成最长边 512px 的 PNG 缩略图
  → 写入 SQLite asset_previews
  → 返回远程 URL 与本地缓存状态
```

上传阶段在调用语雀前复制一份图片字节用于本地缓存。上传成功后无需再次请求远程图片。

## 预览数据流

```text
AssetPreview 进入可视区域附近
  → AssetRecord 是否有可用本地路径？
      ├─ 是：convertFileSrc + Tauri Asset Protocol
      └─ 否：ensure_preview(asset_id)
             → Rust 根据 asset_id 查询数据库
             → 校验 remote_url 只属于 yuque.com / nlark.com
             → 从对应账号的系统密钥库读取 Cookie
             → Cookie + Referer 请求远程图片
             → 禁止重定向、限制 image/* 和 30 MB
             → 写入原图和缩略图缓存
             → 更新 asset_previews
             → 返回本地路径
                 └─ 若失败且用户开启兼容模式
                    → 返回经过验证的 i3.wp.com URL
```

前端不能传入任意远程 URL，只能传递数据库中的 `asset_id`，避免把预览命令变成通用网络代理。

## 本地文件访问

缓存根目录：

```text
$APPCACHE/previews/
└─ <sha256 前两位>/
   └─ <完整 sha256>/
      ├─ original.<ext>
      └─ thumbnail.png
```

Tauri Asset Protocol 只开放：

```text
$APPCACHE/previews/**
```

React 使用 `convertFileSrc()` 把 Rust 返回的本地绝对路径转换成 WebView 可加载地址。应用数据目录、数据库、凭据或其他文件不在 Asset Protocol scope 中。

## 懒加载策略

图片卡片通过 `IntersectionObserver` 监听，并设置约 260px 的预加载区域：

- 屏幕附近的历史图片才触发回源；
- 详情面板立即请求原图；
- 多张图片陆续补建缓存时，前端用短延迟合并刷新 SQLite 记录和缓存统计；
- 本地图片加载失败时只执行一次强制回源刷新，避免无限重试。

## React 边界

React 负责：

- 页面、上传队列、搜索与详情；
- 决定是否启用 WordPress CDN 实验兜底；
- 使用 Asset Protocol 显示 Rust 返回的本地文件；
- 展示缓存统计、加载状态和来源标签。

React 不负责：

- 读取 Cookie；
- 直接带凭据访问语雀；
- 接受任意 URL 并发起代理请求；
- 直接操作 SQLite；
- 直接读写缓存目录。

## Rust 命令

凭据与登录：

- `save_cookie`
- `open_yuque_login`
- `capture_yuque_login`
- `credential_status`
- `clear_cookie`

资产与缓存：

- `upload_image`
- `list_assets`
- `delete_asset`
- `ensure_preview`
- `cache_stats`
- `clear_preview_cache`

## 数据库

### assets

保存：

- SHA-256
- 文件名、MIME、大小和尺寸
- 语雀远程 URL
- 账号名称
- 上传时间

`sha256` 是唯一键，完全相同的图片不会重复上传。

### asset_previews

保存：

- `asset_id`
- 原图路径
- 缩略图路径
- 预览来源
- 缓存状态
- 缓存字节数
- 缓存时间
- 最近错误

`asset_previews.asset_id` 外键指向 `assets.id` 并启用级联删除。清理缓存时只删除该表和缓存目录，不删除 `assets`。

## 失败与恢复

- 缩略图解码失败：保留原图，并用原图作为预览路径；
- 历史图片回源失败：记录错误，不修改原始远程 URL；
- 本地文件被外部删除：WebView 加载失败后执行一次强制回源；
- Cookie 失效：显示重新登录提示；
- WordPress 代理关闭：失败后显示占位图；
- WordPress 代理开启：仅作为最后显示兜底，不写回远程 URL。

## 后续演进

- 缓存配额与 LRU 自动淘汰；
- 批量离线预下载和取消任务；
- 独立缩略图任务队列；
- 多存储 Provider 统一预览接口；
- 本地缓存完整性扫描和修复。
