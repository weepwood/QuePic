# QuePic · 雀图库

QuePic 是一款使用 **React 19 + Tauri 2 + Rust + SQLite** 构建的本地优先语雀图片上传、整理和文档发布工具。

应用通过独立语雀登录窗口获取网页会话，由 Rust 调用语雀网页图片上传接口；图片记录、文件夹、标签和缓存索引保存在本地 SQLite，预览文件保存在应用缓存目录。QuePic 与语雀官方无关。

> 语雀图片上传使用网页端非公开接口，接口、风控或防盗链规则可能随时变化。OpenAPI 仅用于知识库和文档操作，不能替代网页会话上传图片。

## 当前版本

当前稳定基线为 **v0.8.0**，主要能力包括：

- 主账号与子账号上传体系；
- 普通图片持久队列；
- 文件夹批量上传并创建或追加语雀 Markdown 文档；
- 多账号共享图片库；
- 文件夹、标签、搜索、排序和批量管理；
- 原始比例瀑布流与统一方格视图；
- 应用内原图查看与系统保存；
- 本地详情预览和缩略图两级缓存；
- 每日图片文档自动创建、目录登记和幂等追加；
- SQLite 图片索引与备份恢复；
- Windows x64 NSIS 与 macOS Apple Silicon DMG 发布。

## 主子账号模型

QuePic 将“图片上传身份”和“文档管理身份”分开：

### 主账号

主账号需要：

- 有效语雀 Cookie；
- 语雀 OpenAPI Token；
- 默认知识库或目标文档配置。

主账号负责：

- 创建和更新语雀文档；
- 将所有账号上传得到的图片链接写入主账号文档；
- 上传大于 10 MB、且不超过 50 MB 的图片；
- 在没有可用子账号时上传小图。

### 子账号

子账号只需要有效语雀 Cookie：

- 不需要 Token；
- 不需要配置知识库或文档；
- 不需要拥有主账号文档访问权限；
- 可优先处理不超过 10 MB 的图片。

普通上传与文件夹转文档共用同一套账号规则。每个账号独立按自然整点小时记录上传尝试；当前保守保护值为每账号 140 次/整点小时，这不是语雀官方承诺的固定配额。

## 图片上传流程

```text
React 选择、拖放或粘贴图片
  → 队列生成小尺寸临时预览
  → 持久化普通上传队列到 IndexedDB
  → 根据文件大小和账号状态选择候选账号
  → Rust 校验文件、账号 Cookie、上传上下文和实时额度
  → SHA-256 同账号去重
  → 调用语雀网页图片上传接口
  → 保存 SQLite 图片记录
  → 生成本地详情预览和缩略图
  → 主账号将图片块幂等写入当天文档
```

上传成功但文档写入失败时，普通上传队列会保留已上传结果。重试会复用远程链接，不会再次上传同一队列项。

## 文件夹转文档

1. 在设置中选择主账号。
2. 为主账号保存 Cookie 与 OpenAPI Token。
3. 在“主账号文档目标”中选择知识库，可选指定追加文档。
4. 打开“文件夹转文档”，选择包含图片的本地文件夹。
5. 确认自然排序结果后开始上传。

规则：

- 递归读取常见图片格式；
- 按完整相对路径执行中文数字自然排序；
- 不超过 10 MB 的图片优先使用已登录子账号；
- 大于 10 MB 的图片只使用主账号；
- 所有可用账号额度耗尽后等待下一整点；
- 未指定目标文档时，以文件夹名称创建 Markdown 文档；
- 指定目标文档时追加图片并保留原正文；
- 文档自动加入知识库目录，并避免重复目录节点。

当前 v0.8 的文件夹任务在页面切换时保持运行，但应用完全退出后不能恢复文件对象。跨应用重启的 Rust 持久任务系统正在 #33 中规划。

## 共享图片库

所有账号上传的图片进入同一个本地图库。账号切换只改变后续上传身份，不隐藏历史记录。

图库支持：

- 单归属文件夹；
- 多标签；
- 文件名、链接、类型、账号、文件夹和标签搜索；
- 最新、最早、名称、大小和文件夹排序；
- 原始比例瀑布流；
- 统一方格；
- 批量归类和批量删除本地记录；
- 原图查看、放大缩小、系统保存；
- URL 与 Markdown 复制。

删除图片记录只删除 SQLite 索引和对应本地缓存，不删除语雀服务器上的附件。

## 本地缓存与回源

QuePic 不长期保存所有上传原文件。当前缓存包含：

- 详情预览：目标不超过约 820 KB；
- 缩略图：目标不超过约 160 KB；
- 单张图片两级缓存目标合计约 1 MB；
- 用户查看或保存原图时按需回源真实原始字节。

显示优先级：

```text
本地缩略图或详情预览
  ↓
受控公开远程回源
  ↓
来源账号语雀会话回源
  ↓
WordPress CDN 兼容兜底（用户主动开启）
  ↓
加载失败状态
```

WordPress CDN 模式会让 WordPress.com 服务器访问并可能缓存图片，不建议用于敏感、内部、医疗或隐私图片。

## 凭据安全

Cookie 与 OpenAPI Token 使用 keyring-rs 保存到操作系统密钥库：

- Windows Credential Manager；
- macOS Keychain；
- Linux Secret Service。

Windows 长 Cookie 会按 UTF-16 单元分片保存，并通过 Manifest 原子切换。

安全边界：

- Cookie、Token 不写入 SQLite、localStorage、IndexedDB、日志或 Git；
- 完整 Cookie、Token 不返回 React，也不能在应用中回显或复制；
- React 只能查询“已配置/未配置”，以及发起覆盖或清除操作；
- 带 Cookie 的请求只由 Rust 发往固定语雀上传地址；
- OpenAPI Token 只由 Rust 用于固定语雀 OpenAPI 域名；
- 上传和下载客户端禁止自动重定向；
- 远程图片只接受 HTTPS 语雀/Nlark 白名单域名。

详细边界见 [`docs/SECURITY.md`](docs/SECURITY.md)。

## 备份与恢复

QuePic 的 `.quepic-backup` 支持：

1. 设置与账号名称；
2. 设置、图片索引；
3. 设置、图片索引和本地缓存。

Cookie 与 Token 永远不进入备份。完整恢复使用数据库级读写门闩、WAL checkpoint、同盘暂存、数据库与缓存备份和失败回滚。

前端全局维护态与更多并发故障注入测试仍在 Issue #22 中继续完善。

## 项目结构

```text
src/
├─ App.tsx
├─ components/
│  ├─ AssetPreview.tsx
│  ├─ BatchDocumentUploader.tsx
│  ├─ OriginalImageViewer.tsx
│  └─ YuqueDocumentManager.tsx
├─ lib/
│  ├─ tauri.ts
│  ├─ uploadQueueStore.ts
│  └─ uploadRouting.ts
├─ types.ts
└─ *.css

src-tauri/src/
├─ accounts.rs
├─ backup.rs
├─ credentials.rs
├─ database.rs
├─ models.rs
├─ openapi_token.rs
├─ preview.rs
├─ remote_preview.rs
├─ yuque.rs
├─ yuque_openapi.rs
└─ lib.rs
```

当前结构仍处于收敛阶段。App.tsx、Rust command 和上传路由的拆分计划见 #29、#31 和 #32。

## 开发

环境要求：

- Node.js 22；
- Rust stable；
- Tauri 2 对应平台系统依赖。

```bash
npm install
npm run tauri:dev
```

前端构建：

```bash
npm run build
```

Rust 检查：

```bash
npm run icons
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## 发布平台

当前自动发布：

- Windows x64 NSIS；
- macOS Apple Silicon DMG。

Windows 安装包尚未商业代码签名；macOS 使用临时签名但尚未公证，系统可能显示未知开发者提示。

## 已知限制

- 语雀网页上传接口不是公开稳定 API；
- CI 不使用真实语雀账号，线上兼容性仍需要安装包冒烟验证；
- 文件夹任务目前不能跨应用退出恢复；
- 主账号和文档目标仍有部分配置保存在 localStorage；
- 上传账号选择目前仍由前端参与决策；
- 缓存当前只有手动清理，尚未实现容量上限和 LRU；
- 自动更新、Windows 签名和 macOS 公证尚未完成。

完整 v1.0 路线见 Issue #29。

## License

MIT
