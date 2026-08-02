# QuePic 安全说明

## 1. 威胁模型

QuePic 会处理高权限语雀网页登录 Cookie、OpenAPI Token、本地图片和远程图片链接。安全设计重点是：

- 凭据不进入 WebView JavaScript；
- 凭据请求只能发送到固定语雀域名；
- 远程回源不能退化为任意 URL 代理；
- 本地文件协议不能访问数据库、密钥库或任意文件；
- 备份不包含凭据，并在失败时保持原数据不变；
- 日志和错误信息不包含凭据、请求头或图片字节。

语雀网页图片上传接口不是公开稳定 API，接口失效属于兼容性风险，不应通过放宽域名、重定向或凭据边界来绕过。

## 2. Cookie 与 Token 存储

QuePic 使用 keyring-rs 调用系统安全存储：

- Windows Credential Manager；
- macOS Keychain；
- Linux Secret Service。

Cookie 与 Token 不写入：

- SQLite；
- localStorage；
- IndexedDB；
- `.quepic-backup`；
- 日志；
- Git 仓库。

### Windows 长 Cookie

Windows Credential Manager 单条密码存在 UTF-16 长度限制。QuePic 将长 Cookie 分片保存，并使用短 Manifest 记录分片代次和数量：

1. 写入新代次全部分片；
2. 确认成功后切换 Manifest；
3. 删除旧分片；
4. 任一步失败时保留可用旧凭据。

## 3. 凭据不进入 React

React 只能执行：

- 保存新 Cookie；
- 打开语雀登录窗口；
- 捕获登录会话并保存；
- 查询 Cookie 是否已配置；
- 清除 Cookie；
- 保存或覆盖 OpenAPI Token；
- 查询 Token 是否已配置；
- 清除 Token。

Tauri 不注册返回完整 Cookie 或 Token 的命令。完整凭据不能在设置页显示或复制，也不会被放入 React state。

旧版前端若调用已废弃的回显封装，只会得到安全拒绝错误，不会触发后端读取。

## 4. 登录窗口

- 使用独立 Tauri `WebviewWindow`；
- 只允许 `https:` 与 `about:` 导航；
- DevTools 关闭；
- Cookie 由 Rust 调用 WebView Cookie API 获取，不通过页面 JavaScript；
- 可以读取 HttpOnly 与 Secure Cookie；
- Windows 同步 Cookie 读取放入阻塞线程，避免 WebView2 死锁；
- 保存成功后关闭登录窗口；
- 不读取、不保存语雀密码。

用户应直接在语雀页面完成扫码、手机号或其他官方登录流程。

## 5. 图片上传边界

带 Cookie 的图片上传只发送到：

```text
https://www.yuque.com/api/upload/attach
```

约束：

- 固定 HTTPS 地址；
- 禁止自动重定向；
- `ctoken` 从当前账号 Cookie 动态提取；
- Referer 必须是经过校验的 HTTPS 语雀具体文档 URL；
- attachable ID 必须为正整数；
- MIME 只允许受支持图片类型；
- 无 Token 账号单图最大 10 MB；
- 有 Token 账号单图最大 50 MB；
- 上传前后进行同账号 SHA-256 去重；
- 响应必须是预期 JSON，且 `data.url` 通过远程域名白名单。

当前每账号 140 次/整点小时是 QuePic 的保守保护值，不代表语雀官方配额。

## 6. OpenAPI 边界

OpenAPI Token 只由 Rust 从系统密钥库读取，用于固定语雀 OpenAPI：

- 知识库列表和创建；
- 文档列表、创建、更新和删除；
- 上传上下文解析；
- 知识库目录读取与节点追加。

客户端约束：

- HTTPS；
- 固定语雀 API 域名；
- 禁止自动重定向；
- 设置浏览器 User-Agent 和 Accept-Language 以兼容语雀网关；
- 响应体有大小限制；
- 错误信息不包含 Token 或完整响应头。

## 7. 远程图片回源

前端只能调用：

```text
ensure_preview(asset_id, prefer_original, allow_wordpress_fallback, force_refresh)
```

前端不能向后端提交任意远程 URL。Rust 根据 `asset_id` 从 SQLite 读取已保存地址。

约束：

- 只允许 HTTPS；
- 只允许 `yuque.com`、`nlark.com` 及其子域名；
- 禁止自动重定向；
- 响应 Content-Type 必须为图片；
- Content-Length 和实际累计字节执行双重限制；
- 优先尝试受控公开地址；
- 失败后才使用图片来源账号的 Cookie 会话；
- Cookie、请求头、响应头和图片字节不进入日志。

查看或保存原图时会移除 `x-oss-process` 等图片变换参数，避免把缩略图误当原图。

## 8. WordPress CDN 兼容模式

兼容模式默认关闭。

开启后，只有本地缓存、受控公开回源和语雀会话回源都失败时，才会把经过白名单校验的语雀/Nlark 地址转换为 `i3.wp.com` 代理地址。

风险：

- WordPress.com 服务器会访问图片；
- 图片可能被第三方缓存；
- 第三方服务的可用性和隐私策略不受 QuePic 控制。

敏感、内部、医疗、个人隐私或受访问控制的图片不应开启该模式。

## 9. 本地 Asset Protocol

Tauri Asset Protocol 只开放：

```text
$APPCACHE/previews/**
```

不开放：

- SQLite 数据库；
- 应用数据目录其他文件；
- 系统密钥库；
- 任意用户目录；
- 备份文件；
- 日志。

缓存目录名由 64 位十六进制 SHA-256 派生，Rust 验证摘要格式并拒绝路径穿越。

## 10. CSP 与 capability

主窗口 capability 当前只包含：

```json
{
  "windows": ["main"],
  "permissions": ["core:default"]
}
```

CSP 仅允许：

- 应用自身资源；
- Tauri Asset Protocol；
- `data:` / `blob:` 临时图片；
- 用户主动开启时的 `https://i3.wp.com` 图片；
- Tauri IPC。

WebView 不直接允许语雀/Nlark 远程图片域名，避免前端绕过 Rust 回源边界。

## 11. SQLite 与备份恢复

SQLite 使用 WAL 模式。`AppState` 通过数据库级 `RwLock` 协调：

- 普通命令持有读锁；
- 备份导入、导出和数据库替换持有写锁。

完整恢复执行：

1. 校验 ZIP 路径、条目数量和解压体积；
2. 校验 manifest 和设置；
3. 校验 SQLite 完整性及必要表结构；
4. 对当前数据库执行受控 WAL checkpoint；
5. 同磁盘暂存新数据库和缓存；
6. 备份当前数据库、sidecar 和缓存；
7. 替换并重新初始化；
8. 重建缓存索引；
9. 全部成功后删除旧备份；
10. 任一步失败时恢复原数据库和缓存。

Cookie 与 Token 不进入备份。Issue #22 继续补齐前端全局维护态以及更完整的并发、WAL 和失败路径测试。

## 12. 删除语义

- 删除图片记录：删除 SQLite 记录及对应本地缓存，不删除语雀远程附件；
- 清理本地缓存：删除预览文件和缓存元数据，保留图片资产和远程 URL；
- 清除 Cookie：删除 Manifest 和全部 Cookie 分片；
- 清除 Token：删除对应系统密钥库条目；
- 删除语雀文档：通过 OpenAPI 删除远程文档，不能恢复。

## 13. 日志与诊断

当前实现不记录：

- Cookie；
- Token；
- Authorization；
- 完整请求头；
- 图片字节；
- 完整语雀响应体。

未来诊断报告必须脱敏账号、本地路径和远程链接查询参数，并继续排除凭据与图片内容。见 Issue #34。

## 14. 当前限制

- 语雀网页接口可能变化；
- CI 不使用真实账号，不能覆盖全部线上风控；
- 文件夹任务尚不能跨应用退出恢复；
- 部分业务设置仍在 localStorage；
- WordPress CDN 属于第三方兼容方案；
- Windows 安装包尚未商业签名，macOS 尚未公证。

这些限制不能通过降低凭据、域名、重定向、文件访问或备份安全约束来解决。
