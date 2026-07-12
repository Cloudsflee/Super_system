# V1.4 覆盖矩阵

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

## V1.4 完全容器化增量

| 计划项 | 实现/治理边界 | 默认门禁证据 | 状态 |
|---|---|---|---|
| 版本与 schema | 根包、Web、Worker、共享包统一 `1.4.0`；state schema 保持 `13` | package unit、migration check、acceptance audit | 已验证 |
| App / Verify / Runner 镜像 | Node 24 production/verify 多阶段镜像；Codex `0.144.0` Runner 和完整工具链 | 三个 target 实际构建；容器内 Codex 版本与完整 `verify` | 已验证 |
| 单容器生产 Compose | Web/API 同容器；loopback、固定卷、socket、init、health、restart、30 秒停止 | `docker compose config`、inspect、正式切换 health | 已验证 |
| 统一 Runner argv | 唯一 name、managed/instance/kind/session/profile labels、2 CPU/4g/512 PIDs、cap drop、NNP | `v14-container.test.mjs`、真实 sibling Runner smoke | 已验证 |
| mount 与 Secret | container volume-subpath；host bind 回归；API Key/token 仅按 `env_key` 名称继承；TOML 不落 Secret | unit Secret sentinel、既有 19 组 integration、真实 volume-subpath 与自定义 Endpoint Probe | 已验证 |
| 生命周期与清理 | timeout/abort/cancel/shutdown stop；同 instance 启动清理；正常退出 `--rm` | runtime unit、NodeRun/Terminal 回归、隔离与正式 smoke 零遗留 | 已验证 |
| 五类 Codex 入口 | Device Login、Probe、Assist app-server/exec fallback、NodeRun、Terminal 全部接入 builder/runtime | capability/app-server unit、V1.2/V1.3 integrations、V1.4 unit | 已验证（推理 live 未运行） |
| Host Profile 策略 | 容器部署拒绝 Host Profile/host runner；宿主开发保留兼容 | unit、V1.4 integration、Web disabled reason | 已验证 |
| Deployment / Health | Setup 豁免、storage/docker/import capability、数据可写、响应脱敏 | V1.4 integration、Web tests、真实 API smoke | 已验证 |
| 只读发现 | 启动脚本自动发现 Codex/cc-switch，项目根显式配置，override 只读 | Compose inspect、来源摘要、正式 deployment capability | 已验证 |
| `host_import_root` | 仅相对路径；拒绝绝对/盘符/UNC/`..`/symlink/越界；导入前后 realpath/hash 复查 | unit、V1.4 integration、V1.3 import-security 回归 | 已验证 |
| 来源最小化 state | 代码源只存 name/scope/hash；Context 导入后移除路径；无项目根时仅 URL/上传 | integration state sentinel、Project onboarding UI tests | 已验证 |
| 运维脚本 | PowerShell/POSIX 八类命令；预检、保卷 down、确认 reset、安全 restore | Compose smoke、独立卷 backup/reset/restore、runbook | 已验证 |
| 最终切换 | 新建 `aiws-data-v14`；停止旧 4317/4318；不迁移/删除 V1.3 数据 | 正式 UI/health/Runner/restart；V1.3 1,833 文件聚合摘要不变 | 已验证 |
| V1.4 完整门禁 | 宿主 `verify`、验证镜像 `verify`、75 项 audit、隔离 smoke、正式切换 | 2026-07-12 最终工作树，全部退出码 0 | 已验证 |

## 外部验收边界

本轮未设置 `RUN_CODEX_LIVE_TESTS`、`RUN_GITHUB_LIVE_TESTS` 或 `RUN_CC_SWITCH_LIVE_TESTS`，因此没有运行真实推理、GitHub repository 或 cc-switch 下载/Catalog 验收。这里只确认 opt-in 脚本存在且不属于默认 `verify`；固定 Codex 版本 smoke 和默认 adapter 结果不能解释为外部 live 结果。

默认持久化仍是命名卷中的 JSON-local；Prisma/PostgreSQL 模型是可替换持久化边界，不表示本轮已切换数据库。
