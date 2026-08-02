# QuePic 架构设计

## 1. 产品边界

QuePic 是面向语雀工作流的本地优先图片采集、整理和文档发布工具。

它不是语雀官方附件管理器，也不是通用云盘。语雀承担远程图片托管和文档存储；QuePic 负责本地上传编排、资产索引、预览缓存、分类检索和失败恢复。

当前架构基线为 v0.8.0。

## 2. 技术栈

- React 19 + TypeScript + Vite
- Tauri 2
- Rust + Tokio
- SQLite / rusqlite，WAL 模式
- reqwest + rustls
- image-rs
- keyring-rs

## 3. 数据与状态分层

### SQLite

保存：

- 图片资产索引；
- 来源账号；
- 文件夹和标签；
- 本地缓存元数据；
- 账号档案与统计；
- 每账号上传尝试和整点额度；
- 备份恢复所需的非敏感数据。

### 系统密钥库

保存：

- 语雀 Cookie；
- OpenAPI Token。

完整凭据不进入 React、SQLite、localStorage、IndexedDB、日志或备份。

### IndexedDB

当前保存普通图片上传队列及 File/Blob，用于页面刷新和应用重启后的普通队列恢复。

这是过渡实现。未来持久任务系统会改为 Rust 持有本地路径、SQLite 持有任务状态，不再把浏览器 Blob 作为长期任务事实来源。

### localStorage

当前仍保存部分用户偏好和业务设置：

- 当前账号；
- 主账号；
- 子账号接力开关；
- 默认知识库和目标文档 URL；
- 图库视图；
- 上传默认文件夹和标签；
- WordPress 兼容开关；
- 上传上下文。

业务设置迁移到 SQLite `app_settings` 的计划见 Issue #32。

## 4. 主子账号模型

### 主账号

主账号必须具有：

- Cookie；
- OpenAPI Token；
- 可解析的上传上下文文档。

主账号负责文档创建、更新和大图片上传。

### 子账号

子账号只需要 Cookie，可处理不超过 10 MB 的图片，不需要 Token，也不需要目标文档访问权限。

所有账号上传的图片进入共享图库；最终 Markdown 由主账号写入主账号文档。

### 当前路由

React 读取账号档案和额度，并使用 `uploadRouting.ts` 排序候选账号。Rust 在真正上传前再次校验：

- Cookie；
- Token 对应的文件大小上限；
- 上传上下文；
- 实时整点额度；
- 同账号 SHA-256 去重。

该模式已经具备后端二次防线，但权威路由仍应迁移到 Rust，避免多个前端入口并发读取过期配额。目标见 Issue #32。

## 5. 普通上传数据流

```text
选择/拖放/剪贴板图片
  → React 生成 160px WebP 临时预览
  → IndexedDB 保存队列项和 Blob
  → 主账号确保当天文档与上传上下文
  → React 根据大小、账号状态和配额排序候选账号
  → Tauri IPC 提交图片字节和候选账号
  → Rust 校验 MIME、大小、账号和文档上下文
  → 计算 SHA-256
  → 同账号命中重复记录时复用远程 URL
  → 获取 Cookie并记录上传尝试
  → POST 固定语雀图片上传接口
  → 校验响应和远程 URL 白名单
  → SQLite 提交资产、文件夹和标签
  → 生成详情预览与缩略图
  → React 汇总成功项
  → 主账号幂等追加到当天文档
```

图片上传成功、文档写入失败时，队列保留 `UploadResult`。后续重试直接复用远程 URL。

## 6. 文件夹转文档数据流

v0.8 的 `BatchDocumentUploader` 通过常驻 React 组件维持跨页面状态：

```text
浏览器目录输入
  → File.webkitRelativePath
  → 中文数字自然排序
  → 逐图选择候选账号
  → Rust upload_image
  → React 内存记录已上传 URL
  → 额度耗尽时等待下一整点
  → 汇总 Markdown
  → Rust OpenAPI 创建或追加文档
```

“跨页面保持”不等于“跨应用退出恢复”。当前 File 对象、等待计时和已上传映射仍位于 React 内存。未来实现为：

```text
Tauri 文件夹选择器
  → Rust 扫描目录
  → upload_jobs / upload_job_items
  → Rust 调度与 next_run_at
  → document_sync_outbox
  → 应用退出后恢复
```

详见 Issue #33。

## 7. 图片库和缓存

### 数据模型

- `assets`：图片摘要、文件名、类型、大小、尺寸、远程 URL、来源账号和上传时间；
- `asset_categories`：单归属文件夹；
- `asset_tags`：多标签；
- `library_folders`：文件夹列表；
- `asset_previews`：详情预览、缩略图、来源、状态、大小和错误；
- `upload_attempts`：每账号上传尝试。

同账号内通过 `UNIQUE(account_name, sha256)` 去重。不同账号上传相同字节会保留各自的语雀 URL，但本地物理缓存可按 SHA-256 共享。

### 缓存结构

```text
$APPCACHE/previews/
└─ <sha256 前两位>/
   └─ <完整 sha256>/
      ├─ original.* 或详情预览
      └─ thumbnail.*
```

当前新上传文件不会无条件永久保留完整原图。详情预览和缩略图经过大小约束；查看或保存原图时按需回源原始 URL。

### 预览优先级

```text
本地缓存
  → 受控公开 URL 回源
  → 来源账号 Cookie 会话回源
  → WordPress CDN 兼容模式
  → 错误状态
```

前端只能提交 `asset_id`，不能把任意 URL 传给回源命令。

## 8. 文档同步

OpenAPI Token 由 Rust 从系统密钥库读取，用于：

- 列出知识库；
- 创建或复用 QuePic 私有知识库；
- 列出、创建、更新和删除文档；
- 将文档登记到知识库目录。

每日文档使用本地日期 `YYYY-MM-DD` 命名。每张图片块带：

```html
<!-- quepic-image:<asset_id> -->
```

Rust 在更新文档前过滤已存在标记，实现客户端重试幂等。

未来将文档写入改为 SQLite Outbox，保证应用崩溃或网络超时后仍可恢复，见 Issue #33。

## 9. 并发与锁

`AppState` 当前包含：

- `database_gate: RwLock`：普通命令读锁，备份导入/导出写锁；
- `upload_gate: Mutex`：串行化远程上传和配额关键区；
- `cache_lock: Mutex`：缓存文件和缓存索引一致性；
- `preview_limiter`：远程预览并发与节流。

备份恢复会执行 WAL checkpoint，并在数据库/缓存替换失败时恢复旧数据。

前端全局维护态和更完整的故障注入仍由 Issue #22 跟踪。

## 10. 安全边界

- 主窗口 capability 只开放 `core:default`；
- Asset Protocol 只开放 `$APPCACHE/previews/**`；
- CSP 不允许 WebView 直接加载语雀 CDN；
- 上传请求固定到 `https://www.yuque.com/api/upload/attach`；
- 网络客户端禁止自动重定向；
- 远程 URL 只接受 HTTPS `yuque.com`、`nlark.com` 及子域；
- Cookie 与 Token 只在 Rust 内部读取；
- Tauri 不注册任何返回完整 Cookie/Token 的命令；
- 登录窗口只允许 HTTPS 和 `about:` 导航，且关闭 DevTools。

## 11. 当前模块

```text
React
├─ App.tsx
├─ AssetPreview
├─ OriginalImageViewer
├─ BatchDocumentUploader
├─ YuqueDocumentManager
├─ tauri IPC wrapper
├─ IndexedDB queue store
└─ upload routing helper

Rust
├─ credentials
├─ openapi_token
├─ accounts
├─ database
├─ preview
├─ remote_preview
├─ yuque upload/download
├─ yuque_openapi
├─ backup
└─ lib command orchestration
```

当前主要技术债是 `App.tsx` 和 `lib.rs` 仍承担较多业务编排。目标架构见 Issue #31：

```text
React features
  → typed IPC
  → Tauri commands
  → application services
  → domain services
  → repositories/providers
```

## 12. 演进顺序

1. #30：凭据安全、文档和 CI 基线；
2. #22：备份恢复全局维护态和故障注入；
3. #31：前后端模块边界；
4. #32：统一设置和 Rust 权威路由；
5. #33：持久任务与文档 Outbox；
6. #34：测试、诊断、LRU 和 Release；
7. #29：v1.0 总验收。
