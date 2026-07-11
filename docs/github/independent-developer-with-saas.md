# 独立开发者：有 SaaS 服务时的 GitHub 使用教程

> 适用对象：使用 Supersystem 托管服务，不自己创建和维护 GitHub App 的个人开发者。  
> 目标：用最低配置成本完成 GitHub 强绑定，并获得接近本地开发的仓库操作体验。  
> 当前状态：这是 V1.2 完整 SaaS 体验说明；V1.1 前端仍使用 mock Device Flow，真实 installation 尚未实现。

## 1. 你需要准备什么

普通个人开发者只需要：

- 一个 GitHub 账号；
- 对目标仓库有访问权限；
- 安装 App 时，对个人仓库拥有安装权；组织仓库可能需要组织管理员批准；
- 一个现代浏览器。

你不需要创建 GitHub App，也不需要提供：

```text
App ID
Client ID
Client Secret
Private Key
Webhook Secret
Callback URL
Webhook URL
```

这些由 SaaS 提供者统一维护。

## 2. 首次绑定流程

目标流程：

### 第一步：登录 Supersystem

创建或进入你的项目空间。个人项目中，你默认是 Owner，具有主用户权限。

### 第二步：绑定自己的 GitHub 身份

点击：

```text
Settings / 开局引导
  -> GitHub
  -> 绑定 GitHub
```

浏览器模式通常直接跳转 GitHub 授权；Device Flow 模式会显示：

```text
verification_uri
user_code
expires_in
```

打开 verification URL，输入 user code 并确认授权。必须登录你实际用于开发的 GitHub 账号，不能由项目 Owner 代替协作者绑定。

### 第三步：安装 Supersystem GitHub App

完成身份授权后点击“安装 GitHub App”。在 GitHub 选择安装账号：

- 个人仓库：选择自己的个人账号；
- 组织仓库：选择对应组织，必要时等待组织管理员批准。

推荐选择：

```text
Only select repositories
```

只授权你计划在 Supersystem 中使用的仓库。以后可以在 GitHub App installation 设置中增删仓库。

### 第四步：返回并检查三项状态

Supersystem 应分别显示：

```text
GitHub 身份：已绑定，显示 login/avatar
GitHub App：已安装，显示安装账号
Repository：已授权，显示可用仓库和 pull/push 权限
```

“账号已绑定”不等于“仓库已授权”。OAuth 成功但 App 未安装时，系统只能识别你，不能以 App 身份操作私有仓库。

### 第五步：把仓库绑定到项目

从已授权仓库列表选择一个 repo，确认：

```text
owner/repo
default branch
当前用户权限
App installation 权限
本地工作目录
```

绑定成功后进入 Node Workspace 或 Git/PR 工作区。

## 3. 日常开发体验

SaaS 模式的目标不是只做“登录 GitHub”，而是让网站开发过程接近本地：

```text
选择 GitHub repo
  -> 系统准备隔离的工作副本
  -> 从默认分支创建 task branch
  -> Node/Sub Workspace 使用独立 Codex 会话
  -> Codex Docker Runner 修改文件并运行测试
  -> 用户查看 diff、Trace、测试和变更说明
  -> 用户批准 commit / push
  -> 创建 Pull Request
  -> Review 页面追溯 proposal -> approval -> commit -> PR
```

Provider 应使用短期 installation access token 完成 clone/fetch/push/API 操作。你不会看到 Private Key，也不需要手动复制 token。

## 4. 个人开发者与 Owner 权限

个人项目中：

```text
个人开发者 = Project Owner = 主用户
```

Owner 应能：

- 选择和解绑仓库；
- 创建分支、commit、push 和 PR；
- 读取 Issue、PR、Checks 和 workflow 状态；
- 管理项目的 Codex、Docker、cc-switch 配置；
- 审批节点本质变更、写文件运行和全局配置变更；
- 邀请或移除未来协作者。

“完整权限”仍受 GitHub 自身限制。例如 Owner 没有某个组织仓库的写权限，Supersystem 也不能绕过 GitHub 获得写权限。

## 5. 未来协作者如何加入

GitHub App 对仓库通常只安装一次，但每个协作者仍应绑定自己的 GitHub 账号。

协作者执行操作前需要同时通过：

```text
Supersystem 项目成员身份
+ GitHub 用户对 repo 的真实权限
+ GitHub App 对 repo 的 installation 权限
+ 项目审批策略
```

推荐默认：

- Owner：管理仓库绑定、成员、Runner/profile 和关键审批；
- Collaborator：在 task branch 工作、提交 proposal、创建 PR；
- Reviewer：查看 Trace/diff，评论或完成授权范围内的审批；
- 没有 GitHub repo 权限的成员：不能读取或操作该 repo。

这样可以避免共享 Owner token，也不会让网站成员绕过 GitHub 仓库权限。

## 6. 你会授予什么权限

安装页面应展示 GitHub App 请求的 repository permissions。Supersystem 的推荐权限及用途：

| 权限 | 用途 |
|---|---|
| Contents: Read and write | 读取和提交代码、创建分支。 |
| Pull requests: Read and write | 创建和更新 PR。 |
| Issues: Read and write | 把 Issue 作为工作输入并回写状态，可选。 |
| Checks / Commit statuses: Read and write | 展示和写入测试/检查结果。 |
| Actions: Read-only | 查看 workflow run 和 artifacts，可选。 |
| Workflows: Read and write | 修改 GitHub Actions workflow，仅在该功能启用时授予。 |

以下不是个人开发闭环的默认要求：组织管理、成员管理、Secrets、SSH/GPG keys、Codespaces secrets、仓库 Administration。

## 7. 安全与隐私边界

SaaS 提供者持有 GitHub App Private Key，因此理论上能为已安装的仓库签发 installation token。选择 SaaS 前应确认提供者说明：

- 数据保存位置和保留期限；
- 源码是否被持久化；
- Codex/模型调用会发送哪些内容；
- 谁可以访问生产 Secret；
- 是否记录 GitHub API 审计；
- 如何删除账户、installation 绑定和缓存工作副本；
- 安全事件和密钥轮换流程。

你可以随时在 GitHub 中：

```text
Settings -> Applications -> Installed GitHub Apps
```

修改授权仓库或卸载 App。卸载后 Supersystem 必须停止远程操作；历史 Trace、commit 和 PR 引用如何保留，应按服务的数据政策执行。

## 8. 解绑和更换账号

推荐顺序：

1. 在 Supersystem 中停止正在运行的 GitHub/Codex 任务；
2. 解绑项目和 repo；
3. 断开 GitHub user authorization；
4. 如果不再使用服务，在 GitHub 卸载 App；
5. 在 Supersystem 请求删除工作副本和已缓存数据。

只“断开 OAuth”不一定会自动卸载 App；只“卸载 App”也不等于删除 SaaS 账户，需要分别处理。

## 9. 常见状态与处理

| 状态 | 含义 | 处理 |
|---|---|---|
| GitHub 未绑定 | 系统不知道当前 GitHub 用户 | 重新完成 OAuth / Device Flow。 |
| 已绑定、未安装 | 用户身份已确认，但没有 installation | 点击安装 App 并选择账号。 |
| 已安装、repo 未授权 | App 存在，但目标 repo 不在选定列表 | 在 GitHub installation 设置中添加 repo。 |
| Read-only | 用户或 App 只有读权限 | 让仓库管理员授予写权限，或只生成 PR 草稿。 |
| Installation suspended | App 安装被暂停 | 由安装账号 Owner 在 GitHub 恢复。 |
| Token expired | 短期 token 已过期 | 系统自动重新生成，不应要求用户粘贴 token。 |
| 组织审批中 | 组织策略要求管理员批准 | 等待组织 Owner 审批 App 安装。 |

## 10. 当前版本如何体验

V1.1 页面中的“GitHub OAuth 绑定”目前调用 mock 路径，用于毕业设计演示。API 已提供真实 Device Flow 基础端点，但完整 SaaS installation 流程尚未完成。

当前可运行：

```text
POST /integrations/github/oauth/device/start
POST /integrations/github/oauth/device/poll
GET  /integrations/github/status
```

V1.2 完成后，本文中的安装、仓库选择、权限校验和短期 token 流程才构成完整 SaaS 使用体验。

