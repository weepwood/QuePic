# 安全说明

## Cookie 权限

语雀 Cookie 是网页登录会话凭据。不要把真实 Cookie 提交到仓库、Issue、PR、截图或日志；疑似泄露时应立即退出全部语雀会话并重新登录。

QuePic 的登录窗口只用于完成语雀网页登录。应用不会读取或保存语雀密码，只会在用户明确点击“完成登录并保存”后读取匹配 `https://www.yuque.com/api/upload/attach` 的 Cookie，包括 HttpOnly 与 Secure Cookie。

## 本地保存

QuePic 使用 keyring-rs 调用平台安全存储：

- Windows Credential Manager
- macOS Keychain
- Linux Secret Service

Windows Credential Manager 的单条密码存在 UTF-16 长度限制。QuePic 会把长 Cookie 拆分为多个不超过安全阈值的凭据分片，并用短 Manifest 保存当前分片代次和数量。新分片全部写入成功后才切换 Manifest，避免半写入状态覆盖旧凭据。

SQLite 只保存账号名称，不保存 Cookie。React 前端没有读取 Cookie 的命令，只能发起登录窗口、请求后端捕获会话、手动保存、检查是否存在和清除。

## 登录窗口边界

- 登录窗口使用独立的 Tauri WebViewWindow；
- 只允许 HTTPS 与 `about:` 导航；
- Cookie 读取由 Rust 后端执行，不通过页面 JavaScript，因此能够包含 HttpOnly Cookie；
- Windows 上 Cookie 读取放入独立阻塞线程，避免 WebView2 同步调用死锁；
- 登录完成后成功保存凭据会关闭登录窗口；
- 登录窗口中的会话由系统 WebView 配置管理，QuePic 只把语雀上传地址所需 Cookie 写入自身密钥库。

## 上传网络边界

带 Cookie 的上传请求只由 Rust 后端发送到固定地址：

```text
https://www.yuque.com/api/upload/attach
```

上传客户端禁止自动重定向，避免 Cookie 被带到其他域名。返回的图片链接必须是 HTTPS，并且域名属于 `yuque.com`、`nlark.com` 或其子域名。

## 历史图片回源边界

前端只能调用：

```text
ensure_preview(asset_id)
```

不能向后端提交任意 URL。Rust 根据 `asset_id` 从 SQLite 读取已保存且经过验证的远程地址，再执行回源，因此该命令不是通用 HTTP 代理。

回源约束：

- 仅允许 `yuque.com`、`nlark.com` 及其子域名；
- 仅允许 HTTPS；
- 禁止自动重定向；
- 请求附带语雀 Cookie 和 `Referer: https://www.yuque.com/`；
- 响应 `Content-Type` 必须以 `image/` 开头；
- 根据 Content-Length 和流式累计结果执行 30 MB 双重限制；
- 不把 Cookie、响应头或图片字节写入日志；
- 下载成功后才写入本地缓存和数据库缓存状态。

## 本地 Asset Protocol 边界

QuePic 只通过 Tauri Asset Protocol 暴露：

```text
$APPCACHE/previews/**
```

数据库、系统凭据、应用数据目录和其他缓存文件不在 scope 中。缓存文件名由 SHA-256 派生，Rust 会验证摘要只能包含 64 位十六进制字符，拒绝路径穿越输入。

CSP 的图片来源仅允许：

- 应用自身与 Tauri Asset Protocol；
- `data:` / `blob:` 临时预览；
- 实验性 `https://i3.wp.com` 兼容代理。

语雀原始 CDN 域名不再直接开放给 WebView 图片标签。

## WordPress CDN 兼容模式

WordPress CDN 代理默认关闭。用户主动开启后，只有本地缓存与 Rust 语雀回源都失败时才会生成 `i3.wp.com` 地址。

安全约束：

- 转换前仍执行语雀 / nlark 域名白名单校验；
- 不接受任意第三方 URL；
- 代理地址只用于当前预览，不覆盖 SQLite 中的原始远程 URL；
- 界面明确提示图片可能被 WordPress.com 服务器访问和缓存；
- 敏感、内部、医疗或隐私图片不建议开启该模式。

## 缓存删除语义

- 删除图片记录：删除 SQLite 记录及对应本地缓存，不删除语雀远程图片；
- 清理本地缓存：删除缓存目录和 `asset_previews` 元数据，保留 `assets` 与远程 URL；
- 清除凭据：删除系统密钥库中的 Manifest 与全部 Cookie 分片；
- 缓存清理后重新显示历史图片，需要有效语雀登录会话或用户主动开启兼容代理。

## 日志与响应

当前实现不记录 Cookie、请求头、图片字节和完整语雀响应。接口会单独识别 401/403、HTML 登录页、JSON 结构变化、非图片响应、重定向和超出大小限制。

## 当前限制

- 语雀上传和图片读取接口均不是公开稳定 API；
- CI 不使用真实语雀账号，因此无法覆盖线上防盗链规则变化；
- WordPress CDN 是第三方兼容兜底，不属于 QuePic 可控基础设施；
- 当前只有手动清理缓存，尚未实现缓存配额和 LRU 自动回收。
