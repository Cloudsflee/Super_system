# V1 覆盖矩阵

| 开发 / 测试计划项 | 当前实现位置 | 验证证据 |
|---|---|---|
| Local Owner Account / local_auto | `apps/api/src/state.mjs`, `/account/me` | `tests/integration/api-flow.test.mjs`, `GET /health` |
| Project Workspace 创建 | `routes/projects.mjs` | 集成测试创建 Project |
| Workflow 推荐与确认 | `recommendWorkflow`, `routes/projects.mjs` | 单元测试断言 5 节点；集成测试 confirm |
| 5 类节点模板 | `packages/shared/src/domain.mjs` | `tests/unit/shared.test.mjs` |
| Node Contract | `defaultContractForNode`, `/nodes/:id/contract` | 单元 schema 校验；confirm workflow 自动创建 |
| Project / Node Assist | `routes/assist.mjs`, `handlers/assist-sessions.mjs`, `assist-assets.mjs` | Assist Context Pack + sufficiency + manifest；集成测试 apply/reject 路径 |
| Context Sufficiency Gate | `memory.mjs`, `packages/memory-policy` | 单元测试 `buildSufficiencyCheck` |
| Memory Manifest | `memory.mjs` | 单元测试 `buildMemoryManifest`；Context Pack 集成 |
| Context Pack Preview / Confirm | `routes/runs.mjs`, `packages/context-pack` | 集成测试 preview + confirm |
| Runner Adapter / MockRunner / CodexRunner shell | `packages/runner-adapters`, `routes/runs.mjs`, `handlers/runners.mjs` | package facade；NodeRun 集成；`RUN_CODEX_LIVE_TESTS=1 pnpm test:live:codex` 可得到 succeeded/partial 且保留 raw trace |
| Worker 任务入口 | `apps/worker/src/index.mjs` | `scripts/migrate-check.mjs` 检查存在 |
| Trace Recorder | `addTrace`, 各 routes/handlers | 集成测试 NodeRun 后可查 trace |
| Asset Candidate / Confirm / Reject | `routes/assets.mjs`, `assist-assets.mjs` | 集成测试确认资产 |
| Decision Record / actor 追溯 | `packages/shared/src/decisions.mjs`, `routes/demo.mjs` | `demo-flow.test.mjs` 校验 decision / asset / digest / code_change actor |
| Workspace Digest | `buildDigest`, `/workspaces/:id/digests` | 集成测试生成 Digest v1；`demo-flow.test.mjs` 校验下一次 Context Pack 读取 Digest/Confirmed Asset |
| Git repo / diff / commit / branch | `handlers/git-*`, `packages/git-tools` | `tests/integration/git-flow.test.mjs` 在临时真实 repo 校验 branch/diff/commit/CodeChangeAsset |
| GitHub 可选绑定 / PR 草稿 | `handlers/github-*` | `tests/integration/api-flow.test.mjs` 校验未绑定 PR 草稿；`github-flow.test.mjs` 校验 token/env ref 绑定与 mock PR |
| Tool Registry / MCP 类型 / health | `routes/tools.mjs`, `packages/mcp-bridge` | `tests/integration/tools-flow.test.mjs` 校验 CLI / stdio MCP health 与 Context Pack 注入 |
| Prisma/PostgreSQL schema 草案 | `prisma/schema.prisma` | `npm run prisma:migrate:check` |
| 高交互前端 | `apps/web/index.html`, `apps/web/src/views/*`, `app.js` | `tests/e2e/smoke.test.mjs` |
| 文件解耦与长度控制 | `scripts/lint.mjs` | `npm run lint` 限制 JS 文件 <= 220 行 |

## 当前 V1 实现说明

该实现采用无外部依赖的本地 JSON 持久化来保证在当前环境可直接运行和测试；接口与领域模型按开发计划保留 Project、Workspace、Workflow、Node、Contract、Context Pack、Memory、Trace、Asset、Digest、Git、GitHub、Tool Registry 等边界。后续可以在不改变前端交互与 API 语义的前提下替换为 Prisma/PostgreSQL、BullMQ/Redis、Codex CLI Adapter live 路径和 Octokit live PR provider。
