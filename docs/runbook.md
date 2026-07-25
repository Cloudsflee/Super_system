# V2.0 运行与验收手册

## 当前状态

V2.0 默认离线门禁覆盖系统上下文协议、全域投影、REST/MCP、Context Pack v4、两级工作流、Assist、Delivery、六视口浏览器和 10,000 节点性能。正式 Compose 使用 `aiws-v20` 与 `aiws-data-v20`；`aiws-data-v19` 只作为只读迁移源和 V1.10 恢复点。历史 catalog、测试报告与旧 schema 状态保持只读。真实 Codex、GitHub 与 cc-switch 验收仍需显式 opt-in，默认结果不能替代 live 结果。

## 正式容器切换

1. 执行 `scripts/aiws.ps1 verify` 或 `scripts/aiws.sh verify`，再执行 `up`。首次 `up` 等待活动执行静默，通过临时迁移卷归档并克隆只读 `aiws-data-v19`，停止 V1.10 app 后只在 `aiws-data-v20` 执行 schema 19→20。
2. 升级器物化确定性 Markdown、重建 MiniSearch，并验证 clone manifest、CAS、投影任务、覆盖率、源记录 ID 和 acceptance receipt 后才启动 `aiws-v20`。
3. 迁移、启动或验收失败时，停止 V2.0、恢复先前运行的 V1.10 容器，并保留源卷和失败目标卷用于调查；没有丢弃不可迁移数据的快捷参数。
4. 已存在非空 `aiws-data-v20` 时只允许复用已验收目标，不再从源卷覆盖。成功后检查 `http://127.0.0.1:4317/api/health`、Context Map 页面与 Owner `GET /context/v1/status`。
5. `down` 保留两个卷；`reset --confirm` / `reset -Confirm` 只删除 `aiws-data-v20`。V2.0 验收后仍不得自动删除 `aiws-data-v19`。

发布 transcript 位于 `.ai-workspace/release/v20-cutover-latest.json`；完整自动化由 `tests/release/v20-volume-flow.test.mjs` 覆盖。

## 启动与基础检查

1. 执行 `corepack pnpm dev`。Vite Web 默认使用 `4317`，API 默认使用 `4318` 并由 Vite proxy 转发。
2. 打开 `http://localhost:4317`；首次使用先在 `/setup` 完成 GitHub 与 Codex 服务端门禁。
3. 本地配置发现只能读取固定的 `AIWS_HOST_CODEX_HOME`、`CODEX_HOME`、`~/.codex`、`AIWS_HOST_CC_SWITCH_CONFIG_DIR`、`CC_SWITCH_CONFIG_DIR` 或 `~/.cc-switch/cc-switch.db`；HTTP 请求不能提交任意绝对路径。
4. 默认持久化目录是 `.ai-workspace`。验收时设置临时 `AIWS_HOME`，不得复用个人运行数据。
5. AIWS API 容器化时，宿主配置目录仅以只读方式挂载给 API 作为导入源；确认导入后生成托管 Profile，Runner 子容器不得直接挂载宿主配置目录。

## Project Lifecycle

1. `POST /projects` 创建 draft Project、项目级 Assist V3 Session、Intake、初始 Brief 与空白 workflow draft，随后导航到 `/projects/<id>/onboarding`。
2. brainstorm 路径直接维护目标、用户、范围、约束和材料；existing 路径还必须选择且只能选择一个代码源。输入就绪后系统异步生成工作流候选，失败时草案保持空白。
3. existing 可增加多个 context source。代码源和上传内容先进入 staging，经路径、链接、文件数、单文件及总大小校验后，才原子进入 `.ai-workspace/workspaces/<projectId>/repo`。
4. 本地源、外部 Git checkout 和远端 repository 都不是写入目标。Agent、CLI、Runner 与确认后的文件编辑只允许写受管 repo/worktree。
5. confirm 在单次 state mutation 中保存 confirmed Brief、workflow、nodes 与 contracts；重复 confirm 返回同一结果。
6. trash/restore 使用结构化 metadata。purge 要求项目名，可删除受管内容或保留到 `.ai-workspace/exports`，不会删除外部源或远端。

## 两级工作流与 Delivery

1. 顶层只允许 1–12 个可独立验收的 Workstream；Task 只能属于一个 Workstream，依赖只能连接同层节点，最大深度固定为 2。
2. 初始 Codex 候选限制为 1–6 个 Workstream、每个 1–12 个 Task，并必须提供分类、拆分依据、Brief 证据、置信度、DAG 和仓库意图。critic 任一失败会废弃整份候选。
3. 顶层变更校验 workflow revision；局部任务图校验 parent `plan_revision`。跨 Workstream 协作使用 Contract、Submission、Asset 与顶层依赖。
4. Task 产出先提交到 Workstream 并验收；必需 Task 全部完成后 Workstream 才能提交到 Workflow。越过未完成上游必须走 Change Proposal。
5. Assist 线程按 `(project, scope_type, scope_id)` 精确恢复，`scope_type` 只允许 `project/workflow/workstream/task`。节点删除或换版后线程只读并保留 `scope_snapshot`。
6. 项目可连接多个 GitHub 仓库；Workstream 可声明多个目标，Task 最多一个写目标并可有多个只读依赖。跨仓库交付拆成多个 Task 和 Draft PR。
7. 编码 Workstream 首次执行前批准 Delivery Policy，限定 repository、base ref、path prefixes、测试命令与自动化权限。策略撤销、过期或变更后必须重新批准。
8. Delivery 固定执行 fetch/base SHA、隔离 worktree/branch、Codex、路径与 secret 检查、测试、commit、push、Draft PR。测试失败或路径越界时保留 worktree，但不得 commit、push 或创建 PR。

## 系统上下文地图

1. `/context` 提供 Owner 全局地图，`/projects/<projectId>/context` 只展示当前项目可见节点；全局入口不会扩大项目会话内 AI 的权限。
2. 地图正文是只读投影。业务修改必须回到 Project、Workflow、Asset、Assist、配置或审计等权威来源，禁止从 Markdown 反向写状态。
3. REST 使用 `/context/v1/map|search|nodes|selections|policy`；Owner 管理使用 `/context/v1/status|rebuild`。MCP 使用 `aiws_context` 的 `map/search/read/explain_selection` 和对应 `aiws://context/...` resources。
4. `context:read` 与 `context:admin` 只开放上下文入口，不替代节点所属的 domain scope、Project ACL 或 Exchange Grant。用户固定项也必须重新经过权限、新鲜度和敏感级裁决。
5. Vault 值、token、Cookie、私钥、原始凭据和宿主绝对路径不得进入正文、索引、摘要、选择审计、API 或日志。二进制只投影清单、hash、媒体类型、大小和描述。
6. 当前文档版本始终保留；选择审计、Context Pack 或语义摘要引用的历史版本按其生命周期保留。其余超过 30 天的投影版本元数据会在状态 mutation 或启动恢复时回收。
7. 读取当前脏节点会先物化并核对源 hash 与 CAS hash。失败返回 `context_projection_unavailable`，不得静默回退到旧正文；损坏的 `.context-index/minisearch-v1.json` 会自动重建。

## Assist、Terminal 与审批

1. Ask/Plan 强制只读；Agent/CLI 每个 Turn 使用独立 worktree。dirty baseline、并发 Turn 与 apply 冲突会被拒绝。
2. typed stream 使用稳定 sequence，并支持 `Last-Event-ID` 重放、Stop、Retry、queue、steer 和 interrupt。
3. Composer 的 Profile 决定 Endpoint、凭据和运行时；模型与思考深度是当前 Turn 快照。可将组合保存为 Assist 配置后直接切换，不会修改原 Profile 或共享 Secret。
4. Composer 可关联 project file、Monaco 文件/选区、图片和项目附件；未知二进制只作为 Artifact，不注入模型。
5. 页面字段修改先显示预览，点击“应用到页面”后只更新当前页面草稿；例如简报仍需点击“保存并生成简报”才会持久化。
6. Terminal 仅在 node-pty/WebSocket capability 可用时开放，支持 resize、Ctrl-C、重连、stop 和退出状态；完整脱敏输出写 Artifact，预览有长度上限。
7. Turn 或 Terminal 完成后在统一 Review 中检查 changed-files、diff、viewed、行评论、request changes、rollback 与 apply target hash。
8. Proposal 创建为 interrupting；关闭或 Escape 执行 defer 并进入 queued。`/approvals` 同时聚合 Proposal 和 Runtime Approval。
9. `approve_apply` 校验 revision 与 target hash；stale 或冲突不得留下半应用状态。

## 配置治理

1. Profile/Provider/MCP/Skill/AGENTS.md 变更先形成 Config Revision 或 Change Proposal，批准后才应用。
2. Config Revision 默认写入 AIWS 托管 Codex Profile，并在 Probe 后激活，不要求 cc-switch。
3. 只有显式设置 `apply_mode=cc_switch` 时才调用受管 cc-switch CLI；CLI 固定版本并校验 checksum，凭据只进入 vault 或私有临时配置，不直接写 SQLite。
4. cc-switch 模式在写入后重新发现并 Probe，失败时回滚旧 Provider；native fallback 必须由用户显式选择。
5. 默认测试使用隔离 `CC_SWITCH_CONFIG_DIR` 和 adapter，并比较外部 fixture 的 hash；不可从该结果推断真实 cc-switch live 已通过。

## 团队 MCP Gateway

1. Local 模式继续使用内嵌 `http://127.0.0.1:4317/api/mcp`；Team 模式组合 `compose.yml` 与 `compose.collaboration.yml`。
2. 生成至少 32 bytes、仅部署用户可读的 secret file，并设置 `AIWS_MCP_GATEWAY_SECRET_FILE` 与 HTTPS `AIWS_PUBLIC_MCP_URL`。
3. Gateway 宿主端口 `4319` 只绑定 loopback；Caddy/Nginx 只把 MCP domain 的 `/mcp` 转发到 Gateway，不把 Core `/api/mcp` 暴露到公网。
4. 每个成员使用独立、user-bound、项目限权且会到期的 token。普通成员不能创建 all-project client，也不能获得 setup/MCP admin、destructive 或 approver 权限。
5. Gateway 不得挂 `aiws-data`、Vault、Docker socket 或 workspace；Runner 只加入 `mcp-agents` network。
6. 当前远程 Web 尚未完成团队登录与 project membership enforcement，只允许通过私有 VPN 试用；不得把 Local Owner Web API 直接暴露到公网。

完整架构与后续 OAuth/PostgreSQL/Redis 扩展边界见 `docs/mcp-collaboration-architecture.md`。

## 提交与历史门禁

首次克隆后执行 `corepack pnpm hooks:install`。向 `main` 推送时，仓库的 `pre-push` hook 要求工作树干净，并以远端 `main` SHA 为 impact base 顺序执行 `test:v175:pr`、`test:v18:pr` 与 `test:v20:pr`；也可随时手动执行 `corepack pnpm gate:pre-push`。不得使用 `--no-verify` 绕过正式交付门禁。

V1.75 的 `1.7.0` / schema `16` 与 V1.8 的 `1.8.0` / schema `17` 是只读历史 catalog，不是当前产品必须保持的值。后续版本只能按以下规则扩展：

1. 当前产品版本不得早于历史版本；历史 catalog 自身仍保持精确冻结。
2. 历史 HTTP route identities、MCP mappings/tools 与 state collections 是最低基线；允许新增，不允许删除或替换基线能力。
3. 新增 deterministic unit/integration test 必须登记到 `tests/v175/suite-files.json`，不得通过跳过或放宽 FLAKY verdict 使门禁变绿。
4. 修改旧工作流和 E2E fixture 时必须使用当前正式数据契约，并保留对历史业务能力的断言。

当前单机初版不启用 GitHub Actions 或 branch protection；本地 `pre-push` hook 是推送 `main` 前的自动门禁。

## 默认验收

按以下顺序执行，任一步非零都不能关闭交付：

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:e2e
corepack pnpm audit:acceptance
corepack pnpm verify
```

`verify` 会运行 V2.0 plan/catalog/coverage/impact、历史兼容门禁、lint、typecheck、全部 unit/integration/release、Prisma migration check、Web build、bundle budget、E2E 与 acceptance audit。默认套件使用临时 `AIWS_HOME`，不读取个人凭据执行外部写入。

发布前执行 `corepack pnpm test:v20:full` 与 `corepack pnpm test:v20:release`。`scripts/v20-runner.mjs` 按 catalog 执行，并在 `.ai-workspace/test-reports/v2.0/<run-id>/` 生成 Markdown、JSON 和脱敏日志。release 专项覆盖 schema 19 只读克隆、19→20 原子迁移、投影与索引验收、Runner 镜像升级、源记录/文件保全、失败回滚和 V1.10 源卷不变。V1.8、V1.9 与 V1.10 release 套件继续作为兼容基线运行。

真实 MCP 建仓与 Draft PR 验收使用 `$env:AIWS_MCP_LIVE_SMOKE_CONFIRM='create-private-github-repository'; corepack pnpm test:v19:live`。未提供精确确认值时，runner 生成 `BLOCKED` 报告且不执行远端创建。

## V1.9 Live 验收

Live 只在专用 fixture 上创建 Draft PR；验证 webhook 回流后关闭 PR 并删除临时分支，不执行 Ready 或 merge。非编码项目和多仓库编码项目的最终业务旅程必须通过 MCP 完成，除 `/health` 与 `/api/mcp` 外不得由测试客户端直接调用业务 HTTP。

## V1.8 Live 验收

Live 不属于默认 `verify`。它必须使用隔离的 AIWS state/Vault、临时端口与专用 GitHub fixture，不得直接修改正在运行的用户实例。网页 Setup 已保存且 Probe 为 ready 的 Codex/GitHub 凭据可以随 Vault reference 一起克隆到该隔离环境，无需再次输入明文；不得把 Vault token、MCP token 写入命令参数、配置文件、报告或日志。

1. 只读克隆待验证实例的 state 和 Vault 到临时 `AIWS_HOME`，记录源 workspace hash，并在独立端口启动 API/MCP。
2. 通过 Owner MCP client 管理接口创建短期、项目限权的 operator 与独立 approver；token 只放入当前测试进程环境。
3. 设置 `RUN_V18_MCP_LIVE_TESTS=1`、`AIWS_TEST_CODEX_CONFIRM=dedicated-read-only`、`AIWS_TEST_GITHUB_CONFIRM=dedicated-write-test` 及测试 harness 要求的隔离 URL、项目、Run 和短期 token 环境变量，然后执行 `corepack pnpm test:v18:live`。
4. Codex 用例只允许访问 `/api/mcp`，并验证只读宿主 workspace 不变。GitHub 用例固定在 `Cloudsflee/---` 创建 draft PR，验证后关闭 PR 并删除临时分支。
5. 无论结果如何，撤销短期 MCP clients，关闭 MCP session/API，删除隔离 state/Vault 与 Docker 临时资源，并复验 PR、branch、端口和源 workspace hash。

正式 soak 另行执行 `corepack pnpm test:v18:soak`；固定 120 分钟，缩短运行不得计作发布通过。

## 历史 Live 记录

2026-07-17 的 V1.9 Full `full-20260717T151414Z-42400`、Release `release-20260717T130854Z-36904` 与受控 Live `live-20260717T073825Z-9880` 均为历史 `PASS` 证据。它们不能替代 V2.0 的 `test:v20:full`、`test:v20:release` 或新的 opt-in live 结果。正式 120 分钟 Soak 尚未执行。
