# GitHub 三种使用模式对比

> 本文对比三种角色/模式：SaaS 提供者、无 SaaS 的独立开发者、有 SaaS 的独立开发者。  
> 核心产品决策：Supersystem 最终采用“双模式”产品能力，即托管 GitHub App + 用户自带 GitHub App；“SaaS 提供者”是托管模式的运营方，“有 SaaS 的独立开发者”是该模式的使用者。

## 1. 三种模式分别是什么

### A. SaaS 提供者

你部署公网 Supersystem，拥有一个可安装到任意用户/组织的 GitHub App，并托管 App Private Key、Client Secret、Webhook Secret、installation 和用户数据。

教程：[SaaS 提供者配置教程](./saas-provider-guide.md)

### B. 无 SaaS 的独立开发者

你在本地或自己的服务器运行 Supersystem，创建并拥有自己的 GitHub App。可以通过 Manifest 一键创建，也可以在 GitHub 后台手动创建。

教程：[无 SaaS 独立开发者配置教程](./independent-developer-without-saas.md)

### C. 有 SaaS 的独立开发者

你使用 SaaS 提供者已经部署好的 Supersystem 和共享 GitHub App，只需要登录、授权、安装 App 并选择仓库。

教程：[有 SaaS 独立开发者使用教程](./independent-developer-with-saas.md)

## 2. 核心差异矩阵

| 对比项 | SaaS 提供者 | 无 SaaS 独立开发者 | 有 SaaS 独立开发者 |
|---|---|---|---|
| 角色 | 服务运营方 | 自托管 Owner，同时也是运维者 | 托管服务用户 / 项目 Owner |
| GitHub App 所有者 | 提供者个人或组织 | 开发者本人 | SaaS 提供者 |
| App 创建次数 | 提供者创建一次，服务所有用户 | 每套部署/每位 Owner 通常创建一次 | 不创建 |
| Client Secret / Private Key | 提供者服务器持有 | 开发者本地或私有服务器持有 | 不接触 |
| 用户首次配置 | 高，需部署完整服务 | 中；Manifest 较低，手动创建较高 | 最低，只需授权和安装 |
| 公网 HTTPS | 必须 | 单机使用可不需要；webhook 需要 | 不需要自己准备 |
| Webhook | 生产模式必须 | 可关闭并轮询，也可自建公网入口 | 由提供者处理 |
| 持久化与备份 | 提供者负责 | 开发者自己负责 | 提供者负责 |
| 自主权 | 提供者最高，用户受服务政策约束 | 最高，凭据和数据完全自有 | 中，仓库授权可控但服务端由提供者管理 |
| 配置成本 | 最高 | 中高 | 最低 |
| 运维成本 | 最高 | 单人低到中 | 无基础设施运维 |
| 多设备可用性 | 好 | 取决于自托管地址；纯本机较弱 | 好 |
| 团队协作 | 最容易统一 | 需要自己部署成员系统和公网入口 | 由 SaaS 提供协作底座 |
| 数据控制 | 提供者控制基础设施 | 开发者完全控制 | 取决于提供者政策 |
| 典型适用 | 产品提供者、公开服务 | 高自主权个人、私有项目、小团队 | 希望开箱即用的个人开发者 |

## 3. 能力可以相同，责任不同

三种模式最终都可以实现：

```text
GitHub 强绑定
选择授权仓库
clone / fetch
创建 branch
修改文件和运行测试
commit / push
创建 PR
读取 Issue / PR / Checks
Codex Docker Runner
变更审批和 Trace 审计
```

真正的区别不是“能不能开发”，而是以下责任由谁承担：

```text
谁创建 GitHub App
谁保存 Private Key
谁生成 installation token
谁接收 webhook
谁运行持续在线的服务
谁存储源码、Trace 和用户数据
谁承担密钥泄露、停机和数据删除责任
```

## 4. Manifest 与手动创建的区别

这两者都属于“无 SaaS 独立开发者 / BYO App”模式，不是第四种运行模式。

| 对比项 | 使用 Manifest | 不使用 Manifest，手动创建 |
|---|---|---|
| 创建入口 | Supersystem 生成配置并跳转 GitHub 确认 | GitHub Developer settings |
| 权限配置 | 模板自动填充，用户确认 | 用户逐项填写和勾选 |
| 出错概率 | 较低 | 较高，容易填错 URL 或漏权限 |
| 自主权 | 完全自主，App 仍归用户 | 完全自主 |
| 是否需要本地回调 | 需要 Manifest callback | 创建阶段不需要；OAuth/setup 仍需要 |
| 当前 V1.1 | 未实现 | Client ID + Device Flow 部分可用 |
| 推荐 | V1.2 默认入口 | 高级设置和故障兜底 |

Manifest 的价值只是降低创建成本，不会让 Supersystem 或第三方取得 App 所有权。

## 5. GitHub 凭据归属

| 凭据/标识 | SaaS 提供者 | 无 SaaS 独立开发者 | 有 SaaS 独立开发者 |
|---|---|---|---|
| App ID / Client ID | 提供者配置 | 开发者配置 | 用户无需配置 |
| Client Secret | 提供者 Secret Store | 开发者本地 Secret Store | 用户不可见 |
| Private Key | 提供者 Secret Store | 开发者本地/私有服务器 | 用户不可见 |
| Webhook Secret | 提供者服务器 | 开发者自建服务；无 webhook 时不需要 | 用户不可见 |
| User access token | 提供者加密保存或引用 | 本地加密保存或引用 | 提供者加密保存或引用 |
| Installation token | 提供者按需生成 | 本地按需生成 | 提供者代为生成，用户不接触 |
| installation_id | 提供者数据库 | 本地数据存储 | 提供者数据库 |

无论哪种模式，Private Key、Client Secret 和 token 都不能进入前端、普通配置、Context Pack、Trace 或 Git 仓库。

## 6. 权限模型不随部署模式改变

个人项目中：

```text
个人开发者 = Project Owner = 主用户
```

Owner 应获得接近本地开发的完整体验。未来协作者无论使用哪种部署方式，都必须通过：

```text
Supersystem 项目角色
+ 自己的 GitHub 用户身份
+ GitHub repo 的真实权限
+ GitHub App installation 的仓库范围
+ 变更审批策略
```

SaaS App 的 installation token 不能被当作绕过 GitHub 成员权限的共享万能凭据。

## 7. 如何选择

### 选择 SaaS 提供者角色，如果你要

- 面向其他用户提供开箱即用服务；
- 统一维护 App、webhook、数据库和升级；
- 支持多设备和未来团队协作；
- 接受持续运维、安全和数据治理责任。

### 选择无 SaaS 自托管，如果你要

- Private Key、代码和 Trace 完全留在自己环境；
- 不依赖第三方服务持续在线；
- 接受一次性的 GitHub App 和本地密钥配置；
- 优先使用 Manifest 降低配置成本，必要时手动创建。

### 选择有 SaaS 的独立开发者模式，如果你要

- 最低配置成本；
- 多设备访问和稳定 webhook；
- 安装后直接开始开发；
- 可以接受 SaaS 提供者处理授权仓库的 API 请求和必要数据。

## 8. Supersystem 推荐默认值

产品最终采用：

```text
默认入口：托管 GitHub App / SaaS
高级入口：BYO GitHub App / 自托管
BYO 默认创建方式：GitHub App Manifest
BYO 兜底方式：手动创建和导入凭据
本地降级：未绑定时仍允许本地 workspace、diff、commit 和 PR body 草稿
```

前端不应让用户一开始面对所有技术字段，而应先选择：

```text
使用 Supersystem 托管服务
或
使用我自己的 GitHub App
```

只有选择自己的 GitHub App 后，才展示 Manifest 和手动配置入口。

## 9. 当前实现与 V1.2 目标

| 能力 | 当前 V1.1 | V1.2 目标 |
|---|---|---|
| GitHub Device Flow API | 已有，前端默认 mock | 真实 UI、状态轮询和错误恢复 |
| 公开 Client ID 配置 | 已有 | 按 hosted/byo 模式隔离 |
| token/env-ref fallback | 已有 | 保留为本地故障兜底 |
| GitHub App Manifest | 未实现 | BYO 默认创建入口 |
| installation callback | 未实现 | 保存 installation 与 repo 范围 |
| App JWT / installation token | 未实现 | 执行真实仓库操作 |
| webhook | 未实现 | 验签、去重、同步安装/仓库/PR |
| SaaS / BYO 切换 | 未实现 | 设置向导和状态面板 |
| 协作者 GitHub 双重校验 | 数据方向已预留 | 完整成员与 repo 权限校验 |
