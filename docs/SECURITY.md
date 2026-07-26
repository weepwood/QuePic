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

## 网络边界

带 Cookie 的请求只由 Rust 后端发送到固定地址：

```text
https://www.yuque.com/api/upload/attach
```

上传客户端禁止自动重定向，避免 Cookie 被带到其他域名。返回的图片链接也必须通过允许域名校验。

当前 Tauri capability 只启用 `core:default` 与应用自定义 IPC 命令，没有通用 HTTP、Shell 或任意文件系统权限。

## 日志与响应

当前实现不记录 Cookie、请求头、图片字节和完整语雀响应。接口会单独识别 401/403、HTML 登录页、JSON 结构变化和缺失 `data.url`。

## 删除语义

QuePic 暂无可靠的语雀远程删除接口。“删除图片”仅删除本地 SQLite 索引，不会删除语雀服务器上的图片。“清除凭据”会删除 QuePic 在系统密钥库中的 Manifest 与全部 Cookie 分片。
