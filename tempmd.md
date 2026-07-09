# tempmd：V1.2 GitHub 双模式准备备忘

> 创建时间：2026-07-10  
> 用途：临时记录 V1.2 计划前的 GitHub 集成方向，不替代正式 `开发计划v1.2.md` / `测试计划v1.2.md`。

## 1. 已确认方向

- 采用 GitHub 双模式：
  - **Supersystem 托管 App / SaaS 模式**：普通用户低成本使用。
  - **BYO GitHub App 模式**：高级用户、自托管用户、强自主权用户自己持有 GitHub App 配置。
- 个人开发者等价于主用户 / Owner。
- Owner 在网站上的开发体验应尽量接近本地开发：clone、branch、commit、push、PR、issue/checks、Codex Runner 都应顺畅。
- 协作者未来必须走稳妥方案：GitHub 真实权限 + Supersystem 内部角色 + 审批策略三者共同约束。
- 不能只停留在 OAuth / Device Flow；V1.2 需要补齐 GitHub App installation 能力。

## 2. V1.2 候选增量

- GitHub App installation：setup callback、installation_id、repo 授权范围保存。
- GitHub App JWT 与 installation access token 生成。
- Webhook receiver：installation、installation_repositories、push、pull_request、check 相关事件的最小处理。
- Account / Owner 模型强化：个人开发者强绑定 GitHub，Owner 权限接近本地开发。
- Collaborator 模型预留：成员自己的 GitHub 绑定、repo 权限校验、proposal/PR 工作流。
- GitHub 双模式配置 UI：
  - 托管 App：用户只安装授权。
  - BYO App：用户导入 App ID / Client ID / Client Secret / Private Key / Webhook Secret。
- GitHub App Manifest 快速创建作为 BYO App 的降成本方向。

## 3. 需要进入正式计划的问题

- SaaS 托管 App 模式是否在毕设阶段只做“架构预留 + mock/demo”，还是实现最小可用公网/本地 callback？
- BYO App 的私钥保存方式：env ref、文件路径、本地加密存储三者如何分层？
- Owner 是否必须完成 GitHub 绑定才能进入代码开发工作流，还是允许本地-only 降级？
- 协作者第一版是否只做数据模型预留，不做完整邀请/成员管理？
- GitHub 操作默认以 App bot 身份执行，还是敏感操作可选择用户身份执行？

## 4. V1.2 测试准备

- 缺少 GitHub App 配置时 UI 必须给出清晰引导，不能阻塞本地演示。
- OAuth 成功但未安装 App 时，应显示“账号已绑定，仓库操作未完成”。
- installation token 生成失败时，应降级为本地 Git / PR 草稿。
- repo 未授权时，不允许执行远程写入。
- 协作者即使在 Supersystem 是 member，如果 GitHub 无 repo 权限，也不能访问/操作该 repo。
- 所有 secret 必须 mask，不进入 Context Pack、Trace 明文、前端响应。
