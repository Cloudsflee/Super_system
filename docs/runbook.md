# V1.3 运行与验收手册

## 当前状态

V1.3 默认离线门禁已于 2026-07-12 通过。新项目使用 draft onboarding；legacy Project 迁移为 active。受管 workspace、Assist V3、Terminal、统一审批和配置治理均已接入根 `verify`。真实 Codex、GitHub 与 cc-switch 验收仍需显式 opt-in，默认结果不能替代 live 结果。

## 启动与基础检查

1. 执行 `corepack pnpm dev`。Vite Web 默认使用 `4317`，API 默认使用 `4318` 并由 Vite proxy 转发。
2. 打开 `http://localhost:4317`；首次使用先在 `/setup` 完成 GitHub 与 Codex 服务端门禁。
3. 本地配置发现只能读取固定的 `AIWS_HOST_CODEX_HOME`、`CODEX_HOME`、`~/.codex`、`AIWS_HOST_CC_SWITCH_CONFIG_DIR`、`CC_SWITCH_CONFIG_DIR` 或 `~/.cc-switch/cc-switch.db`；HTTP 请求不能提交任意绝对路径。
4. 默认持久化目录是 `.ai-workspace`。验收时设置临时 `AIWS_HOME`，不得复用个人运行数据。
5. AIWS API 容器化时，宿主配置目录仅以只读方式挂载给 API 作为导入源；确认导入后生成托管 Profile，Runner 子容器不得直接挂载宿主配置目录。

## Project Lifecycle

1. `POST /projects` 创建 draft Project、项目级 Assist V3 Session、Intake 与初始 Brief，随后导航到 `/projects/<id>/onboarding`。
2. brainstorm 路径直接维护目标、用户、范围、约束、里程碑和 workflow draft；existing 路径还必须选择且只能选择一个代码源。
3. existing 可增加多个 context source。代码源和上传内容先进入 staging，经路径、链接、文件数、单文件及总大小校验后，才原子进入 `.ai-workspace/workspaces/<projectId>/repo`。
4. 本地源、外部 Git checkout 和远端 repository 都不是写入目标。Agent、CLI、Runner 与确认后的文件编辑只允许写受管 repo/worktree。
5. confirm 在单次 state mutation 中保存 confirmed Brief、workflow、nodes 与 contracts；重复 confirm 返回同一结果。
6. trash/restore 使用结构化 metadata。purge 要求项目名，可删除受管内容或保留到 `.ai-workspace/exports`，不会删除外部源或远端。

## Assist、Terminal 与审批

1. Ask/Plan 强制只读；Agent/CLI 每个 Turn 使用独立 worktree。dirty baseline、并发 Turn 与 apply 冲突会被拒绝。
2. typed stream 使用稳定 sequence，并支持 `Last-Event-ID` 重放、Stop、Retry、queue、steer 和 interrupt。
3. Composer 可关联 project file、Monaco 文件/选区、图片和项目附件；未知二进制只作为 Artifact，不注入模型。
4. Terminal 仅在 node-pty/WebSocket capability 可用时开放，支持 resize、Ctrl-C、重连、stop 和退出状态；完整脱敏输出写 Artifact，预览有长度上限。
5. Turn 或 Terminal 完成后在统一 Review 中检查 changed-files、diff、viewed、行评论、request changes、rollback 与 apply target hash。
6. Proposal 创建为 interrupting；关闭或 Escape 执行 defer 并进入 queued。`/approvals` 同时聚合 Proposal 和 Runtime Approval。
7. `approve_apply` 校验 revision 与 target hash；stale 或冲突不得留下半应用状态。

## 配置治理

1. Profile/Provider/MCP/Skill/AGENTS.md 变更先形成 Config Revision 或 Change Proposal，批准后才应用。
2. Config Revision 默认写入 AIWS 托管 Codex Profile，并在 Probe 后激活，不要求 cc-switch。
3. 只有显式设置 `apply_mode=cc_switch` 时才调用受管 cc-switch CLI；CLI 固定版本并校验 checksum，凭据只进入 vault 或私有临时配置，不直接写 SQLite。
4. cc-switch 模式在写入后重新发现并 Probe，失败时回滚旧 Provider；native fallback 必须由用户显式选择。
5. 默认测试使用隔离 `CC_SWITCH_CONFIG_DIR` 和 adapter，并比较外部 fixture 的 hash；不可从该结果推断真实 cc-switch live 已通过。

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

`verify` 会再次运行 lint、typecheck、unit、19 组 integration、Prisma migration check、Web build、E2E smoke、三视口 Playwright 和 acceptance audit。默认套件使用临时 `AIWS_HOME`，不读取个人凭据执行外部写入。

## 可选 Live 验收

这些命令不属于默认 `verify`，必须在明确准备的临时资源上单独运行并记录结果。

```powershell
$env:RUN_CODEX_LIVE_TESTS="1"
$env:CODEX_LIVE_TIMEOUT_MS="45000"
corepack pnpm test:live:codex

$env:RUN_GITHUB_LIVE_TESTS="1"
$env:AIWS_TEST_GITHUB_REPO="owner/private-test-repo"
$env:AIWS_TEST_GITHUB_TOKEN="..."
corepack pnpm test:live:github

$env:RUN_CC_SWITCH_LIVE_TESTS="1"
corepack pnpm test:live:cc-switch
```

GitHub 当前 live hook 是指定 repository 的只读权限探测；默认 state-machine suite 才覆盖 create/bind 故障注入。cc-switch live hook 只写临时 `AIWS_HOME`，如设置 `CC_SWITCH_CONFIG_DIR`，还会比较该目录前后的 hash/mtime 快照。

## 本轮记录

2026-07-12 的七条默认命令和完整 `verify` 均以退出码 0 完成。Codex、GitHub 与 cc-switch live 环境变量均未设置，因此三项 live 验收记录为“未运行”，不是“通过”或“失败”。详见 `completion-audit.md`。
