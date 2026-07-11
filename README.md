# AI Workspace System V1.3

AI Workspace System V1.3 是一个本地优先、自托管、MCP-first 但不是 MCP-only 的 AI 协作工作空间。V1.3 在 V1.2 已验证闭环之上，治理 draft onboarding、受管 workspace、Assist V3/Codex IDE、真实 CLI、统一审批和版本化配置。

当前版本默认采用 **JSON-local 本地持久化**，不依赖外部数据库即可启动；同时保留 Prisma/PostgreSQL、Redis、Worker、CodexRunner、GitHub PR 等后续替换边界。

> **交付状态**：V1.3 默认离线门禁已于 2026-07-12 通过。draft onboarding、受管 workspace、Assist V3、PTY/WebSocket Terminal、统一审批与 Config Revision 治理均已接入 unit、integration、三视口 Playwright、acceptance audit 和完整 `verify`。Codex、GitHub 与 cc-switch live 套件本轮未启用，不能从默认 adapter 结果推断 live 已通过。

## 1. 项目能力概览

- **本地账号与会话**：启动后自动创建 Local Owner Account 与本地会话。
- **Setup 硬门禁**：GitHub 与 Codex 均通过服务端验证后才开放业务路由。
- **项目生命周期**：新项目先创建为可恢复 draft，经 Intake、版本化 Project Brief 和 workflow draft 确认后激活；legacy Project 迁移为 active。
- **Workflow Canvas**：React Flow 全屏画布，支持 proposal、布局持久化、撤销/重做和 Inspector。
- **Node Contract**：每个节点都有目标、验收标准、允许工具等结构化契约。
- **Codex Assist**：V2 JSONL/SSE 与白名单 UIAction 保持兼容；V3 提供 Session/Turn、typed stream、附件、独立 worktree、Diff Review 和 PTY/WebSocket CLI transport。
- **Context Pack**：在执行前生成上下文包，包含充分性检查、Memory Manifest、工具注入与历史摘要。
- **五类节点工作区**：目标、调研、分析、执行、复盘分别维护结构化工作资料；执行节点内置 Monaco、diff 和受控任务。
- **Runner 执行**：正式入口只提供 CodexRunner 与隔离的 DockerCodexRunner。
- **Trace / Asset / Digest**：记录运行轨迹，产出资产候选，确认后形成 Workspace Digest。
- **Git / PR**：V1.2 支持 repo 绑定、分支、diff、commit 和 PR；V1.3 将写边界收紧到 AIWS 受管 checkout/worktree，外部源只读。
- **Review 复盘**：集中展示 Project、Node、Trace、Asset、Digest、Decision、CodeChange/PR 证据链。
- **模块化约束**：代码按应用、路由、处理器、共享包和前端视图拆分，验证脚本限制 JS 文件长度，避免单文件过长。

## 2. 环境要求

推荐环境：

- Node.js：要求 Node.js 24+（本机 cc-switch 只读发现使用 `node:sqlite`）；当前工程已在 Node.js 24.14.0 下验证通过。
- 包管理器：推荐使用 Corepack 启用的 pnpm，项目声明版本为 `pnpm@10.14.0`。
- Git：Git 相关功能和集成测试需要本机可用的 `git` 命令。
- Docker：首次配置必需，用于构建和运行隔离的 Codex 镜像。
- Codex 账号或 API Key：首次配置必需；可选官方 Device Login、直接填写第三方 Provider，或显式导入本机 cc-switch / `CODEX_HOME` 的脱敏发现结果。
- GitHub App：可使用 Hosted 模式，或在 BYO 模式提供 App 配置。

业务状态仍使用 JSON-local，不需要数据库或 Redis；前端依赖通过 pnpm workspace 安装。

已使用过 Codex 的用户可直接导入本机 `CODEX_HOME` / `~/.codex` 中的 `config.toml` 与 `auth.json`；页面只返回脱敏摘要，确认后才复制 API Key 或官方 OAuth bundle，并重建 AIWS 托管 Profile。未使用过 Codex 的用户可在 Setup 选择官方 Device Login 或手动 API 配置。

当 AIWS API 自身运行在容器中时，将宿主 Codex 目录只读挂载到容器内固定路径，并设置 `AIWS_HOST_CODEX_HOME`；可选 cc-switch 来源同理使用 `AIWS_HOST_CC_SWITCH_CONFIG_DIR`。这些挂载只用于发现和导入，Codex Runner 子容器只挂载 `.ai-workspace/codex-homes/<profileId>`，不会直接挂载或修改宿主 `~/.codex` / `~/.cc-switch`。

## 3. 快速启动项目

### 3.1 推荐方式：使用 Corepack + pnpm

在项目根目录执行：

```bash
corepack enable
corepack pnpm --version
corepack pnpm install
corepack pnpm dev
```

启动成功后访问：

```text
http://localhost:4317
```

请优先从上面的地址打开页面，不要直接双击 `apps/web/index.html`。本项目的前端按钮依赖本地 API 与浏览器模块脚本；直接打开 HTML 或使用其他静态服务器时，如果 API 未连到 `localhost:4317`，会出现页面显示但按钮无响应或操作失败。

开发命令会同时提供：

- `4318` 内部 API（由 Vite proxy 转发）
- `4317` Vite React 前端
- `.ai-workspace` 下的本地运行数据

### 3.2 如果本机已经安装 pnpm

```bash
pnpm dev
```

然后打开：

```text
http://localhost:4317
```

### 3.3 生产构建

```bash
corepack pnpm build
corepack pnpm start
```

生产启动由 API 在 `4317` 提供 `apps/web/dist`。

### 3.4 修改生产启动端口

开发地址固定为 `4317`；生产 `pnpm start` 可以通过 `AIWS_PORT` 或 `PORT` 修改端口。

macOS / Linux / Git Bash：

```bash
AIWS_PORT=4320 pnpm start
```

Windows PowerShell：

```powershell
$env:AIWS_PORT="4320"; pnpm start
```

访问地址相应改为：

```text
http://localhost:4320
```

### 3.5 修改本地数据目录

默认数据目录为根目录下的 `.ai-workspace/`。如需把运行数据放到其他位置，可以设置 `AIWS_HOME`。

Windows PowerShell 示例：

```powershell
$env:AIWS_HOME="E:\tmp\aiws-home"; pnpm dev
```

macOS / Linux / Git Bash 示例：

```bash
AIWS_HOME=/tmp/aiws-home pnpm dev
```

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

### 4.2 V1.3 使用流程

1. 创建 draft Project，选择“从 0 头脑风暴”或“基于已有项目”。
2. 恢复或完成 Intake，审查版本化 Project Brief 和初始 workflow draft。
3. 已有代码源先经 staging 与安全校验，再 clone/copy 到 `.ai-workspace/workspaces/<projectId>/repo`；外部源保持只读。
4. 确认后原子激活 Project，并只在受管 repo 或 Turn worktree 中执行写操作。
5. 在 Assist V3 的 Ask、Plan、Agent 或 CLI 模式中工作；Agent/CLI 变更进入统一 Diff Review。
6. 节点 Proposal、Runtime Approval 和配置提案通过统一审批中心决策。

以上入口已纳入默认自动化门禁；外部服务与本机 CLI 的实际可用性仍由 Setup capability/probe 和可选 live 验收决定。完整证据见 `docs/completion-audit.md`。

## 5. 常用命令

### 5.1 启动

```bash
pnpm dev
```

等价脚本：

```bash
pnpm dev:api
pnpm start
npm run dev
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

`verify` 会依次执行 lint、typecheck、unit、19 组 integration、Prisma schema 检查、Web build、E2E smoke、三视口 Playwright 和验收审计。V1.3 的 8 组新增 integration suite 已接入该门禁。

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

### 5.9 GitHub SaaS / 自托管使用文档

GitHub 集成最终采用“托管 GitHub App + 用户自带 GitHub App”双模式。按身份阅读对应文档：

| 身份 / 场景 | 文档 |
|---|---|
| 计划向其他用户提供 Supersystem SaaS | [`docs/github/saas-provider-guide.md`](docs/github/saas-provider-guide.md) |
| 独立开发者，不使用 SaaS，自己持有 GitHub App | [`docs/github/independent-developer-without-saas.md`](docs/github/independent-developer-without-saas.md) |
| 独立开发者，使用现成 Supersystem SaaS | [`docs/github/independent-developer-with-saas.md`](docs/github/independent-developer-with-saas.md) |
| 比较三者的配置成本、凭据归属、自主权和适用场景 | [`docs/github/deployment-mode-comparison.md`](docs/github/deployment-mode-comparison.md) |

无 SaaS 教程同时说明了 GitHub App Manifest 快速创建和 GitHub 后台手动创建两条路径。V1.2 已实现 App JWT、installation token、repository 同步、webhook 验签/去重和 Hosted/BYO 模式切换。

## 6. 根目录结构说明

| 路径 | 用途 |
|---|---|
| `.ai-workspace/` | 本地运行数据目录。保存 JSON state、vault、profile-scoped Codex homes、artifacts 和运行产物；已在 `.gitignore` 中忽略。 |
| `.git/` | Git 版本库元数据，由 Git 自动维护。 |
| `apps/` | 应用层代码，包含 API 服务、前端页面和 worker 入口。 |
| `packages/` | 可复用模块与共享领域逻辑，供 API、Worker、测试和后续扩展复用。 |
| `tests/` | 自动化测试目录，包含 unit、integration、e2e 和 live hook 测试。 |
| `scripts/` | 工程脚本目录，包含 lint、typecheck、verify、迁移检查和验收审计。 |
| `docs/` | 工程文档目录，包含运行手册、V1 覆盖矩阵、完成审计报告和 `docs/github/` 下的 GitHub SaaS/自托管教程。 |
| `doc/` | 早期核心想法、问题记录和方案草稿，用于保留设计演进过程。 |
| `docker/` | 可选基础设施配置，目前提供 Postgres 和 Redis 的 Docker Compose 文件。 |
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
| `开发计划v1.3.md` / `测试计划v1.3.md` | 当前 V1.3 onboarding、受管 workspace、IDE、CLI、审批和配置治理增量。 |
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

默认运行时会自动创建：

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
- 删除 `.ai-workspace/` 后再次启动，会重新初始化本地运行状态。

## 11. 可选 Docker 基础设施

V1 默认不依赖 Docker。若需要提前启动后续演进可能使用的 Postgres 和 Redis，可以执行：

```bash
docker compose -f docker/compose.infra.yml up -d
```

停止基础设施：

```bash
docker compose -f docker/compose.infra.yml down
```

当前默认服务仍使用 JSON-local；`docker/compose.infra.yml` 主要用于后续替换持久化和队列基础设施。

## 12. 已验证基线与 V1.3 增量

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

真实 Codex、GitHub 与 cc-switch live 套件本轮未运行；其 opt-in 入口和边界见 `docs/runbook.md`。

更完整的覆盖关系见：`docs/v1-coverage-matrix.md` 与 `docs/completion-audit.md`。

## 13. 模块化与代码约束

项目强调“尽量解耦、单文件不要过长”：

- API 按 `routes` 与 `handlers` 拆分。
- 前端按 `src/features`、`components`、`api`、`state` 与 `styles` 拆分。
- 共享能力沉淀到 `packages/*`，避免应用层重复实现领域规则。
- 样式按 shell、setup、workflow、workspace 和 data surface 拆分。
- `pnpm lint` 会检查 `apps`、`packages`、`tests`、`scripts` 下 JS/TS/TSX 手写模块不超过约 220 行。

## 14. 常见问题

### 14.1 `pnpm` 命令不可用

优先使用 Corepack：

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
$env:AIWS_PORT="4320"; pnpm dev
```

如果改了端口，请从对应端口打开页面，例如 `http://localhost:4320`。

### 14.3 页面能打开，但按钮点了没反应

优先检查打开方式：

```text
正确：http://localhost:4317
不要：直接双击 apps/web/index.html
不要：只用 Live Server 打开 apps/web
```

然后在浏览器里按 `F12` 打开 Console，看是否有 `Failed to fetch`、`Cannot find module` 或 404 报错。若后端没有启动，重新执行：

```bash
pnpm dev
```

不要使用 Live Server；开发环境需要 Vite proxy，生产环境需要先执行 `pnpm build`。

### 14.4 页面没有旧数据

检查 `.ai-workspace/data/state.json` 是否存在。V1.2 兼容项目从空画布开始；V1.3 draft 项目应恢复 onboarding，确认后才进入可写工作流。若行为与完成审计中的状态不一致，以当前已验证能力为准。

### 14.5 Codex 不可用

Setup 不能完成时，先检查 Docker、镜像、凭据、active profile、配置来源 revision、Provider Endpoint 和非写入 probe 状态。只有显式选择 cc-switch 管理模式的变更才需要检查其 CLI/桥接状态。

第三方 API 必须具备 Provider ID、`http(s)` API Base URL 和 API Key。本机发现对 `~/.cc-switch/cc-switch.db`、`CODEX_HOME` / `~/.codex` 只读打开，页面仅展示脱敏摘要；用户选中并确认后才会重读 revision，将凭据写入 vault 或托管 auth home，并重建无 secret 的 profile-scoped `config.toml`。Responses Provider 默认可直接运行，不依赖 cc-switch；Chat Completions 仍需要另行运行协议转换 proxy。

### 14.6 GitHub 未绑定

GitHub 是业务路由硬门禁的一部分；请回到 Setup 完成 Owner 授权、Installation 和 repository 选择。

### 14.7 Docker 没有启动

页面可以启动，但 Setup 不会完成，Codex Assist 与 Runner 也不会开放。启动 Docker 后重新构建并运行 probe。
