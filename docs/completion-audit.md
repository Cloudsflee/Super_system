# V1.4 完成审计报告

审计更新：2026-07-13（Asia/Shanghai）

## 结论

`开发计划v1.4.md` 与 `测试计划v1.4.md` 的默认离线及真实容器完成标准已满足。V1.4 已将生产 Web、API 和 JSON-local 数据放入单一长期 app 容器，并通过 Docker socket 创建短生命周期 Codex sibling containers；宿主开发模式和 V1.3 `.ai-workspace` 保持独立。

本轮已完成宿主完整门禁、验证镜像完整门禁、隔离 Compose smoke、独立卷备份恢复以及正式 `127.0.0.1:4317` 切换。真实 OpenAI 推理、GitHub 和 cc-switch live 套件仍为显式 opt-in，本报告不把默认 adapter 或版本 smoke 解释为外部服务成功。

Assist 增量已加入同一门禁：每个 Turn 固化 Profile、模型和思考深度；安全克隆常用配置；页面字段修改必须先预览再人工应用；Markdown/GFM 与连续 text delta 使用安全流式渲染。

## 交付证据

| 范围 | 实现与测试证据 | 结果 |
|---|---|---|
| 版本与数据边界 | 全 workspace `1.4.0`；state schema 保持 `13`；JSON-local；全新固定卷 `aiws-data-v14` | 已验证 |
| App / Verify 镜像 | Node 24 多阶段 Dockerfile；生产 Web/API；Git、SSH、tar、Python、Docker CLI/Compose；验证镜像含 Chromium 与 Codex `0.144.0` | 已验证 |
| Runner 镜像 | `aiws-codex-runner:1.4.0-codex-0.144.0`；Git、bash、ripgrep、Python3、native build toolchain | 已验证 |
| Compose | loopback `4317`、`init`、healthcheck、`unless-stopped`、30 秒停止窗口、固定卷和 Docker socket | 已验证 |
| 统一 Runner runtime | Device Login、Probe、Assist app-server/exec、NodeRun、Terminal 和 conformance 共用名称、label、资源/安全参数及 mount builder | 已验证 |
| 生命周期 | timeout、AbortSignal、Terminal stop、Device cancel、API shutdown 显式停止；启动清理同 instance 遗留容器 | 已验证 |
| volume-subpath | 容器模式只挂载托管 profile/workspace 子目录；宿主开发继续 bind mount；RPC cwd 为 `/workspace` | 已验证 |
| 自定义 Provider 凭据 | 托管 TOML 只保存 `env_key`，API Key 经环境继承；`requires_openai_auth` 导入配置经 unit 与真实脱敏 Probe 验证可发送 Bearer header | 已验证 |
| Deployment / Health | Setup 前可访问的脱敏 deployment；health 区分数据可写、Docker 与 degraded Provider，不返回 state/socket/卷路径 | 已验证 |
| 宿主只读导入 | Codex、cc-switch 自动只读挂载；可选 projects root；相对路径、symlink、realpath、前后 hash 复查 | 已验证 |
| Web | Setup、Project onboarding、Settings 展示部署能力；无导入根时隐藏宿主路径入口；容器模式禁用 Host Profile | 已验证 |
| Assist 配置与页面动作 | 逐 Turn `profile/model/reasoning` 快照；受限配置克隆；surface 字段白名单；人工应用页面草稿；Markdown/GFM 与 delta 合并 | 已验证 |
| 运维 | PowerShell/POSIX `up/down/logs/status/verify/backup/restore/reset`；reset 仅删除固定卷且要求确认 | 已验证 |

## 自动化门禁

2026-07-13 在最终工作树上执行：

| 命令 / 门禁 | 结果 |
|---|---|
| `corepack pnpm verify` | 退出码 0；lint 231 个模块、typecheck、unit、20 组 integration、44 模型 migration check、Web build、E2E、Playwright、acceptance 全通过 |
| Web unit | 9 files / 42 tests 全通过 |
| V1.4 unit / integration | container 参数、Secret、路径和生命周期 unit；deployment/import integration 全通过 |
| Acceptance audit | `V1.4 acceptance audit passed (75 implementation checks)` |
| `docker compose config --quiet` | 退出码 0 |
| Production target | `aiws-app:1.4.0` 构建成功，`node-pty`、Docker/Compose、Git/SSH/tar/Python 可用 |
| Runner target | 固定输出 `codex-cli 0.144.0` |
| Verify target | `aiws-verify:1.4.0` 构建成功；容器内 `corepack pnpm verify` 退出码 0 |
| 独立卷恢复 | seed → backup → 删除测试卷 → validate → restore 后内容摘要一致 |

## 隔离真实容器 Smoke

使用唯一 Compose project、随机 loopback 端口和专用测试卷运行最终镜像，结果如下：

- UI 返回 200；health 为 `ok`；deployment 为 `container/docker_volume`，Docker ready。
- sibling Runner 返回 `codex-cli 0.144.0`，使用 volume-subpath，结束后 managed Runner 为 0。
- app restart 后 Owner、state 和卷内 sentinel 保留。
- deployment 响应未出现卷名或 socket 路径。
- 测试结束后专用容器、网络和卷均已清理，没有触碰生产卷或 V1.3 数据。
- 正式 `4317` 页面在 `1440x900` 与 `390x844` 视口检查 Assist、Composer 和配置区，边界与横向溢出检查均通过。

## 正式切换验收

切换前确认 `aiws-data-v14` 不存在，并只停止了仓库对应的旧 Vite `4317` 与 API `4318` 进程。随后通过 `scripts/aiws.ps1 up` 创建新卷并启动正式服务。

| 项目 | 最终证据 |
|---|---|
| 服务 | `http://127.0.0.1:4317` UI 200，app healthy，Compose project 仅 1 个长期容器 |
| Deployment | container、docker_volume、socket ready；Codex/cc-switch import ready；projects root=false |
| 镜像 | app `sha256:3962444eee58a8dadd3ad4eb963faea3c8929eabd666f20c3b7de0563dd0326c`；Runner `sha256:943afb2004dce6a0c07757fb84c2d9bff35794c86bd750bac4ad4a840399c7d0` |
| Runner | 正式 app 经 socket 启动 sibling Runner，版本 `0.144.0`，退出后遗留数 0 |
| 持久化 | 完成启动规范化后再次 restart，Owner 与 state SHA-256 保持一致 |
| 容器策略 | loopback、`init=true`、`unless-stopped`、`cap-drop=ALL`、`no-new-privileges`、只读宿主导入均经 inspect 验证 |
| V1.3 数据 | `.ai-workspace` 共 1,833 个文件、116,964,697 bytes；切换前后包含路径、内容和 mtime 的聚合摘要一致 |
| 本机导入 | Codex config/auth 内容与 mtime 一致；cc-switch mount 为只读，受控 AIWS restart 窗口内 DB 长度、mtime 与 SHA-256 一致 |

cc-switch 桌面程序在较长观察窗口内会自行写入其已打开的 SQLite DB；这与 AIWS 无关。验收使用 Docker inspect 的 `RW=false`、隔离 fixture 前后摘要以及受控 AIWS restart 窗口共同确认 AIWS 未写宿主来源。

## Live 验收边界

| 套件 | 本轮状态 |
|---|---|
| `test:live:codex` | 未启用；未进行真实 OpenAI/第三方推理 |
| `test:live:github` | 未启用；未访问或创建真实验收仓库 |
| `test:live:cc-switch` | 未启用；仅验证只读发现、固定 Runner 和隔离 conformance |

Vite 对大 chunk 的提示仍是非阻断构建提示，不影响本轮容器化验收。
