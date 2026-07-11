# 独立开发者：无 SaaS 服务时的 GitHub 配置教程

> 适用对象：自己在本机或私有服务器运行 Supersystem，不依赖 Supersystem SaaS 提供者。  
> 目标：由开发者自己拥有 GitHub App 和全部凭据，获得最大自主权。  
> 推荐顺序：优先使用 GitHub App Manifest 快速创建；Manifest 不可用时再手动创建。

## 1. 这种模式意味着什么

你同时承担用户和服务提供者两种角色：

```text
GitHub App 属于你
Private Key 只保存在你的机器/服务器
installation 只授权给你选择的仓库
Supersystem 以你的 App 身份执行自动化
没有第三方 SaaS 持有你的 GitHub 凭据
```

代价是首次配置更多，而且每套独立部署都要维护自己的 GitHub App、密钥和 callback/webhook 地址。

## 2. 开始前准备

- GitHub 账号；
- 对目标仓库的管理员权限，或组织管理员批准 App installation；
- 已启动的 Supersystem，本地默认地址为 `http://localhost:4317`；
- 一个不会提交到 Git 的密钥目录；
- 如需实时 webhook，准备一个公网 HTTPS 地址或 HTTPS tunnel。

建议本地目录：

```text
.ai-workspace/
  secrets/
    github-app-private-key.pem
```

`.ai-workspace/` 已被 Git 忽略。不要把 Private Key 放进 `config/` 或任何会提交的文件。

## 3. 路径 A：使用 GitHub App Manifest，推荐

### 3.1 Manifest 解决什么

GitHub App Manifest 允许 Supersystem 预先生成 App 名称、URL、权限和事件配置。你在 GitHub 确认后，GitHub 把一次性 `code` 返回本地系统；系统用它换取新 App 的 App ID、Client ID、Client Secret、Webhook Secret 和 Private Key。

优势：

- 不需要在 GitHub 页面逐项勾选大量权限；
- 减少 URL、权限和事件配置错误；
- 可以在本地引导页完成创建、接收凭据和安装；
- 用户仍然是 GitHub App 的所有者。

限制：

- Manifest 只用于创建新 GitHub App，不是更新已有 App；
- 回调 code 是一次性的并有时效，失败后需要重新发起；
- 当前 V1.1 尚未实现 Manifest 创建和 conversion 接口，这是 V1.2 目标能力。

### 3.2 V1.2 目标流程

```text
打开 Supersystem Settings -> GitHub -> 自托管 / BYO App
  -> 选择“通过 Manifest 创建”
  -> 系统生成 manifest + state
  -> 浏览器进入 GitHub App 创建确认页
  -> 确认 App 名称、权限和安装目标
  -> GitHub 回到本地 manifest callback，并携带 code
  -> Supersystem 调用 /app-manifests/{code}/conversions
  -> 凭据写入本地 secret store
  -> 用户安装 App 并选择仓库
  -> Supersystem 保存 installation_id 和仓库授权范围
```

### 3.3 推荐 Manifest 模板

下面是 V1.2 可采用的模板。`redirect_url` 是 Manifest 创建完成后的回调，`setup_url` 是 App 安装完成后的回调，两者不是同一个地址。

```json
{
  "name": "Supersystem-<github-login>-Local",
  "url": "http://localhost:4317",
  "redirect_url": "http://localhost:4317/integrations/github/manifest/callback",
  "callback_urls": [
    "http://localhost:4317/integrations/github/oauth/callback"
  ],
  "hook_attributes": {
    "url": "http://localhost:4317/integrations/github/webhook",
    "active": false
  },
  "setup_url": "http://localhost:4317/integrations/github/install/setup",
  "setup_on_update": true,
  "public": false,
  "request_oauth_on_install": true,
  "default_permissions": {
    "contents": "write",
    "pull_requests": "write",
    "issues": "write",
    "checks": "write",
    "statuses": "write",
    "actions": "read",
    "workflows": "write"
  },
  "default_events": [
    "installation",
    "installation_repositories",
    "push",
    "pull_request",
    "check_run",
    "check_suite",
    "workflow_run"
  ]
}
```

如果不允许系统修改 `.github/workflows/*`，从模板删除 `workflows` 权限。若不使用 Issue 或 Actions，同样删除对应权限和事件。示例将 webhook 标记为 inactive；准备好公网 HTTPS webhook URL 后，再替换 `hook_attributes.url` 并启用。

### 3.4 本地没有公网 webhook 怎么办

Manifest 创建和浏览器 callback 可以返回 `localhost`，因为是你的浏览器在跳转；GitHub webhook 服务器无法访问普通 `localhost`。

可以选择：

1. **不启用 webhook**：系统通过手动刷新或轮询同步 GitHub，适合单人本地开发。
2. **使用 HTTPS tunnel**：把 webhook URL 指向临时公网 HTTPS 地址，适合开发验证。
3. **部署到自己的服务器**：使用长期域名，适合持续使用和未来协作。

即使没有 webhook，installation token、clone、push 和 PR 能力仍可工作，只是远端变化不能实时推送到本地系统。

## 4. 路径 B：不使用 Manifest，手动创建

当前项目更接近这条路径，因为已经能读取公开 Client ID 并启动 Device Flow。

### 4.1 创建 App

进入：

```text
GitHub Settings
  -> Developer settings
  -> GitHub Apps
  -> New GitHub App
```

填写：

| 字段 | 本地推荐值 |
|---|---|
| GitHub App name | `Supersystem-<你的用户名>-Local`，必须全局唯一 |
| Homepage URL | `http://localhost:4317` |
| Callback URL | `http://localhost:4317/integrations/github/oauth/callback`，当前未实现，可先使用 Device Flow |
| Expire user authorization tokens | 开启 |
| Request user authorization during installation | 开启 |
| Enable Device Flow | 开启 |
| Setup URL | `http://localhost:4317/integrations/github/install/setup`，属于 V1.2 目标端点 |
| Redirect on update | 开启 |
| Webhook | 没有公网地址时关闭；有 HTTPS tunnel 时开启 |
| Installation target | 仅个人使用时选 Only on this account |

如果你希望未来把自己创建的 App 安装到其他账号或组织，可以选 `Any account`，但不要因此扩大权限。

### 4.2 配置权限

推荐：

```text
Repository permissions
  Metadata: Read-only
  Contents: Read and write
  Pull requests: Read and write
  Issues: Read and write               # 不使用 Issue 时关闭
  Checks: Read and write
  Commit statuses: Read and write
  Actions: Read-only                   # 不展示 workflow 时关闭
  Workflows: Read and write            # 只有确实修改 workflow 时开启

Organization permissions
  全部 No access

Account permissions
  Email addresses: Read-only           # 可选
  其他全部 No access
```

事件订阅与权限保持一致，最小选择：

```text
Installation
Installation repositories
Push
Pull request
Check run
Check suite
Workflow run                          # 可选
Issues / Issue comment                # 可选
```

### 4.3 生成凭据

在 GitHub App 设置页记录：

```text
App ID
Client ID
App slug
```

然后：

1. 生成 Client Secret；
2. 生成 Private Key，下载 `.pem`；
3. 自己生成 Webhook Secret（仅 webhook 开启时）；
4. 把 `.pem` 移到 `.ai-workspace/secrets/`；
5. 不要把任何 Secret 写入公开 JSON。

Client ID 是公开标识，可以放在 `config/github-app.local.example.json`。Client Secret、Private Key、Webhook Secret 必须通过环境变量、文件路径或本地 secret store 提供。

### 4.4 本地配置

当前 V1.1 可用配置：

```powershell
$env:GITHUB_OAUTH_CLIENT_ID="<client-id>"
corepack pnpm dev
```

也可以使用公开配置文件：

```json
{
  "github": {
    "app_name": "Supersystem-YourName-Local",
    "app_id": "<app-id>",
    "oauth_client_id": "<client-id>",
    "homepage_url": "http://localhost:4317",
    "device_flow_enabled": true
  }
}
```

当前读取路径是：

```text
config/github-app.local.example.json
```

也可以设置：

```powershell
$env:AIWS_GITHUB_APP_CONFIG="E:\path\to\github-app.local.json"
```

V1.2 BYO App 目标配置：

```powershell
$env:GITHUB_APP_MODE="byo"
$env:GITHUB_APP_ID="<app-id>"
$env:GITHUB_APP_SLUG="<app-slug>"
$env:GITHUB_OAUTH_CLIENT_ID="<client-id>"
$env:GITHUB_CLIENT_SECRET="<从安全存储注入>"
$env:GITHUB_PRIVATE_KEY_PATH="E:\00_desktop\毕业设计\.ai-workspace\secrets\github-app-private-key.pem"
$env:GITHUB_WEBHOOK_SECRET="<仅启用 webhook 时>"
corepack pnpm dev
```

这些 V1.2 Secret 配置项当前尚未接入运行时代码。

### 4.5 安装 App

创建后打开 GitHub App 的公开/安装页：

```text
https://github.com/apps/<app-slug>/installations/new
```

选择：

- 安装到自己的个人账号；
- `Only select repositories`；
- 勾选需要在 Supersystem 中开发的仓库；
- 完成安装后返回 Supersystem。

个人开发默认推荐只选择需要使用的仓库，而不是授权所有仓库。

## 5. 无 SaaS 模式的日常使用

完整目标体验：

```text
启动本地 Supersystem
  -> 检查 GitHub 用户绑定
  -> 检查 App installation 和 repo 授权
  -> 选择或导入 repo
  -> 创建 task branch
  -> 在 Node Workspace 中调用 Codex Docker Runner
  -> 查看 diff 和测试
  -> 用户批准 commit / push
  -> 创建 PR
  -> Review 页面保留 proposal、Trace、commit 和 PR 证据链
```

个人开发者在该部署中就是 Owner，拥有与主用户相同的系统权限。写文件、修改 workflow、切换 Runner/profile 等高风险动作仍然经过变更说明和审批。

## 6. 自检清单

- [ ] Client ID 能启动真实 Device Flow。
- [ ] Private Key 文件不在 Git tracked files 中。
- [ ] App 只安装到预期账号和仓库。
- [ ] 仓库授权被移除后不能继续 push。
- [ ] installation token 不出现在日志和前端响应中。
- [ ] 能 clone/fetch、创建分支、commit、push 和创建 PR。
- [ ] 没有 webhook 时，界面明确显示“轮询/手动刷新模式”。
- [ ] 有 webhook 时，签名校验和 delivery 去重生效。

## 7. 常见问题

### Device Flow 成功，但不能操作仓库

用户 OAuth 和 App installation 是两件事。检查 App 是否已安装到目标账号、目标仓库是否被选中，以及系统是否保存了正确的 `installation_id`。

### 为什么只有 Client ID 仍不够

Client ID 可以发起 OAuth / Device Flow，但 installation token 需要 `App ID + Private Key`。没有 installation token，就不能以 GitHub App 身份稳定执行后台仓库操作。

### 本地一定需要 Client Secret 吗

只使用 Device Flow 时不需要 Client Secret；使用 OAuth Web Flow 时需要。完整 App installation 仍然需要 App ID 和 Private Key。

### 为什么 webhook 收不到

GitHub 服务器无法访问你的 `localhost`。关闭 webhook 并使用轮询，或配置公网 HTTPS tunnel/自托管服务器。

## 8. GitHub 官方资料

- GitHub App Manifest：https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
- Device Flow：https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
- installation token：https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- 安装 GitHub App：https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app
