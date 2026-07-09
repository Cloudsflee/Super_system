# V1 完成审计报告

审计日期：2026-07-09（Asia/Shanghai）

## 结论

`开发计划.md` 与 `测试计划.md` 中定义的 V1 必做闭环已实现为本地优先工程化原型，并已保留一条演示数据链路在 `.ai-workspace/`。前端已提供侧边导航、快捷键、忙状态遮罩、Always-on Codex Assist、字段级 Contract 编辑、Runner 控制、Trace/Asset/Digest/Git/Tool/Review 多视图。

## 自动验证证据

- `corepack pnpm verify`：通过。
- `RUN_CODEX_LIVE_TESTS=1 CODEX_LIVE_TIMEOUT_MS=15000 corepack pnpm test:live:codex`：通过，结果为 `partial` 且可追溯。
- `.ai-workspace/data/state.json` 演示数据：1 Project、1 Workflow、5 Nodes、1 NodeRun、1 Confirmed Asset、1 Decision、1 Digest、1 CodeChange、21 Trace events。

## V1 Definition of Done 对照

| DoD | 证据 |
|---|---|
| M0-M7 对应测试通过 | `scripts/verify.mjs` 串联 lint/typecheck/unit/integration/schema/e2e/audit。 |
| `pnpm verify` 稳定通过 | `corepack pnpm verify` 通过。 |
| 完整真实任务链路保留演示数据 | `/demo/full-chain` 与 `.ai-workspace/data/state.json`。 |
| Codex live run 成功或 partial 可追溯 | `tests/integration/codex-live.test.mjs`，CodexRunner 保存 process/error/result。 |
| Git branch + commit 成功 | `tests/integration/git-flow.test.mjs` 使用临时真实 git repo。 |
| Local Owner 与 actor 追溯 | `state.mjs` bootstrap；`demo-flow.test.mjs` 校验 decision/asset/digest/code_change actor。 |
| GitHub 可选绑定 / 未绑定降级 | `api-flow.test.mjs` 校验 PR 草稿；`github-flow.test.mjs` 校验 token/env ref mock PR。 |
| confirmed Asset 有证据引用 | `confirmAsset` 与集成测试确认资产。 |
| 新 Context Pack 读取上次 Digest / Asset | `demo-flow.test.mjs` 校验 latest_digest 与 confirmed_assets。 |
| Project Wizard 与 Node Contract Assist | `api-flow.test.mjs` 覆盖追问/选项/草稿/apply/Trace。 |
| Assist / NodeRun Sufficiency + Manifest | `buildAssistContextPack`、`buildContextPack` 与集成测试。 |
| Codex Memory 冲突不静默覆盖 | `tests/unit/shared.test.mjs` 构造 CodexMemoryHint conflict。 |
| 复盘页展示证据链 | `apps/web/src/views/review.js` 与 E2E smoke。 |
| 安装运行文档 | `README.md`、`docs/runbook.md`。 |

## 前端交互审计

- 快捷键：`1-9/0` 导航、`A` 打开 Assist、`R` 刷新、`?` 帮助。
- 忙状态：长操作显示全屏 busy overlay，失败 toast。
- Assist：右侧常驻面板展示 sufficiency、included/excluded memory、questions、options、draft patch。
- Node Workspace：可编辑 node goal、acceptance criteria、allowed tools，并用 Assist 应用草稿。
- Runner：可选择 MockRunner/CodexRunner、Codex live、mock write、刷新 Trace、取消 Run。
- Review：集中展示 Project、Node 状态、Trace、Asset/Digest/Decision、Git/PR 证据链。

## 范围说明

V1 采用 JSON-local 持久化保证当前环境直接运行；Prisma/PostgreSQL schema、Docker Postgres/Redis、Worker task names、Codex/GitHub live hooks 均保留替换边界。该实现满足 V1 工程化原型与答辩演示要求，完整生产级 NestJS/Next.js/BullMQ/Octokit live provider 属于后续演进边界。
