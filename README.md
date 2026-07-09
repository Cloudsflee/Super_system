# AI Workspace System V1

AI Workspace System V1 是一个本地优先、自托管、MCP-first 但不是 MCP-only 的 AI 协作工作空间系统工程化原型。它围绕“项目创建 → 工作流推荐 → 节点契约 → Context Pack → Runner 执行 → Asset/Digest 沉淀 → Git/PR → 复盘审计”的完整闭环设计，适合作为毕业设计演示、原型验证和后续工程化扩展基础。

当前版本默认采用 **JSON-local 本地持久化**，不依赖外部数据库即可启动；同时保留 Prisma/PostgreSQL、Redis、Worker、CodexRunner、GitHub PR 等后续替换边界。

## 1. 项目能力概览

- **本地账号与会话**：启动后自动创建 Local Owner Account 与本地会话。
- **Project Wizard**：通过向导创建项目，并保留项目目标、约束、交付物等信息。
- **Workflow Canvas**：自动推荐并确认 5 类典型节点，支撑任务拆解。
- **Node Contract**：每个节点都有目标、验收标准、允许工具等结构化契约。
- **Always-on Assist**：前端提供常驻 Assist 面板，可生成追问、选项和字段级草稿。
- **Context Pack**：在执行前生成上下文包，包含充分性检查、Memory Manifest、工具注入与历史摘要。
- **Runner 执行**：支持 MockRunner 演示链路，也保留 CodexRunner 非交互 CLI Adapter。
- **Trace / Asset / Digest**：记录运行轨迹，产出资产候选，确认后形成 Workspace Digest。
- **Git / PR**：支持绑定本地 Git repo、创建分支、查看 diff、生成 commit，并在 GitHub 未绑定时降级为 PR 草稿。
- **Review 复盘**：集中展示 Project、Node、Trace、Asset、Digest、Decision、CodeChange/PR 证据链。
- **模块化约束**：代码按应用、路由、处理器、共享包和前端视图拆分，验证脚本限制 JS 文件长度，避免单文件过长。

## 2. 环境要求

推荐环境：

- Node.js：建议 Node.js 20+；当前工程已在 Node.js 24.14.0 下验证通过。
- 包管理器：推荐使用 Corepack 启用的 pnpm，项目声明版本为 `pnpm@10.14.0`。
- Git：Git 相关功能和集成测试需要本机可用的 `git` 命令。
- Docker：可选，仅当需要启动 Postgres / Redis 基础设施时使用。
- Codex CLI：可选，只有运行 Codex live 测试或真实 CodexRunner 时需要。

本项目当前没有第三方运行依赖，默认启动不需要数据库、Redis 或外部服务。

## 3. 快速启动项目

### 3.1 推荐方式：使用 Corepack + pnpm

在项目根目录执行：

```bash
corepack enable
corepack pnpm --version
corepack pnpm dev
```

启动成功后访问：

```text
http://localhost:4317
```

服务会同时提供：

- 本地 HTTP API
- `apps/web` 下的前端静态页面
- `.ai-workspace` 下的本地运行数据

### 3.2 如果本机已经安装 pnpm

```bash
pnpm dev
```

然后打开：

```text
http://localhost:4317
```

### 3.3 不使用 pnpm 的备用方式

```bash
npm run dev
```

当前脚本没有外部依赖，因此 `npm run dev` 也可以直接启动本地 API 与前端。

### 3.4 修改启动端口

默认端口为 `4317`。如果端口被占用，可以设置 `AIWS_PORT` 或 `PORT`。

macOS / Linux / Git Bash：

```bash
AIWS_PORT=4320 pnpm dev
```

Windows PowerShell：

```powershell
$env:AIWS_PORT="4320"; pnpm dev
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

## 4. 首次使用建议流程

1. 启动项目后打开 `http://localhost:4317`。
2. 查看页面顶部或侧边栏中的 health / Local Owner 状态。
3. 可以选择两种方式开始：
   - 点击“生成演示链路”，快速生成一条包含项目、工作流、节点、运行、资产、摘要和代码变更的样例链路。
   - 通过 Project Wizard 手动创建项目。
4. 进入 Workflow Canvas，推荐并确认工作流。
5. 打开 Node Workspace，编辑节点目标、验收标准和 allowed tools。
6. 使用 Assist 生成字段级草稿，并按需应用到 Node Contract。
7. 生成 Context Pack Preview，检查 sufficiency、included/excluded memory 和 warnings。
8. 在 Runner 页面选择 MockRunner 或 CodexRunner 执行节点。
9. 在 Asset / Digest 页面确认资产并生成工作空间摘要。
10. 在 Git / PR 页面绑定本地仓库、创建分支、查看 diff、生成 commit 或 PR 草稿。
11. 在 Review 页面查看完整证据链，用于演示和验收。

更详细的演示脚本可见：`docs/runbook.md`。

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

`verify` 会依次执行 lint、typecheck、unit、integration、Prisma schema 检查、E2E smoke 和验收审计。

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

```bash
pnpm test:live:github
```

当前 V1 默认支持 GitHub mock / 未绑定降级 PR 草稿，真实 GitHub live 能力属于可选验证路径。

## 6. 根目录结构说明

| 路径 | 用途 |
|---|---|
| `.ai-workspace/` | 本地运行数据目录。默认保存 JSON state、artifacts、演示数据和运行产物；已在 `.gitignore` 中忽略，不建议提交。 |
| `.git/` | Git 版本库元数据，由 Git 自动维护。 |
| `apps/` | 应用层代码，包含 API 服务、前端页面和 worker 入口。 |
| `packages/` | 可复用模块与共享领域逻辑，供 API、Worker、测试和后续扩展复用。 |
| `tests/` | 自动化测试目录，包含 unit、integration、e2e 和 live hook 测试。 |
| `scripts/` | 工程脚本目录，包含 lint、typecheck、verify、迁移检查和验收审计。 |
| `docs/` | 工程文档目录，包含运行手册、V1 覆盖矩阵和完成审计报告。 |
| `doc/` | 早期核心想法、问题记录和方案草稿，用于保留设计演进过程。 |
| `docker/` | 可选基础设施配置，目前提供 Postgres 和 Redis 的 Docker Compose 文件。 |
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

## 7. `apps/` 子目录说明

| 路径 | 用途 |
|---|---|
| `apps/api/` | 本地 HTTP API 服务，同时负责提供前端静态资源。入口是 `apps/api/server.mjs`。 |
| `apps/api/src/routes/` | API 路由定义，按 system、projects、assist、runs、assets、git、github、tools、demo 等功能拆分。 |
| `apps/api/src/handlers/` | 路由背后的业务处理器，承载较复杂的 Git、Runner、GitHub、Assist 等逻辑。 |
| `apps/api/src/state.mjs` | JSON-local 状态管理与运行目录初始化逻辑。 |
| `apps/web/` | 原生 HTML/CSS/JS 前端，无构建链，启动 API 后直接作为静态页面访问。 |
| `apps/web/src/views/` | 前端页面视图模块，包括 Wizard、Workflow、Node、Context、Runner、Asset、Git、Tool、Review 等。 |
| `apps/web/styles/` | 前端样式拆分，包含基础样式、布局、组件和遮罩层。 |
| `apps/worker/` | V1 worker 任务入口和任务名约定，当前主要保留后续异步任务化扩展边界。 |

## 8. `packages/` 子目录说明

| 路径 | 用途 |
|---|---|
| `packages/shared/` | 共享领域模型与核心规则，包含项目、工作流、节点契约、Memory、Context、Assist、Asset、Digest、Tool 等逻辑。 |
| `packages/runner-adapters/` | Runner 适配器，包含 AgentRunner 抽象、MockRunner、CodexRunner 命令构造和输出归一化。 |
| `packages/context-pack/` | Context Pack facade，封装上下文包生成入口和 provider 顺序。 |
| `packages/memory-policy/` | Memory Manifest 与 Sufficiency Gate facade，封装记忆纳入、排除、冲突和充分性判断。 |
| `packages/git-tools/` | Git 工具 facade，封装分支、diff、commit 等本地 Git 操作边界。 |
| `packages/mcp-bridge/` | MCP / CLI / Docker 工具配置归一化与健康检查 mock。 |
| `packages/testing-fixtures/` | 测试夹具，包含最小项目样例和临时 Git 仓库模板。 |

## 9. `tests/` 子目录说明

| 路径 | 用途 |
|---|---|
| `tests/unit/` | 单元测试，验证共享领域规则、package facade 和纯函数逻辑。 |
| `tests/integration/` | 集成测试，覆盖 API flow、Git flow、Tool flow、GitHub mock flow、Demo flow 和 Codex live hook。 |
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
- `.ai-workspace/` 已被 `.gitignore` 忽略，适合保存本机演示和调试数据。
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

## 12. 已覆盖闭环

- Local Owner Account 与本地自动会话。
- Project Wizard、Workflow 推荐/确认、5 类节点模板。
- Node Contract 创建、字段级 Assist 草稿应用、可编辑确认版本。
- Context Pack Preview / Confirm，含 Sufficiency Check 与 Memory Manifest。
- Assist 调用同样生成轻量 Assist Context Pack。
- CodexRunner 非交互 CLI Adapter，支持 JSONL / last-message 输出归一化、timeout partial 降级和取消 Trace。
- MockRunner NodeRun、Trace Timeline、raw log artifact。
- Asset Candidate、人工确认/拒绝、Workspace Digest。
- Git repo 绑定、branch、diff、commit、CodeChangeAsset 候选。
- GitHub token/env ref 绑定、PR 创建 mock 或未绑定降级 PR 草稿，并对凭据输出做 mask。
- Tool Registry CRUD、CLI/MCP/Docker 类型、健康检查、Context Pack 工具注入。
- 演示链路保留 Decision、Confirmed Asset、Digest、CodeChange actor，可证明下一次 Context Pack 接续。

更完整的覆盖关系见：`docs/v1-coverage-matrix.md`。

## 13. 模块化与代码约束

项目强调“尽量解耦、单文件不要过长”：

- API 按 `routes` 与 `handlers` 拆分。
- 前端按 `src/views`、`api.js`、`state.js`、`ui.js`、`shell.js` 等模块拆分。
- 共享能力沉淀到 `packages/*`，避免应用层重复实现领域规则。
- 样式按 `base.css`、`layout.css`、`components.css`、`overlays.css` 拆分。
- `npm run lint` / `pnpm lint` 会检查 `apps`、`packages`、`tests`、`scripts` 下 JS 模块不超过 220 行。

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

### 14.3 页面没有旧数据或演示数据

检查 `.ai-workspace/data/state.json` 是否存在。也可以在前端点击“生成演示链路”重新生成样例数据。

### 14.4 Codex 不可用

不影响默认演示。使用 MockRunner 仍可完整走通 Project、Workflow、Context、Run、Asset、Digest、Git/PR 和 Review 链路。

### 14.5 GitHub 未绑定

不影响默认演示。系统会降级生成 PR 草稿，并保留 Trace 与 CodeChange 证据。

### 14.6 Docker 没有启动

不影响默认启动。当前 V1 默认使用本地 JSON 文件持久化，Docker 只用于可选基础设施演示。
