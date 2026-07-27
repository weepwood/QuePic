# QuePic · 雀图库

QuePic 是一个使用 **React + Tauri 2 + Rust + SQLite** 构建的本地优先图片上传与管理工具。它通过应用内语雀登录窗口取得网页会话，调用语雀图片上传接口获得远程链接，并把原图和缩略图缓存到本地，避免语雀防盗链导致桌面图库无法显示。

> 语雀图片上传接口属于网页端非公开接口，可能随语雀调整而失效。QuePic 与语雀官方无关。

## 主要功能

- React 19 + TypeScript 桌面界面；
- 图片拖放、文件选择和剪贴板导入；
- 批量上传队列与失败重试；
- 应用内登录语雀并捕获包含 HttpOnly 的会话 Cookie；
- Cookie 分片写入 Windows Credential Manager、macOS Keychain 或 Linux Secret Service；
- 通过 `POST https://www.yuque.com/api/upload/attach` 上传图片；
- SQLite 本地图片索引与 SHA-256 完全重复图片检测；
- 上传后保存本地原图，并生成最长边 512px 的 PNG 缩略图；
- 图片库优先通过 Tauri Asset Protocol 加载本地缓存；
- 历史图片接近可视区域时，由 Rust 带语雀会话按需回源并补建缓存；
- 可选 `i3.wp.com` WordPress CDN 兼容兜底，默认关闭；
- 缓存数量、占用空间统计与一键清理；
- 删除本地记录时同步清理本地缓存，但不删除语雀远程图片；
- Windows 发布版不显示额外控制台窗口。

## 图片显示优先级

```text
本地缩略图或原图
  ↓ 不存在或损坏
Rust 使用语雀 Cookie + Referer 回源
  ↓ 成功后写入本地缓存
WordPress CDN 兼容代理（仅用户主动开启）
  ↓ 仍失败
加载失败占位图
```

QuePic 不再把语雀原始 URL 直接作为图库 `<img>` 地址。原始远程 URL 仍保留，用于复制 URL、复制 Markdown 和后续回源。

### 新上传图片

上传成功后，QuePic 会把上传前已有的图片字节写入应用缓存目录，因此不需要再从语雀下载一次。支持解码的图片同时生成 512px PNG 缩略图；SVG、AVIF 或其他当前缩略图解码器不支持的格式会直接使用原文件作为预览。

### 历史图片

旧版本已有记录没有本地文件。进入图片库后，图片接近可视区域时才会触发回源，避免一次性请求整个图库。成功后缓存状态和占用统计会自动更新，后续可以离线显示。

### WordPress CDN 兼容模式

设置页中的“WordPress CDN 兼容兜底”默认关闭。开启后，只有本地缓存和 Rust 回源都失败时，QuePic 才会把经过域名验证的语雀图片地址转换为：

```text
https://i3.wp.com/cdn.nlark.com/yuque/...
```

该方式会让 WordPress.com 服务器访问并可能缓存图片，不建议用于敏感、内部或隐私图片。

## 技术栈

- React 19、TypeScript、Vite
- Tauri 2、Rust、reqwest
- Tauri Asset Protocol
- SQLite / rusqlite
- image-rs
- keyring-rs

## 开发

环境要求：Node.js 20+，推荐 22；Rust 1.77.2+；安装对应平台的 Tauri 系统依赖。

```bash
npm install
npm run tauri:dev
```

只检查 React 前端：

```bash
npm run build
```

检查 Rust 后端与单元测试：

```bash
npm run icons
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## 登录语雀

1. 打开 QuePic 的“设置”。
2. 填写用于区分本地凭据的账号名称，例如 `default`。
3. 点击“登录语雀”。
4. 在独立窗口中完成扫码、手机号或其他语雀支持的登录方式。
5. 看到语雀主页后返回 QuePic，点击“完成登录并保存”。
6. QuePic 会读取匹配语雀上传地址的 Cookie，并安全保存。

Cookie 不会写入 SQLite、前端持久化状态、日志或 Git 仓库。React 前端也没有读取已保存 Cookie 的接口。

### Windows 长 Cookie

Windows Credential Manager 的单条密码存在长度限制。QuePic v0.1.1 起会按 UTF-16 单元把长 Cookie 拆分为多个安全凭据，并用短 Manifest 管理分片，因此不再出现 `password encoded as UTF-16 is longer than platform limit of 2560 chars`。

设置页仍保留“高级：手动粘贴 Cookie”作为回退方式，手动保存同样使用分片存储。

## 缓存与删除边界

QuePic 管理的是本地索引和本地预览缓存，并不是语雀官方附件管理器：

- 删除图片记录会删除 SQLite 数据及对应本地缓存；
- 不会删除语雀服务器上的远程图片；
- “清理本地缓存”保留全部 SQLite 记录和远程 URL；
- 清理后，历史图片会在进入视口时重新回源；
- 已上传 URL 是否长期有效取决于语雀服务；
- 本地数据库位于系统应用数据目录；
- 图片缓存位于系统应用缓存目录的 `previews` 子目录。

## 项目结构

```text
src/
├─ App.tsx                         页面、登录、上传、缓存设置与图片库
├─ components/AssetPreview.tsx    懒加载、本地文件与代理预览
├─ lib/tauri.ts                    前端 IPC 封装
├─ types.ts                        前端数据类型
├─ styles.css                      主界面样式
└─ preview.css                     预览与缓存设置样式

src-tauri/src/
├─ credentials.rs                  系统密钥库分片存储
├─ database.rs                     assets / asset_previews 数据访问
├─ models.rs                       IPC 与缓存数据结构
├─ preview.rs                      原图缓存、缩略图和缓存清理
├─ yuque.rs                        上传、受控回源和代理 URL 转换
└─ lib.rs                          登录窗口、Tauri 命令与业务编排
```

详细设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，安全边界见 [`docs/SECURITY.md`](docs/SECURITY.md)。

## 后续路线

- 相册、标签、收藏和批量编辑；
- SQLite FTS5 全文检索；
- 上传任务持久化和应用重启恢复；
- 缓存配额、LRU 自动回收与批量预下载；
- 多语雀账号切换；
- 系统托盘和全局快捷键；
- R2、S3、GitHub 等多存储适配器；
- 商业代码签名与 macOS 公证。

## License

MIT
