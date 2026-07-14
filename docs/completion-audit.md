# V1.6 完成审计报告

审计更新：2026-07-14（Asia/Shanghai）

## V1.6 结论

`开发计划v1.6.md` 与 `测试计划v1.6.md` 的业务实现、默认自动化、三视口 Playwright、构建预算、容器交付和隔离迁移/回滚演练均已完成。V1.6 使用 state schema 15、Compose project `aiws-v16`、`aiws-app:1.6.0` 与 `aiws-codex-runner:1.6.0-codex-0.144.0`，继续以 external `aiws-data-v14` 为正式升级边界。

本轮没有切换或写入正式 `aiws-data-v14`。当前 `127.0.0.1:4317` 上的 V1.5 app 保持 healthy；以下迁移和生产验收均在唯一临时容器、专用卷及随机 loopback 端口完成，结束后资源已清理。正式切换必须重新运行 V1.6 `up` 脚本生成切换时快照。

## V1.6 实现证据

| 范围 | 证据 | 结果 |
|---|---|---|
| 版本与 schema | workspace `1.6.0`；集中版本常量；schema 15；Prisma/JSON 映射；14→15 原子迁移和失败恢复 | 通过 |
| Fork 生命周期 | 原生 `thread/fork` 后才创建本地 Session；共享历史 thread 隔离；根保护；子树删除/撤销/分阶段清理 | 通过 |
| BTW / 菜单 | ephemeral native thread、内存 TTL/容量/SSE、全站菜单 registry、Shift 逃生、键盘与敏感选区保护 | 通过 |
| Assist 降噪 | 无可见身份标签/头像；真实会话树和墓碑；精简 Goal；回复尾部 Gauge；统一 Tooltip | 通过 |
| Composer | 结构化 `@` 引用和 8 个 `/` 命令；pointer capture/键盘/双击尺寸；8000 字符粘贴；10 文件拖入 | 通过 |
| 附件与引用 | 流式 multipart、SHA-256、MIME sniff、配额、原子 rename、mention/localImage、按 Turn 只读挂载、内容墓碑 | 通过 |
| 预览与安全 | inline/download/Range、文本/图片/PDF/音视频/DOCX/XLSX、未知格式降级、HTML/SVG 净化、Worker 隔离 | 通过 |
| 构建债务 | 路由、Assist、Flow、Monaco、PDF、Office 动态 chunk；manifest/gzip 自动预算 | 通过 |

## V1.6 自动化与容器门禁

| 门禁 | 最终结果 |
|---|---|
| Host `corepack pnpm verify` | 退出码 0；lint、typecheck、unit、23 组 integration、50 模型 schema check、Web build、Playwright、95 项 acceptance 全通过 |
| Web tests | 11 files / 58 tests 全通过，包含 V1.6 Context Menu、Ask、Goal/Gauge、Tooltip 和结构化 Composer |
| Visual | 1440×900、1024×768、390×844 全通过；移动 Ask 截图无 Tooltip 消退残影 |
| Bundle | initial `130.8 KiB gzip`；Assist `+77.1 KiB gzip`；5 个预览资源、7 个 Worker 隔离 |
| Compose | Docker `29.4.1`、Compose `v5.1.3`；`docker compose config --quiet` 退出码 0 |
| Production | `aiws-app:1.6.0` 构建成功；OCI version label 为 `1.6.0` |
| Runner | 固定标签 `aiws-codex-runner:1.6.0-codex-0.144.0` 可 inspect；输出 `codex-cli 0.144.0` |
| Verify image | `aiws-verify:1.6.0` 内再次执行完整 `corepack pnpm verify`，退出码 0 |
| Bridge export | 6,461,952 bytes；SHA-256 `4b36b8a60a0d85e85231652d3e3000bca4d0327467677a465d77afaff4eb1a60`；输出 `aiws-windows-bridge 1.6.0 protocol 1` |

## V1.6 隔离迁移与回滚演练

1. 使用 `aiws-app:1.5.0` 在专用卷生成合法 schema 14 基线：57 个集合、6,086 bytes、SHA-256 `16d6e3c1295070ace4b6a670ce341dc00e9039819f2ba1086091abc653a251f9`。
2. `aiws-app:1.6.0` 将其迁移为 schema 15；manifest 为 `committed`，记录的 original SHA-256 与基线完全相同，V1.6 health 为 `ok`。
3. `aiws-app:1.5.0` 尝试打开 schema 15 时以退出码 1 和 `unsupported_state_schema_15` 拒绝，未改写 state。
4. 从迁移备份恢复 schema 14 后，SHA-256 恢复为 `16d6e3c1295070ace4b6a670ce341dc00e9039819f2ba1086091abc653a251f9`；V1.5 再次启动并返回 health `ok`。
5. 演练容器、专用卷和随机端口均已清理；正式 V1.5 容器与 `aiws-data-v14` 未参与演练。

## V1.6 Live 与切换边界

| 套件/能力 | 状态 |
|---|---|
| `test:live:codex` | 未启用；真实推理由 Setup/Profile probe 决定 |
| `test:live:github` | 未启用；未创建真实远端 PR |
| `test:live:cc-switch` | 未启用；默认门禁只验证只读发现与隔离 conformance |
| Windows Bridge 持久安装 | 未执行；cross-build、版本、DPAPI/ConPTY 代码和协议集成已验证 |
| 正式 V1.6 数据切换 | 未执行；由 V1.6 `up` 脚本在新的全卷快照后完成 |

Vite 的单个 Monaco 页面 chunk 大小提示仍为非阻断提示；该 chunk 不在首屏或 Assist 初始依赖图内，自动预算已通过。

---

# V1.5 历史完成审计报告

审计更新：2026-07-13（Asia/Shanghai）

## 结论

`开发计划v1.5.md` 与 `测试计划v1.5.md` 的实现、默认自动化、容器构建、隔离迁移演练和正式切换门禁均已完成。正式实例已由 `aiws-v14` 切换为 `aiws-v15`，继续使用原 `aiws-data-v14`；state 已从 schema 13 原子迁移到 14，V1.4 容器保持停止，`127.0.0.1:4317` 上的 V1.5 app 为 healthy。

真实 OpenAI/GitHub/cc-switch live 套件和可选 Windows 宿主 Bridge 安装仍由显式 opt-in/probe 决定。本报告只确认原生协议、隔离 fixture、真实容器、Windows 可执行文件和恢复演练，不把 adapter 结果解释为外部服务成功。

## 实现与测试证据

| 范围 | 证据 | 结果 |
|---|---|---|
| 版本与部署 | 全 workspace `1.5.0`；Compose `aiws-v15`；app/Runner 固定标签；Node 24；Codex `0.144.0` | 通过 |
| schema 14 | 六个新集合、13→14/12→14 幂等迁移、临时文件/fsync/checksum/atomic rename、失败注入恢复 | 通过 |
| 历史兼容 | 旧 Profile 配置转为无 Secret configuration；历史 Turn/thread/worktree/UI action 保留且不伪造 Undo | 通过 |
| 原生 Assist | app-server-only；`default | plan`；workspaceWrite/readOnly；用户消息与 application `additionalContext` 分离 | 通过 |
| 模型与配置 | `model/list` 原始目录和任意 reasoning effort；自定义 Endpoint 保留已验证组合；配置 CRUD/affinity | 通过 |
| Goal 与交互 | `thread/goal/set|get|clear`；串行 coordinator；原生 Plan/tool/diff/reasoning/request-user-input；Secret 回答不落盘 | 通过 |
| change batch | session worktree、Turn/CLI checkpoint、单写锁、累计 Diff、Apply/Rollback 后关闭并创建新批次 | 通过 |
| 网页操作账本 | `aiws_page` 白名单 dynamic tools、risk approval、SSE claim/commit、canonical hash、normal/conflict/forced Undo | 通过 |
| Desktop UI | 无 Ask/Agent/CLI 模式栏；原始 model/reasoning；单次 Plan；Goal/Activity/问题/回执；拖拽/键盘/小屏 | 通过 |
| Linux CLI | Runner、session model/reasoning、change batch、checkpoint/锁/Review、取消与退出清理 | 通过 |
| Windows Bridge | Go 自包含 exe、DPAPI CurrentUser、ConPTY、loopback WebSocket、配对、分块 bundle、双向 workspace | 通过 |
| Bundle 安全 | verify、`fsck --strict`、base/ref/path/size/object/case/symlink/submodule 拒绝 | 通过 |
| 运维 | PowerShell/POSIX V1.5 镜像、事务快照、严格归档 create/validate、恢复 hash 复核、Bridge 管理命令 | 通过 |

## 自动化与构建门禁

| 门禁 | 最终结果 |
|---|---|
| `corepack pnpm verify` | 退出码 0；lint、typecheck、unit、22 组 integration、50 模型 schema check、Web build、smoke、Playwright、acceptance 全通过 |
| Web tests | 10 files / 48 tests 全通过；包含 V1.5 Plan、Goal、原生问题、Undo 冲突、Activity、SSE replay、runtime focus 与 resize |
| V1.5 unit | core/migration/context/model/Goal/input、operation ledger、change batch/Bridge 全通过 |
| V1.5 integration | native Assist 全流程与真实 WebSocket Host Bridge round-trip 全通过 |
| Acceptance | `V1.5 acceptance audit passed (73 implementation checks)` |
| Compose | `docker compose config --quiet` 退出码 0；loopback、卷、安全参数与镜像展开值正确 |
| Production | `aiws-app:1.5.0` 构建成功；native `node-pty` 使用镜像自带 Node headers，不依赖在线 header 下载 |
| Runner | `aiws-codex-runner:1.5.0-codex-0.144.0` 输出 `codex-cli 0.144.0` |
| Verify image | `aiws-verify:1.5.0` 内再次执行完整 `corepack pnpm verify`，退出码 0 |
| Bridge export | Docker cross-build 导出约 6.46 MB Windows exe；运行输出 `aiws-windows-bridge 1.5.0 protocol 1` |

首次验证镜像运行曾发现 Linux 容器不能直接执行无 executable bit 的 `.mjs` Codex fixture；`resolveCodexInvocation` 已改为 Windows/Linux 都经当前 Node 启动绝对 JS fixture，宿主专项测试和验证镜像完整门禁随后均通过。

## 隔离真实容器与恢复演练

使用唯一 Compose project、随机 loopback 端口和专用卷完成以下流程，结束后容器、网络、卷和临时目录均已清理：

1. seed schema 13 → 全卷备份 → V1.5 Compose start → schema 14/六集合/migration manifest 校验。
2. app restart 前后 state SHA-256 一致。
3. Runner 实际 mount 仅为 `/codex-home` 与 `/workspace`。
4. 清空临时卷并恢复 schema 13 归档，恢复后 SHA-256 与 seed 完全一致。
5. `aiws-app:1.4.0` 在恢复副本上启动至 healthy。

Host Bridge integration 另覆盖配对、凭据 verifier、协议版本、断线、terminal stream、workspace 双向分块、统一写锁/Review，以及恶意 Git bundle/path/symlink/submodule/case collision 拒绝。

## 正式迁移与备份证据

### 切换前

| 项目 | 值 |
|---|---|
| V1.4 app | `aiws-v14-app-1` healthy；旧 app image `sha256:4a2b9e9ecee02e113b4ba9b15c791279fceea06835c59694d2e57108487417dc` |
| V1.4 Runner | `sha256:dc0871c2f1cbcdf2f07ebb0518f364a18fa7691444c58154dcefb2df9e42abde`；遗留 managed Runner 0 |
| state | schema 13；128,918 bytes；SHA-256 `39e3f47920d4848d83faf9492730d9dab03808de7b516ee145734ff7eb33ff83` |
| canonical hash | `58b29d41bd0626317a1a18b75d6f84fa081f83505f9f3bf115fbcc3049af129c` |
| 历史 | Assist sessions 2、Turns 6、worktrees 0、UI action intents 0 |

内部迁移 manifest `state-schema13-2026-07-13T14-57-38-641Z.manifest.json` 状态为 `committed`；其 original SHA/canonical hash 与上表完全一致，migrated canonical hash 为 `b9baac94c709019837b2333f7001168ae5715634acc6e0a8fc01fb61f1e5d387`。

### 回滚归档

- 原始全卷归档 SHA-256：`3aef3b7acfa5d2e5c7f27610bd806e17cf4a93fee0e5825baf81980d79e3111e`，原样保留审计。
- 原始归档含 Codex `tmp/arg0` 的 4 个绝对 symlink，严格恢复器正确拒绝。备份器已改为创建时排除 `codex-homes/*/tmp`，并支持仅指向归档根内的相对 symlink。
- 从原始归档生成的安全归档 `aiws-v14-before-v15-20260713-225722350.safe.tar.gz` SHA-256 为 `3fde334c2c8f82ae01a2004478ef3a444dd416a5722d65366f2227f4bc1852f8`；其中 schema 13 state 仍为 128,918 bytes 且 SHA-256 完全一致。
- 安全归档已恢复到独立卷，并由 V1.4 镜像启动至 healthy。
- 迁移后全卷备份 SHA-256：`042501adcf2b84e6ec07b4646b12a1121ece7e5e707fd540153ef37880076674`，已通过新版严格 validator。

## 正式 V1.5 运行态

| 项目 | 最终证据 |
|---|---|
| 服务 | `aiws-v15-app-1` healthy；`http://127.0.0.1:4317/api/health` 为 `ok`；V1.4 容器为 exited |
| 镜像 | app `sha256:f0dc55415797b3ebb0eecf294c189ca731dffba2d87a7231a5ba8b909b8ed6fd`；Runner `sha256:f815fa666d213efca014a5e3b064619b07a0052c1a4677570899b65ef5ffac38` |
| state | schema 14；129,455 bytes；SHA-256 `6369ccdfab99f2890ae3784b01512125028d91d38a407934cf736da00fab3ffe` |
| 历史保持 | Assist sessions 2、Turns 6；六个新集合存在；旧记录计数未减少 |
| 持久化 | 使用最终 production image recreate 后再 restart，state SHA-256 保持一致 |
| 隐私 | `/system/deployment` 不包含卷名、宿主路径、`CODEX_HOME` 或 Docker socket |
| 清理 | managed Runner 0；正式卷仍为原 `aiws-data-v14`；V1.3/V1.4 宿主资料未删除或改写 |

## Live 与可选能力边界

| 套件/能力 | 状态 |
|---|---|
| `test:live:codex` | 未启用；真实推理由 Setup/Profile probe 决定 |
| `test:live:github` | 未启用；未创建真实远端 PR |
| `test:live:cc-switch` | 未启用；默认测试只验证只读发现与隔离 conformance |
| Windows Bridge 实机安装 | 可选，未在本机持久安装；cross-build、exe version、DPAPI/ConPTY 代码与协议集成已验证 |

Vite 对大 chunk 的提示仍为非阻断构建提示，不影响本轮验收。
