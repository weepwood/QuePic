# 安全说明

## Cookie 权限

语雀 Cookie 是网页登录会话凭据。不要把真实 Cookie 提交到仓库、Issue、PR、截图或日志；疑似泄露时应立即退出全部语雀会话并重新登录。

## 本地保存

QuePic 使用 keyring-rs 调用平台安全存储：

- Windows Credential Manager
- macOS Keychain
- Linux Secret Service

SQLite 只保存账号名称，不保存 Cookie。React 前端没有读取 Cookie 的命令，只能保存、检查是否存在和清除。

## 网络边界

带 Cookie 的请求只由 Rust 后端发送到固定地址：

```text
https://www.yuque.com/api/upload/attach
```

当前 Tauri capability 只启用 `core:default` 与应用自定义 IPC 命令，没有通用 HTTP、Shell 或任意文件系统权限。

## 日志与响应

当前实现不记录 Cookie、请求头、图片字节和完整语雀响应。接口会单独识别 401/403、HTML 登录页、JSON 结构变化和缺失 `data.url`。

## 删除语义

QuePic 暂无可靠的语雀远程删除接口。“删除图片”仅删除本地 SQLite 索引，不会删除语雀服务器上的图片。
