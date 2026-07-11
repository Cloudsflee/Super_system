# V1.3 覆盖矩阵

状态定义：`已验证` 表示实现与默认离线自动化证据均存在；`已验证（live 未运行）` 表示默认适配器、隔离 fixture 和失败路径已通过，但真实外部服务验收仍需显式 opt-in。计划条目、Schema 或静态字符串检查不能单独形成“已验证”结论。

## V1.2 回归基线

| 计划项 | 实现边界 | 主要证据 | 状态 |
|---|---|---|---|
| Setup 前后端硬门禁 | `setup-status.mjs`、`setup-v12.mjs`、`setup-guard.tsx` | `v12-flow.test.mjs`、`v12-github-security-flow.test.mjs` | 已验证 |
| GitHub App、Device、Installation、Webhook | `github-service.mjs`、`github-*-v12.mjs` | GitHub security flow | 已验证 |
| Secret vault 与出口脱敏 | `vault.mjs`、`http.mjs`、`state.mjs` | integration secret sentinel | 已验证 |
| Codex 四来源、Profile、TOML 与 Probe | `codex-discovery-*`、`codex-service.mjs`、`codex-v12.mjs` | discovery unit/integration、Playwright | 已验证 |
| Workflow、五类节点与 Canvas | `domain.mjs`、`workflow-v12.mjs`、`features/nodes` | shared、V1.2 flow、Web tests、Playwright | 已验证 |
| 文件、Runner、Git 与一次性审批 | file/run/git routes | files/API/Git/GitHub flows | 已验证 |
| Assist V2 JSONL/SSE/resume/UIAction | `assist-runtime.mjs`、`assist-v12.mjs` | `v12-assist-flow.test.mjs`、legacy continue fixture | 已验证 |

## V1.3 增量

| 计划项 | 实现/治理边界 | 默认门禁证据 | 状态 |
|---|---|---|---|
| 版本与领域记录 | 全 workspace `1.3.0`；Project lifecycle 字段；9 个新增模型 | `prisma:migrate:check` 检查 44 个核心模型；unit 与 acceptance audit | 已验证 |
| 旧数据迁移 | legacy Project 默认 active；外部 repo migration required；V2 Session、queued Proposal、orphan Turn/Terminal | `v13-migration-flow.test.mjs` 含重启、V2 continue、受管迁移和外部 repo 快照 | 已验证 |
| draft onboarding 与 Project Brief | brainstorm/existing、刷新恢复、Brief 多版本、写门禁、原子幂等激活 | `v13-project-lifecycle-flow.test.mjs`、复用 helper 的 brainstorm flows、三视口 Playwright draft redirect | 已验证 |
| 统一安全导入 | local Git/目录、GitHub、TAR/ZIP、目录上传与 context；staging、路径/链接/数量/大小限制；外部源不变 | lifecycle/import-security/service tests，含失败清理、重试和源 hash/mtime 快照 | 已验证 |
| trash/restore/purge | 结构化 trash metadata、名称确认、受管目录恢复/删除或 exports 保留 | lifecycle/import-security integration | 已验证 |
| GitHub create/bind 状态机 | 默认 private、installation 权限、managed clone、remote/HEAD、operation key | `v13-github-repository-flow.test.mjs` 的 test adapter、clone/HEAD/remote 故障注入与 secret sentinel | 已验证（live 未运行） |
| Assist V3 Guided/Agent | Session/Turn、typed event、replay、queue/steer/interrupt、Context Pack、附件、worktree、Review | `v13-assist-worktree-flow.test.mjs`、`v13-assist-lifecycle-flow.test.mjs`、app-server unit | 已验证（Codex live 未运行） |
| CLI transport | xterm、node-pty/WebSocket、输入/resize/Ctrl-C/reconnect、截断/脱敏、orphan、Review | `v13-terminal-flow.test.mjs` 与前端 capability tests | 已验证（Host/Docker Codex TUI live 未运行） |
| 统一审批 | interrupting/queued/resolved、Proposal/Runtime 聚合、原子 decision、revision/target hash/stale/幂等 | `v13-governance-flow.test.mjs`、Playwright Escape/即时审批 | 已验证 |
| Config Revision 与可选 cc-switch CLI | 默认 native Profile、Profile/MCP 校验；显式 cc-switch 的 checksum/Catalog、私有临时写入、rollback/reprobe/native fallback | governance/service tests、隔离 `CC_SWITCH_CONFIG_DIR`；真实 fixture hash 不变 | 已验证（cc-switch live 未运行） |
| IDE 四形态与响应式 | docked/floating/minimized/mobile fullscreen、Composer/Review/Terminal；无 scrim | Web tests；`1440x900`、`1024x768`、`390x844` Playwright 与截图 | 已验证 |
| V1.3 完整门禁 | 根 scripts、8 个 V1.3 integration suites、acceptance audit、文档和 runbook | 2026-07-12 依次执行七条必跑命令及完整 `verify`，退出码均为 0 | 已验证 |

## 外部验收边界

本轮未设置 `RUN_CODEX_LIVE_TESTS`、`RUN_GITHUB_LIVE_TESTS` 或 `RUN_CC_SWITCH_LIVE_TESTS`，因此没有运行真实 Codex、GitHub repository 或 cc-switch 下载/Catalog 验收。这里只确认 opt-in 脚本存在且不属于默认 `verify`；不能把默认 adapter 结果解释为 live 结果。

默认持久化仍是 JSON-local；Prisma/PostgreSQL 模型是可替换持久化边界，不表示本轮已切换数据库。
