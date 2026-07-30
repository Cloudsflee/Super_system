# AI Workspace System V2.1

AI Workspace System V2.1 是一个本地优先、自托管的 AI 协作工作空间。V2.1 在持久化 DAG、不可变资产和系统上下文地图之上增加 Outcome Contract、七阶段执行重放和最终交付验收：业务状态仍是权威源，规范 Markdown、全文索引和 Context Pack v5 只是只读、可验证的投影。

当前版本默认采用 **JSON-local 本地持久化**，不依赖外部数据库即可启动；同时保留 Prisma/PostgreSQL、Redis、Worker、CodexRunner、GitHub PR 等后续替换边界。

> **交付状态**：V2.1 使用 state schema 21、Compose project `aiws-v21` 和 external volume `aiws-data-v21`。首次 `up` 将 `aiws-data-v20` 作为只读源克隆到新卷，只在新卷迁移并完成 Context、Outcome 和发布覆盖验收；失败时停止 V2.1、恢复 V2.0，并保留源卷和失败目标卷。

工作流界面继续采用 V1.8 Focus OS 视觉与交互基线，见 [`docs/v1.8-focus-os-ui-design.md`](docs/v1.8-focus-os-ui-design.md)。

## 1. 项目能力概览

- **本地账号与会话**：启动后自动创建 Local Owner Account 与本地会话。
- **全能力 MCP**：`POST/GET/DELETE /api/mcp` 提供 15 个领域/目录/操作工具和资源；Settings 管理一次性 token、scope、项目范围、到期与撤销。
- **Setup 硬门禁**：GitHub 与 Codex 均通过服务端验证后才开放业务路由。
- **项目生命周期**：新项目先创建为可恢复 draft，经 Intake、版本化 Project Brief 和 workflow draft 确认后激活；legacy Project 迁移为 active。
- **两级 Workflow**：顶层画布只显示可独立验收的 Workstream；内部 Task 使用列表、看板或独立局部结构图，最大深度固定为 2。
- **异步工作流生成**：Brief、材料和代码源就绪后由 Codex 生成候选并经独立 critic 校验；失败保持空白草案，不安装通用阶段兜底。
- **四层 Assist**：线程严格归属于 `project/workflow/workstream/task`，显示完整 breadcrumb，节点删除或换版后按 scope snapshot 只读保留。
- **持久化 DAG 执行**：用户启动一次 Workflow Execution，dispatcher 自动推进 readiness frontier，在人工 checkpoint、PR 批准或确定性失败处局部暂停并支持幂等恢复。
- **真实完成判定**：Workflow 必须携带版本化 Outcome Contract 与 Quality Rubric；生命周期状态保持兼容，交付以 `completion_status` 和 `release_eligible` 为准。
- **七阶段执行与重放**：NodeRun 固定经过 `preflight/execute/collect/verify/attest/promote/finalize`；输入身份完全一致时只重放失败阶段。
- **不可变资产管线**：正文和文件集合进入 CAS 后按 SHA-256 校验；确认只新增 attestation，并原子写入 output binding、验收结果和 lineage。
- **系统上下文地图**：所有非密钥 state 记录以及仓库文件、附件、Artifact、CAS、运行健康和浏览器语义状态进入稳定 `aiws://context/...` 有序树与类型化关系图。
- **受控上下文检索**：AI 先读取紧凑地图，再由服务端按项目 ACL、domain scope、Exchange Grant、敏感级、新鲜度和 token 预算裁决搜索与正文展开。
- **Repository Line**：每个 Workstream 绑定一条仓库版本线和一个最终 PR；写 Task 严格串行，只读验证固定上游 SHA 并最多并行两个。
- **Node Contract**：每个节点都有目标、验收标准、允许工具等结构化契约。
- **Codex 原生 Assist**：普通 Turn 为 `default`，单次 Plan 使用原生 `collaborationMode: plan`；用户消息与 `additionalContext` 分离，只使用 app-server。
- **Goal 与原生事件**：线程 Goal 直接透传 objective/status/budget/usage；Plan、tool、command/file/diff、reasoning summary 与 request-user-input 进入统一活动流。
- **累计变更批次**：Assist、Linux CLI 与 Windows CLI 共享线程级 change batch、checkpoint、写锁和累计 Diff Review；Plan 严格只读。
- **网页操作账本**：`aiws_page` dynamic tools 只操作页面声明的可逆语义控件，记录 before/after/hash，支持冲突阻止与二次确认强制 Undo。
- **双 CLI 运行时**：Linux Runner Container 为默认；Windows Native Bridge 使用 DPAPI、ConPTY 与校验后的 Git bundle 往返，不共享宿主凭据。
- **Context Pack v5**：新执行保存 Selection v2、retrieval plan、rubric/Outcome hash 和精确文档版本；v1-v4 保持只读兼容。
- **五类节点工作区**：目标、调研、分析、执行、复盘分别维护结构化工作资料；执行节点内置 Monaco、diff 和受控任务。
- **Runner 执行**：正式入口只提供 CodexRunner 与隔离的 DockerCodexRunner。
- **Trace / Asset / Digest**：记录运行轨迹，产出资产候选，确认后形成 Workspace Digest。
- **Git / PR**：V1.2 支持 repo 绑定、分支、diff、commit 和 PR；V1.3 将写边界收紧到 AIWS 受管 checkout/worktree，外部源只读。
- **Review 复盘**：集中展示 Project、Node、Trace、Asset、Digest、Decision、CodeChange/PR 证据链。
- **模块化约束**：代码按应用、路由、处理器、共享包和前端视图拆分，验证脚本限制 JS 文件长度，避免单文件过长。

## 2. 环境要求

生产部署要求：

- Docker Desktop/Engine（Linux containers）。
- Docker Compose plugin。
- Codex 账号或 API Key：首次配置必需；可选官方 Device Login、直接填写第三方 Provider，或显式导入本机 cc-switch / `CODEX_HOME` 的脱敏发现结果。
- GitHub App：可使用 Hosted 模式，或在 BYO 模式提供 App 配置。

Node.js、pnpm、Git、SSH、tar 和生产 Web 都包含在镜像中。宿主开发模式另需 Node.js 24、Corepack/pnpm 与 Git。

业务状态仍使用 JSON-local，不需要数据库或 Redis；V2.1 生产数据保存在固定命名卷 `aiws-data-v21`。schema 21 在 Context collections 之外新增 OutcomeRequirement、OutcomeEvaluation、OutcomeWaiver 和 ExecutionStageCheckpoint；正文复用 CAS，MiniSearch 索引位于数据卷的 `.context-index` 可重建目录，MCP token 仍只保存 hash。

已使用过 Codex 的用户可直接导入本机 `CODEX_HOME` / `~/.codex` 中的 `config.toml` 与 `auth.json`；页面只返回脱敏摘要，确认后才复制 API Key 或官方 OAuth bundle，并重建 AIWS 托管 Profile。未使用过 Codex 的用户可在 Setup 选择官方 Device Login 或手动 API 配置。

V2.1 启动脚本等待活动 Workflow/Task Execution、NodeRun 和 Delivery 静默后，只读归档并克隆 `aiws-data-v20`。schema 20→21、确定性投影、CAS 校验、索引构建、Outcome coverage 和源记录覆盖验收都只发生在 `aiws-data-v21`；发布记录写入 `.ai-workspace/release/v21-cutover-latest.json`，源卷不会自动清理。

## 3. 快速启动项目

### 3.1 推荐方式：Docker Compose

在项目根目录执行：

```powershell
.\scripts\aiws.ps1 up
```

macOS / Linux：

```bash
bash scripts/aiws.sh up
```

启动成功后访问：

```text
http://127.0.0.1:4317
```

默认构建 `aiws-app:2.1.0`、`aiws-verify:2.1.0` 与 `aiws-codex-runner:2.1.0-codex-0.144.0`，正式挂载 `aiws-data-v21`。团队模式另行构建 `aiws-mcp-gateway:2.1.0`；Gateway 不挂数据卷或 Docker socket。升级流程包含静默等待、只读克隆、schema 21、Context/Outcome 覆盖验收、V2.1 启动和 `4317` 健康检查。

显式配置项目只读导入根：

```powershell
.\scripts\aiws.ps1 up -ProjectsRoot 'E:\projects'
```

```bash
bash scripts/aiws.sh up --projects-root /home/user/projects
```

### 3.2 宿主开发热更新

```bash
corepack pnpm install
corepack pnpm dev
```

开发模式继续提供：

- `4318` 内部 API（由 Vite proxy 转发）
- `4317` Vite React 前端
- 仓库 `.ai-workspace` 下的开发数据

开发数据与生产命名卷不自动迁移。

### 3.3 手动构建镜像

```bash
docker build --target production -t aiws-app:2.1.0 .
docker build --target verify -t aiws-verify:2.1.0 .
docker build --target mcp-gateway -t aiws-mcp-gateway:2.1.0 .
docker build -f docker/codex-runner.Dockerfile -t aiws-codex-runner:2.1.0-codex-0.144.0 .
docker build --target windows-bridge-export --output type=local,dest=./dist/bridge .
docker compose up -d
```

通常应使用启动脚本，因为脚本还执行端口、socket、volume-subpath 与 health 预检。

### 3.4 修改生产启动端口

生产 Compose 可以通过 `AIWS_PORT` 修改宿主 loopback 端口。

macOS / Linux / Git Bash：

```bash
AIWS_PORT=4320 bash scripts/aiws.sh up
```

Windows PowerShell：

```powershell
$env:AIWS_PORT="4320"; .\scripts\aiws.ps1 up
```

访问地址相应改为：

```text
http://localhost:4320
```

### 3.5 数据目录

生产数据固定使用 `aiws-data-v21`；`down` 默认保留该卷，只有 `reset --confirm` / `reset -Confirm` 会删除 V2.1 目标卷。`aiws-data-v20` 始终作为保留的 V2.0 恢复点，不会被 reset 或发布脚本删除。活动 Workflow/Task Execution、NodeRun 或 Delivery 未结束时，升级器最多等待五分钟并拒绝切换。

## 4. 使用流程与版本边界

### 4.1 Legacy V1.2 兼容流程

1. 启动项目后打开 `http://localhost:4317`。
2. 在 Setup 选择 Hosted 或自有 GitHub App，完成 Owner 授权、Installation 和 repository 选择。
3. 完成 Docker 镜像、Codex 凭据、profile、TOML 和非写入 probe 验证。第三方 API 可手动填写 Provider ID / Base URL，也可从本机 cc-switch 或 `CODEX_HOME` 先查看脱敏摘要再显式导入；当前直连格式为 Responses API。
4. 既有 Project 在 V1.3 migration 后保持 active；外部 repository 会标记 `workspace_migration_required`，迁移到受管 workspace 前禁止 workspace-write。
5. 从工具栏添加节点、应用模板，或让 Codex 生成 Workflow Change Proposal。
6. 单击节点查看 Inspector，双击进入对应节点工作区。
7. 在执行工作区明确保存文件、查看 diff、运行受控任务或启动 DockerCodexRunner。
8. 在 Assist 抽屉审查确认动作，在审批抽屉批准工作流、Contract 和 profile 变更。
9. 在资产和审计页面检查 Asset、Digest、Trace、Git/PR 证据链。

更详细的操作与验收脚本可见：`docs/runbook.md`。

### 4.2 V2.1 上下文、Outcome 与 DAG 使用流程

1. 创建或迁移 Project，确认 Project Brief、Workflow draft、typed I/O 和 Node Contract，使 Workflow 达到 `verified`。
2. 从全局 `/context` 或项目 `/projects/<id>/context` 打开上下文地图；桌面使用目录、正文、关系三栏，移动端使用同级标签页。
3. 在摘要、原文、结构、关系和历史视图检查规范投影；文本可复制或导出 Markdown，任何业务修改仍回到原始页面完成。
4. 搜索或读取节点时，服务端同时校验 `context:read`、资源 domain scope、Project ACL、Exchange Grant、新鲜度和敏感级；固定节点不能绕过这些规则。
5. “本轮取用”展示纳入、排除、原因、精确版本和 token 用量；用户可按会话固定或明确排除节点。
6. 在 Workflow 页面一次性选择每个 Workstream 的 Repository 与 base Branch，并确认 Outcome Contract 与 Quality Rubric，然后启动 DAG。新执行统一使用 Context Pack v5。
7. 系统固定 Workflow/Task revision、Contract version、精确 AssetVersion hash、上下文文档版本和 repository SHA，并自动调度 readiness frontier。
8. 调研、需求和决策 Task 在 `awaiting_human` 只保留一个合并 checkpoint；批准时服务端原子完成 attestation、binding、验收和 lineage。
9. `repository_change` 在 Workstream Repository Line 上提交真实代码；`repository_verify` 只读检出同一 SHA，出现 diff、空测试或失败退出码即阻断。
10. `repository_integrate` 不改代码，只校验 RepositoryVersion、TestReport、head/base 和非空 checks；依次批准创建和合并 PR 后才完成。
11. Workstream 完成后生成 `WorkstreamOutcomeAsset`，下游 Workstream 消费该精确版本并自动解锁。
12. 在 Task 页面观察七阶段 checkpoint、结构化 Failure Envelope 和失败阶段 replay；在 Outcome 面板检查 requirement、waiver、完成状态与 release eligibility。
13. 最后一项任务完成后，系统等待 Context 投影 ready 和 Outcome evaluation 完成再关闭 lifecycle；连续投影失败会保留可重放的 `context_projection_unavailable`。

以上入口已纳入默认自动化门禁；外部服务与本机 CLI 的实际可用性仍由 Setup capability/probe 和可选 live 验收决定。完整证据见 `docs/completion-audit.md`。

## 5. 常用命令

### 5.1 启动

Windows：

```powershell
.\scripts\aiws.ps1 up
```

macOS / Linux：

```bash
bash scripts/aiws.sh up
```

宿主开发：

```bash
corepack pnpm dev
```

### 5.2 单元测试

```bash
pnpm test
```

### 5.3 集成测试

```bash
pnpm test:integration
```

### 5.4 E2E 冒烟测试

```bash
pnpm test:e2e:smoke
```

或：

```bash
pnpm test:e2e
```

### 5.5 完整验证

```bash
pnpm verify
```

如果未启用 pnpm，也可以使用：

```bash
npm run verify
```

`verify` 会执行 V2.1 plan/catalog/coverage/impact、V2.0 及更早历史兼容门禁、lint、typecheck、unit、integration、release、Prisma schema 检查、Web build、bundle budget、E2E 和 acceptance audit。V2.1 专项提供 `test:v21:pr`、`test:v21:full` 与 `test:v21:release`；容器交付应执行 `scripts/aiws.ps1 verify` 或 `scripts/aiws.sh verify`。

### 5.6 Codex live 测试，可选

只有在本机已经准备好 Codex CLI 时才需要运行。

macOS / Linux / Git Bash：

```bash
RUN_CODEX_LIVE_TESTS=1 CODEX_LIVE_TIMEOUT_MS=15000 pnpm test:live:codex
```

Windows PowerShell：

```powershell
$env:RUN_CODEX_LIVE_TESTS="1"
$env:CODEX_LIVE_TIMEOUT_MS="15000"
pnpm test:live:codex
```

### 5.7 GitHub live 测试，可选

```powershell
$env:RUN_GITHUB_LIVE_TESTS="1"
$env:AIWS_TEST_GITHUB_REPO="owner/private-test-repo"
$env:AIWS_TEST_GITHUB_TOKEN="..."
pnpm test:live:github
```

默认自动测试使用仅限 `NODE_ENV=test` 的 adapter；当前 GitHub live hook 对指定 repository 做只读权限探测，仍需显式启用。

### 5.8 cc-switch live 测试，可选

```powershell
$env:RUN_CC_SWITCH_LIVE_TESTS="1"
pnpm test:live:cc-switch
```

该 hook 安装固定版本的受管 CLI 并读取 Catalog，只写临时 `AIWS_HOME`。如设置 `CC_SWITCH_CONFIG_DIR`，还会验证该目录前后的 hash/mtime 不变。

### 5.9 Windows Native Bridge

Windows Bridge 是可选运行时；Linux Container 始终为默认。先在 AIWS 页面生成一次性 12 位配对码，再执行：

```powershell
.\scripts\aiws.ps1 bridge install -PairingCode '123456789012'
.\scripts\aiws.ps1 bridge start
.\scripts\aiws.ps1 bridge status
```

停止或卸载：

```powershell
.\scripts\aiws.ps1 bridge stop
.\scripts\aiws.ps1 bridge uninstall
```

Bridge 只主动连接 `127.0.0.1:4317`；长期凭据由 Windows DPAPI CurrentUser 保存。卸载不会删除宿主 `CODEX_HOME`、Codex 登录态或 AIWS 项目。

### 5.10 GitHub SaaS / 自托管使用文档

GitHub 集成最终采用“托管 GitHub App + 用户自带 GitHub App”双模式。按身份阅读对应文档：

| 身份 / 场景 | 文档 |
|---|---|
| 计划向其他用户提供 Supersystem SaaS | [`docs/github/saas-provider-guide.md`](docs/github/saas-provider-guide.md) |
| 独立开发者，不使用 SaaS，自己持有 GitHub App | [`docs/github/independent-developer-without-saas.md`](docs/github/independent-developer-without-saas.md) |
| 独立开发者，使用现成 Supersystem SaaS | [`docs/github/independent-developer-with-saas.md`](docs/github/independent-developer-with-saas.md) |
| 比较三者的配置成本、凭据归属、自主权和适用场景 | [`docs/github/deployment-mode-comparison.md`](docs/github/deployment-mode-comparison.md) |

无 SaaS 教程同时说明了 GitHub App Manifest 快速创建和 GitHub 后台手动创建两条路径。V1.2 已实现 App JWT、installation token、repository 同步、webhook 验签/去重和 Hosted/BYO 模式切换。

### 5.11 MCP 开发命令

在 Settings 创建 Client 后，只通过环境变量提供一次性 token：

```powershell
$env:AIWS_MCP_TOKEN='<一次性 token>'
pnpm mcp:client list-tools
pnpm mcp:client call aiws_capabilities '{"action":"search","query":"projects","limit":20}'
pnpm mcp:client call aiws_context '{"action":"map","depth":3,"limit":200}'
pnpm mcp:stdio
```

默认 endpoint 是 `http://127.0.0.1:4317/api/mcp`，可用 `AIWS_MCP_URL` 覆盖。`mcp:stdio` 是到内建 HTTP server 的协议 bridge，不直接并发写 state 文件。

团队模式使用独立 Gateway：

```powershell
$env:AIWS_MCP_GATEWAY_SECRET_FILE='C:\secure\aiws-mcp-gateway.secret'
$env:AIWS_PUBLIC_MCP_URL='https://mcp.example.com/mcp'
docker compose -f compose.yml -f compose.collaboration.yml up -d --build
```

Gateway 在宿主仅监听 `127.0.0.1:4319`，由 Caddy/Nginx 提供 HTTPS。成员 Codex 连接 `AIWS_PUBLIC_MCP_URL`；Core `/api/mcp` 不作为公网入口。完整拓扑、角色边界和远程网页前置条件见 [`docs/mcp-collaboration-architecture.md`](docs/mcp-collaboration-architecture.md)。

## 6. 根目录结构说明

| 路径 | 用途 |
|---|---|
| `.ai-workspace/` | 宿主开发数据和发布 transcript；生产状态位于 `aiws-data-v21`，V2.0 恢复点位于保留卷 `aiws-data-v20`。 |
| `.git/` | Git 版本库元数据，由 Git 自动维护。 |
| `apps/` | 应用层代码，包含 API 服务、前端页面和 worker 入口。 |
| `packages/` | 可复用模块与共享领域逻辑，供 API、Worker、测试和后续扩展复用。 |
| `tests/` | 自动化测试目录，包含 unit、integration、e2e 和 live hook 测试。 |
| `scripts/` | 工程脚本目录，包含 lint、typecheck、verify、迁移检查和验收审计。 |
| `docs/` | 工程文档目录，包含运行手册、V1 覆盖矩阵、完成审计报告和 `docs/github/` 下的 GitHub SaaS/自托管教程。 |
| `doc/` | 早期核心想法、问题记录和方案草稿，用于保留设计演进过程。 |
| `docker/` | Runner Dockerfile、导入 override/环境样例、归档/卷验收器、V2.1 只读克隆升级器及历史迁移实现。 |
| `Dockerfile` / `compose.yml` | V2.1 production/verify/Windows Bridge export 镜像与默认完全容器化部署。 |
| `bridge/` | Windows Native Bridge 的 Go/DPAPI/ConPTY 与 workspace bundle 客户端。 |
| `config/` | 本地公开配置示例，目前保存 GitHub App 的公开 Client ID；不要在此目录提交 Client Secret 或 Private Key。 |
| `prisma/` | Prisma schema 草案，描述未来替换到 PostgreSQL 时的数据模型边界。 |
| `探索/` | 前期调研资料目录，用于保存毕业设计探索阶段材料。 |
| `探索-1/` | 记忆机制、Context Pack、Codex 工作空间等方向的进一步调研和头脑风暴材料。 |
| `愿景与范围文档模板/` | 需求、愿景、范围相关模板资料，用于需求分析和文档撰写参考。 |
| `temp/` | 临时资料和研究过程文件，不是项目运行必需内容。 |
| `.gitignore` | Git 忽略规则，排除本地运行数据、依赖、日志和构建产物。 |
| `README.md` | 项目入口说明文档，即当前文件。 |
| `package.json` | 根工作区脚本、项目元信息和 package manager 声明。 |
| `pnpm-workspace.yaml` | pnpm workspace 配置，声明 `apps/*` 与 `packages/*` 为工作区包。 |
| `开发计划.md` | V1 开发计划、功能范围和实现目标。 |
| `测试计划.md` | V1 测试计划、验证路径和验收要求。 |
| `开发计划v1.1.md` / `测试计划v1.1.md` | V1.1 层级会话、Docker Runner 与审批增量。 |
| `开发计划v1.2.md` / `测试计划v1.2.md` | V1.2 Setup、Canvas、Assist、文件与验收增量。 |
| `开发计划v1.3.md` / `测试计划v1.3.md` | V1.3 onboarding、受管 workspace、IDE、CLI、审批和配置治理增量。 |
| `开发计划v1.4.md` / `测试计划v1.4.md` | V1.4 完全容器化、Runner 生命周期、只读导入与 Docker 验收增量。 |
| `开发计划v1.5.md` / `测试计划v1.5.md` | V1.5 原生 Assist 线程、变更桥接与安全迁移增量。 |
| `开发计划v1.6.md` / `测试计划v1.6.md` | V1.6 真实 Fork、BTW、上下文菜单、文件引用/预览与 schema 15 安全迁移。 |
| `开发计划v1.7.md` / `测试计划v1.7.md` | V1.7 澄清策略、Brief V2、持久工作流草稿、能力目录与 schema 16 独立卷迁移。 |
| `开发计划v1.75.md` / `测试计划v1.75.md` | V1.75 工作流草稿布局、质量门禁和验证治理增量。 |
| `开发计划v1.8.md` / `测试计划v1.8.md` | V1.8 MCP、项目治理和 schema 17 团队协作增量。 |
| `开发计划v1.9.md` / `测试计划v1.9.md` | V1.9 双层 Workflow、仓库交付和 schema 18/19 迁移增量。 |
| `开发计划v2.0.md` / `测试计划v2.0.md` | V2.0 系统上下文地图、选择安全、schema 20 与只读卷升级发布计划。 |
| `开发计划v2.1.md` / `测试计划v2.1.md` | V2.1 Outcome、阶段重放、Context 闭环、schema 21 与独立卷发布计划。 |
| `tempmd.md` | V1.2 计划生成前的历史需求与决策备忘。 |

## 7. `apps/` 子目录说明

| 路径 | 用途 |
|---|---|
| `apps/api/` | 本地 HTTP API 服务，同时负责提供前端静态资源。入口是 `apps/api/server.mjs`。 |
| `apps/api/src/routes/` | API 路由定义，按 setup、projects、workflow、assist、files、runs、assets、git、github、codex、tools 拆分。 |
| `apps/api/src/handlers/` | 路由背后的业务处理器，承载较复杂的 Git、Runner、GitHub、Assist 等逻辑。 |
| `apps/api/src/state.mjs` | JSON-local 状态管理与运行目录初始化逻辑。 |
| `apps/web/` | Vite + React + TypeScript workspace，生产构建输出到 `apps/web/dist`。 |
| `apps/web/src/features/` | Setup、Projects、Workflow、Nodes、Assets、Audit、Settings 功能模块。 |
| `apps/web/src/styles/` | 应用壳、Setup、Canvas、节点工作区和数据页样式。 |
| `apps/worker/` | V1 worker 任务入口和任务名约定，当前主要保留后续异步任务化扩展边界。 |

## 8. `packages/` 子目录说明

| 路径 | 用途 |
|---|---|
| `packages/shared/` | 共享领域模型与核心规则，包含项目、工作流、节点契约、Memory、Context、Assist、Asset、Digest、Tool 等逻辑。 |
| `packages/runner-adapters/` | 正式 Runner 适配器，包含 AgentRunner、CodexRunner、DockerCodexRunner 和输出归一化。 |
| `packages/context-pack/` | Context Pack facade，封装上下文包生成入口和 provider 顺序。 |
| `packages/system-context/` | V2.0 上下文协议、确定性投影、排序、脱敏、检索裁决和选择审计。 |
| `packages/memory-policy/` | Memory Manifest 与 Sufficiency Gate facade，封装记忆纳入、排除、冲突和充分性判断。 |
| `packages/git-tools/` | Git 工具 facade，封装分支、diff、commit 等本地 Git 操作边界。 |
| `packages/mcp-bridge/` | MCP / CLI / Docker 工具配置归一化与配置检查边界。 |
| `packages/testing-fixtures/` | 测试夹具，包含最小项目样例和临时 Git 仓库模板。 |

## 9. `tests/` 子目录说明

| 路径 | 用途 |
|---|---|
| `tests/unit/` | 单元测试，验证共享领域规则、package facade 和纯函数逻辑。 |
| `tests/integration/` | 集成测试，覆盖 Setup、API、Git、Tool、GitHub、onboarding/import、Assist V2/V3、Terminal、审批/配置治理和 opt-in live hooks。 |
| `tests/e2e/` | 前端冒烟测试，验证本地服务、静态页面和关键交互入口是否可用。 |

## 10. 数据与持久化

宿主开发模式会自动创建：

```text
.ai-workspace/
  data/
    state.json
  artifacts/
```

说明：

- `.ai-workspace/data/state.json`：保存本地用户、会话、项目、工作流、节点、Context Pack、Trace、Asset、Digest、Git/PR 等状态。
- `.ai-workspace/artifacts/`：保存 raw trace、运行日志、候选资产等文件型产物。
- `.ai-workspace/` 已被 `.gitignore` 忽略，适合保存本机运行和调试数据。
- 删除 `.ai-workspace/` 后再次启动，会重新初始化宿主开发状态；该操作不影响生产卷。

V2.1 生产容器使用相同目录结构，根位于命名卷 `aiws-data-v21` 的 `/var/lib/aiws`，状态 schema 为 21。规范 Markdown 位于 CAS，`.context-index/minisearch-v1.json` 可从状态与 CAS 重建。`down` 保留卷；只允许通过带显式确认的运维脚本删除 V2.1 目标卷，V2.0 源卷仍保留。

## 11. Legacy 可选基础设施

V1.6 默认部署依赖 Docker，但业务仍不依赖 PostgreSQL/Redis。若需要单独试验未来基础设施，可以执行：

```bash
docker compose -f docker/compose.infra.yml up -d
```

停止基础设施：

```bash
docker compose -f docker/compose.infra.yml down
```

当前默认服务仍使用 JSON-local；`docker/compose.infra.yml` 主要用于后续替换持久化和队列基础设施。

## 12. 已验证历史基线与 V2.1 增量

默认离线门禁已覆盖以下 V1.2 回归基线：

- Local Owner Account 与本地自动会话。
- GitHub/Codex 首次配置硬门禁、Secret vault 与服务端状态持久化。
- React 全屏 Workflow Canvas、空工作流、5 类节点模板、布局历史和结构变更 proposal。
- Node Contract 创建、审批后应用和五类节点 renderer。
- Context Pack Preview / Confirm，含 Sufficiency Check 与 Memory Manifest。
- Project/Node 层级 Codex Assist session、JSONL 解析、SSE 重放、取消、resume 和白名单 UIAction。
- CodexRunner / DockerCodexRunner、profile-scoped `CODEX_HOME`、workspace-write 挂载和 raw trace。
- Monaco 文件树、多标签编辑、Owner 明确保存、diff、受控 test task 和路径越界防护。
- Asset Candidate、人工确认/拒绝、Workspace Digest。
- Git repo 绑定、branch、diff、一次性审批后的 commit、CodeChangeAsset 候选。
- GitHub App JWT、installation token、repository binding、审批后的真实 PR、webhook HMAC 与 delivery 去重。
- Tool Registry CRUD、CLI/MCP/Docker 类型、健康检查、Context Pack 工具注入。

V1.3 新增并已通过默认门禁：

- draft Intake、版本化 Project Brief、workflow draft、确认幂等和 onboarding 恢复。
- 受管 staging/repository/worktree、外部源只读、安全 archive/upload 和 trash/restore/purge。
- GitHub create/bind/import operation key、权限与 checkout 故障状态机（test adapter）。
- Assist V3 Session/Turn、typed SSE/replay、附件、Context Pack、follow-up/interrupt 和 Diff Review。
- node-pty/WebSocket Terminal、输出脱敏/Artifact、退出 Review、重连与 orphan 恢复。
- 即时 Proposal、统一审批中心、Runtime Approval、原子 stale protection。
- Config Revision 默认写入 AIWS 托管 Profile；显式选择 cc-switch 模式时覆盖受管 CLI、rollback/reprobe 和 native fallback。
- `1440x900`、`1024x768`、`390x844` Playwright 响应式验收。

V1.4 新增容器门禁：

- production/verify 多阶段镜像、固定 Codex Runner 版本、Compose health/init/restart/stop 策略。
- Device Login、Probe、Assist app-server/exec、NodeRun 与 Terminal 统一容器名、label、资源限制、安全参数、volume-subpath 和停止清理。
- `/system/deployment` 与新版 `/health` 脱敏能力状态；容器部署禁用 Host Profile。
- Codex/cc-switch/项目根只读导入，项目与 Context Source 相对路径、symlink/realpath 越界防护。
- PowerShell/POSIX `up/down/logs/status/verify/backup/restore/reset`，命名卷备份恢复和清理确认边界。
- 隔离 Compose smoke 已覆盖 UI/health、重启持久化、sibling Runner、volume-subpath 和零遗留容器。
- 验证镜像内完整 `corepack pnpm verify` 与正式 Compose 切换均已通过；原 V1.3 `.ai-workspace` 聚合摘要保持不变。

V1.6 新增并已纳入默认源码门禁：

- schema 13→14 原子迁移、历史配置/Turn/worktree/action 保留、失败恢复与幂等校验。
- schema 14→15 独立卷克隆、全卷清单验收、旧官方 Runner 归一化和受影响 Probe 失效。
- app-server-only 的 `default | plan`、`additionalContext` 隔离、原始 model/reasoning 目录和无 Secret 配置 CRUD。
- 原生 Goal、Plan/tool/diff/reasoning/request-user-input 事件，Secret 回答只走内存通道。
- session change batch、Turn/CLI checkpoint、单写锁、累计 Review 与 Apply/Rollback 生命周期。
- `aiws_page` 白名单 dynamic tools、事务账本、普通/冲突/强制补偿 Undo。
- Codex Desktop 风格 Composer、Goal/Activity 卡、可拖动停靠面板及原生问题/回执交互。
- Linux Runner 与 Windows Go Bridge 共用代码批次；DPAPI、ConPTY、分块 Git bundle 和服务端严格导入校验。
- V1.6 unit、integration、Web、bundle budget 和 acceptance audit；容器、Playwright 与生产迁移结果按发布 runbook 记录。

V2.0 新增并已纳入正式门禁：

- schema 19→20、中央 mutation 脏标记、崩溃恢复、CAS 文本物化、损坏索引重建和 30 天未引用历史版本回收。
- 全 state collection 领域适配、仓库/附件/Artifact/CAS/运行环境资源适配，以及未分类集合覆盖警告。
- `GET /context/v1/map`、search/read/selection/policy/status/rebuild REST 接口与 `aiws_context` MCP action/resource parity。
- 密钥与宿主路径脱敏、跨项目隔离、domain scope、选择预算和投影失败显式错误。
- Context Map 全局/项目页面、六视口 Playwright、10,000 节点性能门禁和 V1.10→V2.0 只读卷克隆发布回滚。

V2.1 新增并已纳入正式门禁：

- schema 20→21、历史终态 `legacy_unassessed`、活动执行 `legacy_derived` 人审要求和 V2.0 源卷 hash 保全。
- Outcome Contract、Quality Rubric、追加式 evaluation/waiver，以及 `completion_status` 与 `release_eligible` 的真实交付判定。
- 七阶段幂等 checkpoint、capability/network preflight、结构化 Failure Envelope 和严格身份匹配的失败阶段 replay。
- 常驻 Context projector、Selection v2、Context Pack v5、finalization 闭环，以及 worker heartbeat/queue age/恢复指标。
- 六视口 Outcome/阶段/Context E2E、安全哨兵、10,000 节点性能、并发 soak 和 DesignSignal 固定 fixture 回归。

真实 Codex、GitHub 与 cc-switch live 套件本轮未运行；其 opt-in 入口和边界见 `docs/runbook.md`。

更完整的覆盖关系见：`docs/v1-coverage-matrix.md` 与 `docs/completion-audit.md`。

## 13. 模块化与代码约束

项目强调“尽量解耦、单文件不要过长”：

- API 按 `routes` 与 `handlers` 拆分。
- 前端按 `src/features`、`components`、`api`、`state` 与 `styles` 拆分。
- 共享能力沉淀到 `packages/*`，避免应用层重复实现领域规则。
- 样式按 shell、setup、workflow、workspace 和 data surface 拆分。
- `pnpm lint` 会检查 `apps`、`packages`、`tests`、`scripts` 下 JS/TS/TSX 手写模块不超过 260 行。

## 14. 常见问题

### 14.1 `pnpm` 命令不可用

生产部署不需要宿主 pnpm，使用 Docker 启动脚本。只有宿主开发需要 Corepack：

```bash
corepack enable
corepack pnpm dev
```

或使用 npm 备用命令：

```bash
npm run dev
```

### 14.2 端口被占用

改用其他端口：

```powershell
$env:AIWS_PORT="4320"; .\scripts\aiws.ps1 up
```

如果改了端口，请从对应端口打开页面，例如 `http://localhost:4320`。

### 14.3 页面能打开，但按钮点了没反应

优先检查打开方式：

```text
正确：http://127.0.0.1:4317
不要：直接双击 apps/web/index.html
不要：只用 Live Server 打开 apps/web
```

然后在浏览器里按 `F12` 打开 Console，看是否有 `Failed to fetch`、`Cannot find module` 或 404 报错。若后端没有启动，重新执行：

```bash
.\scripts\aiws.ps1 up
```

不要使用 Live Server；开发环境需要 Vite proxy，生产环境需要先执行 `pnpm build`。

### 14.4 页面没有旧数据

生产部署检查 `docker volume inspect aiws-data-v21`、保留的 `aiws-data-v20` 和 `.ai-workspace/release/v21-cutover-latest.json`。V2.1 只读克隆 V2.0 源卷并在新卷迁移；失败目标卷不会覆盖或删除源卷。宿主开发模式仍检查 `.ai-workspace/data/state.json`。

### 14.5 Codex 不可用

Setup 不能完成时，先检查 Docker、镜像、凭据、active profile、配置来源 revision、Provider Endpoint 和非写入 probe 状态。只有显式选择 cc-switch 管理模式的变更才需要检查其 CLI/桥接状态。

第三方 API 必须具备 Provider ID、`http(s)` API Base URL 和 API Key。本机发现对 `~/.cc-switch/cc-switch.db`、`CODEX_HOME` / `~/.codex` 只读打开，页面仅展示脱敏摘要；用户选中并确认后才会重读 revision，将凭据写入 vault 或托管 auth home，并重建无 secret 的 profile-scoped `config.toml`。Responses Provider 默认可直接运行，不依赖 cc-switch；Chat Completions 仍需要另行运行协议转换 proxy。

### 14.6 GitHub 未绑定

GitHub 是业务路由硬门禁的一部分；请回到 Setup 完成 Owner 授权、Installation 和 repository 选择。

### 14.7 Docker 没有启动

页面可以启动，但 Setup 不会完成，Codex Assist 与 Runner 也不会开放。启动 Docker 后重新构建并运行 probe。
