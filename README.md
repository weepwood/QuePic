# QuePic · 雀图库

QuePic 是一个使用 **React + Tauri 2 + Rust + SQLite** 构建的本地优先图片上传与管理工具。它通过用户提供的语雀网页 Cookie 调用语雀图片上传接口，取得远程图片链接，并在本地建立可搜索、可去重的图片索引。

> 语雀图片上传接口属于网页端非公开接口，可能随语雀调整而失效。QuePic 与语雀官方无关。

## MVP 功能

- React 19 + TypeScript 桌面界面；
- 图片拖放、文件选择和剪贴板导入；
- 批量上传队列与失败重试；
- 通过 `POST https://www.yuque.com/api/upload/attach` 上传图片；
- 从返回结果的 `data.url` 获取远程链接；
- SQLite 本地图片索引；
- SHA-256 完全重复图片检测；
- 图片库搜索、详情查看和链接复制；
- Cookie 写入 Windows Credential Manager、macOS Keychain 或 Linux Secret Service；
- Cookie 失效、登录页和接口响应变化提示；
- 删除本地记录时明确不删除远程图片。

## 技术栈

- React 19、TypeScript、Vite
- Tauri 2、Rust、reqwest
- SQLite / rusqlite
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

检查 Rust 后端：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## 获取语雀 Cookie

1. 在浏览器登录语雀并打开任意文档。
2. 按 `F12` 打开开发者工具，进入 Network。
3. 在语雀编辑器中手动上传一张测试图片。
4. 找到 `/api/upload/attach` 请求。
5. 从 Request Headers 中复制完整 Cookie 值。
6. 在 QuePic 的“设置”页面粘贴并保存。

Cookie 不会写入 SQLite、前端持久化状态、日志或 Git 仓库。React 前端也没有读取已保存 Cookie 的接口。

## 数据与删除边界

QuePic 管理的是本地索引，并不是语雀官方附件管理器：

- 删除图片记录只删除本地 SQLite 数据；
- 不会删除语雀服务器上的远程图片；
- 已上传 URL 是否长期有效取决于语雀服务；
- 本地数据库默认位于系统应用数据目录。

## 项目结构

```text
src/
├─ App.tsx              React 页面、上传队列与图片库
├─ lib/tauri.ts         前端 IPC 封装
├─ types.ts             前端数据类型
└─ styles.css           无 Tailwind 的桌面端样式

src-tauri/src/
├─ credentials.rs       操作系统密钥库
├─ database.rs          SQLite 本地索引
├─ models.rs            IPC 数据结构
├─ yuque.rs             语雀上传适配器
└─ lib.rs               Tauri 命令与业务编排
```

详细设计见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，安全边界见 [`docs/SECURITY.md`](docs/SECURITY.md)。

## 后续路线

- 相册、标签、收藏和批量编辑；
- SQLite FTS5 全文检索；
- 缩略图持久化缓存；
- 上传任务持久化和应用重启恢复；
- 多语雀账号；
- 系统托盘和全局快捷键；
- R2、S3、GitHub 等多存储适配器；
- Windows、macOS、Linux 安装包与签名发布。

## License

MIT
