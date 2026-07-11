# Supersystem GitHub SaaS 提供者配置教程

> 适用对象：计划托管 Supersystem 服务，并让其他用户直接安装同一个 GitHub App 的服务提供者。  
> 文档状态：V1.2 配置与实现基线。当前 V1.1 已支持 Client ID、Device Flow API 和 token/env-ref 降级，但尚未实现完整 installation、App JWT、webhook 与生产级密钥存储。

## 1. SaaS 提供者需要承担什么

SaaS 模式下，普通用户只负责登录、授权、安装 App 和选择仓库。以下能力由提供者统一维护：

- 一个由提供者拥有的 GitHub App；
- 公网 HTTPS 域名和持续在线的 API 服务；
- GitHub App Private Key、Client Secret、Webhook Secret 的安全存储；
- OAuth 回调、安装回调和 webhook 接收端点；
- 用户、installation、仓库授权范围的持久化；
- installation access token 的按需生成和短期缓存；
- 密钥轮换、审计、备份、故障监控和用户卸载后的数据清理。

GitHub App 注册本身不收费。主要成本来自域名、服务器、数据库、密钥管理、监控和运维。

## 2. 上线前准备清单

至少准备：

| 项目 | 最低要求 |
|---|---|
| GitHub 账号 | 由长期可控的个人账号或组织拥有 GitHub App。正式服务推荐组织持有。 |
| 公网域名 | 例如 `https://supersystem.example.com`，生产环境必须使用 HTTPS。 |
| API 服务 | 能处理 OAuth、installation setup、webhook 和 GitHub API 请求。 |
| 持久化 | 保存用户绑定、installation ID、仓库授权和审计事件。生产环境不能只依赖本地 JSON。 |
| 密钥存储 | 云 Secret Manager、Vault 或受限服务器文件；Private Key 绝不能进入浏览器。 |
| 后台任务 | 处理 webhook、token 刷新、仓库同步和重试。小规模可先在 API 进程中完成。 |
| 监控 | 至少记录 webhook delivery、GitHub API 错误率、token 生成失败和安装状态。 |

## 3. 创建和配置 GitHub App

进入 GitHub：

```text
Settings
  -> Developer settings
  -> GitHub Apps
  -> New GitHub App
```

### 3.1 基础字段

以下以 `https://supersystem.example.com` 为例。域名需要替换为你的实际地址。

| GitHub 字段 | 推荐值 | 说明 |
|---|---|---|
| GitHub App name | `Supersystem` 或唯一品牌名 | GitHub 全局唯一。测试和生产建议分别创建 App。 |
| Homepage URL | `https://supersystem.example.com` | 用户查看 App 时进入的产品首页。 |
| Callback URL | `https://supersystem.example.com/integrations/github/oauth/callback` | 浏览器 OAuth Web Flow 回调；属于 V1.2 目标端点。 |
| Expire user authorization tokens | 开启 | 获得短期 user token 和 refresh token，便于撤销和轮换。 |
| Request user authorization during installation | 开启 | 安装时同时完成用户身份授权，减少一次操作。 |
| Enable Device Flow | 开启 | 支持 CLI、本地客户端或无法稳定接收浏览器回调的场景。 |
| Setup URL | `https://supersystem.example.com/integrations/github/install/setup` | GitHub 安装完成后携带 `installation_id` 和 `setup_action` 返回。 |
| Redirect on update | 开启 | 用户增删授权仓库后回到系统重新同步。 |
| Webhook Active | 开启 | SaaS 模式需要实时接收安装、仓库、push 和 PR 变化。 |
| Webhook URL | `https://supersystem.example.com/integrations/github/webhook` | 必须可被 GitHub 公网访问。 |
| Webhook Secret | 随机高强度字符串 | 建议至少 32 个随机字节，服务端按 HMAC-SHA256 验签。 |
| Installation target | Any account | 允许个人账号和组织安装。无需先进入 GitHub Marketplace。 |

当前代码没有上述 callback/setup/webhook 路由。这些 URL 是 V1.2 的目标接口合同，配置生产 App 前必须先实现并部署。

### 3.2 Repository permissions

按最小权限配置，先满足网站内开发闭环，再按功能增加权限：

| 权限 | 推荐值 | 用途 |
|---|---|---|
| Metadata | Read-only | GitHub App 默认需要，用于识别仓库。 |
| Contents | Read and write | clone/读取代码、创建 commit、更新分支和发布代码。 |
| Pull requests | Read and write | 创建、读取和更新 PR。 |
| Issues | Read and write | 读取开发任务、创建或更新 Issue；不做 Issue 集成时可改为 No access。 |
| Checks | Read and write | 创建检查结果并读取检查状态。 |
| Commit statuses | Read and write | 写入和读取 commit status。 |
| Actions | Read-only | 查看 workflow run 和 artifacts；不展示 Actions 时可关闭。 |
| Workflows | Read and write | 只有允许修改 `.github/workflows/*` 时才开启，并纳入变更审批。 |

以下默认设为 `No access`：

```text
Administration
Secrets
Agent secrets
Dependabot secrets
Codespaces secrets
Deployments
Environments
Pages
Packages
Webhooks
以及没有明确产品功能对应的其他权限
```

GitHub App 自身接收 webhook 不需要 Repository Webhooks 管理权限。

### 3.3 Organization permissions

当前 Supersystem 不提供组织管理能力，全部设为 `No access`。安装到组织仓库并不要求 Administration、Members 或 Webhooks 等组织权限。

未来若确实需要读取团队结构，可以单独申请 `Members: Read-only`，不应预先开启组织管理权限。

### 3.4 Account permissions

推荐：

| 权限 | 推荐值 | 说明 |
|---|---|---|
| Email addresses | Read-only，可选 | 需要读取用户私有主邮箱时才开启。 |
| 其他 Account permissions | No access | GitHub 登录名、头像和公开资料通常不需要写权限。 |

不要申请修改 Profile、SSH keys、GPG keys、Codespaces secrets 等与核心开发流程无关的权限。

### 3.5 Subscribe to events

最小事件集：

```text
Installation
Installation repositories
Push
Pull request
Check run
Check suite
Workflow run          # 仅在启用 Actions 读取时
Issues                # 仅在启用 Issue 集成时
Issue comment         # 仅在需要评论交互时
```

应用必须幂等处理 webhook：以 GitHub delivery ID 去重，失败后允许重试，不能因为重复 delivery 重复创建 PR 或运行任务。

## 4. 生成并保存凭据

GitHub App 创建后会获得：

| 凭据 | 是否敏感 | 用途 |
|---|---:|---|
| App ID | 否 | 生成 App JWT 时标识 App。 |
| Client ID | 否 | OAuth / Device Flow 客户端标识。 |
| Client Secret | 是 | OAuth Web Flow 交换 user access token。 |
| Private Key (`.pem`) | 是，最高敏感级别 | 签发 App JWT，进而为所有 installations 生成 installation token。 |
| Webhook Secret | 是 | 校验 webhook 来源和完整性。 |

Private Key 不能提交到 Git、写入 `config/github-app.local.example.json`、返回给前端或记录到 Trace。建议：

1. 在 GitHub 生成 Private Key 后立即放入 Secret Manager 或服务器受限目录。
2. 只把文件路径或 secret reference 传给进程。
3. 定期生成新 key、切换服务、确认成功后删除旧 key。
4. Client Secret 和 Webhook Secret 采用相同轮换与审计策略。

## 5. 服务端配置合同

当前实现只读取 `GITHUB_OAUTH_CLIENT_ID` 和 `AIWS_GITHUB_APP_CONFIG`。V1.2 SaaS 模式应支持以下配置合同：

```dotenv
GITHUB_APP_MODE=hosted
GITHUB_APP_ID=<github-app-id>
GITHUB_APP_SLUG=<github-app-slug>
GITHUB_OAUTH_CLIENT_ID=<client-id>
GITHUB_CLIENT_SECRET=<client-secret-or-secret-ref>
GITHUB_PRIVATE_KEY_PATH=/run/secrets/github-app-private-key.pem
GITHUB_WEBHOOK_SECRET=<webhook-secret-or-secret-ref>
GITHUB_APP_INSTALL_URL=https://github.com/apps/<github-app-slug>/installations/new
PUBLIC_BASE_URL=https://supersystem.example.com
```

生产环境推荐把 Secret 作为容器 secret 或平台 secret 注入，而不是保存为普通 `.env` 文件。

公开配置可以保留在 JSON 中：

```json
{
  "github": {
    "mode": "hosted",
    "app_name": "Supersystem",
    "app_id": "<github-app-id>",
    "app_slug": "<github-app-slug>",
    "oauth_client_id": "<client-id>",
    "homepage_url": "https://supersystem.example.com",
    "device_flow_enabled": true
  }
}
```

JSON 中仍然不能出现 Client Secret、Private Key 或 Webhook Secret。

## 6. SaaS 完整授权链路

目标流程：

```text
用户登录 Supersystem
  -> GitHub OAuth / Device Flow 绑定用户身份
  -> 用户安装 Supersystem GitHub App
  -> GitHub 回调 setup URL，并携带 installation_id
  -> 后端校验当前用户可管理该 installation
  -> 同步 installation 可访问的 repositories
  -> 用户把 repository 绑定到 Supersystem Project
  -> 后端按需生成最长约 1 小时有效的 installation token
  -> Runner 使用短期 token clone / fetch / push / 创建 PR
  -> webhook 持续同步安装、仓库、push、PR 和 checks 状态
```

User token 用于确认“当前操作者是谁、在 GitHub 上有什么权限”；installation token 用于 App 自动化。协作者必须同时通过 Supersystem 项目角色和 GitHub repo 权限校验。

## 7. 服务端必须保存的数据

至少保存：

```text
GitHubConnectedAccount
  user_id, github_user_id, login, token_ref, scopes, expires_at

GitHubInstallation
  installation_id, account_id, account_type, app_id, status, suspended_at

GitHubInstallationRepository
  installation_id, repository_id, owner, name, permissions, selected_at

GitHubWebhookDelivery
  delivery_id, event, action, installation_id, status, received_at, processed_at

ProjectRepositoryBinding
  project_id, repository_id, installation_id, default_branch, access_summary
```

不应长期保存 installation access token；应在需要时生成并仅短期缓存。User token、refresh token 和所有 Secret 只保存加密值或 secret reference。

## 8. 本地开发和生产环境区别

### 本地开发

- Device Flow 可以直接使用 `localhost`；
- setup callback 可回到同一台电脑的 `localhost`；
- GitHub 无法向普通 `localhost` 投递 webhook，需要 HTTPS tunnel 或关闭 webhook 后轮询；
- 使用测试 GitHub App，避免污染生产 installation。

### 生产

- 所有 callback/setup/webhook URL 使用稳定 HTTPS 域名；
- 至少区分测试和生产 GitHub App；
- 数据库存储 installation 与仓库绑定；
- Secret 由专用密钥系统托管；
- 对 GitHub API 限流、5xx、webhook 重试和 App suspension 做监控。

## 9. 上线验收清单

- [ ] 普通用户不需要输入 App ID、Client Secret 或 Private Key。
- [ ] OAuth `state` 可防止跨站请求伪造。
- [ ] 安装完成后能保存正确的 `installation_id`。
- [ ] 只显示 installation 已授权的仓库。
- [ ] installation token 不进入 API 响应、日志、Context Pack 或 Trace。
- [ ] webhook 签名错误时返回拒绝，delivery 可去重。
- [ ] 用户移除仓库或卸载 App 后，系统及时禁止远程写入。
- [ ] 协作者没有 GitHub repo 权限时，即使是系统成员也不能操作仓库。
- [ ] 修改 workflow、强制 push、删除分支等高风险动作受审批限制。
- [ ] Private Key 和 Client Secret 完成轮换演练。

## 10. 当前项目状态

V1.1 当前可用：

```text
POST /integrations/github/oauth/device/start
POST /integrations/github/oauth/device/poll
GET  /integrations/github/status
token / env-ref 绑定
未绑定时生成 PR 草稿
```

尚待 V1.2 实现：

```text
OAuth Web Flow callback
installation setup callback
App JWT
installation access token
installation/repository 持久化
webhook 验签、去重和事件同步
托管 App / BYO App 配置切换
生产级加密凭据存储
```

## 11. GitHub 官方资料

- 创建 GitHub App：https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
- GitHub App 权限：https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- 生成 App JWT：https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
- 生成 installation token：https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
- Webhook 验签：https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries

