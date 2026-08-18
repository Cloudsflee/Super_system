# V3 功能恢复与架构治理判断

## 1. 文档信息

- 判断日期：2026-08-10
- V2.3 行为基线：`e18dc0b616fa7ab2b00a6c05db23890ccd940175`
- V3 初始重建基线：`14324a9699051ed25372e844ecc38e5c0387c813`
- 当前审计提交：`c71d0815fb0f88762a2d2f604a97ded70121b001`
- 当前分支：`recovery/v3-feature-restore`
- 文档性质：架构判断和恢复决策，不是功能完成声明

## 2. 核心结论

当前 V3 不是 V2.3 的完整功能升级版，而是一个执行隔离、数据一致性、证据可信度和发布恢复能力更强，但用户功能明显缩水的新底座。

最终选择应当是：

> 以当前 V3 作为唯一运行时底座，以 V2.3 作为行为标准和成熟代码供体，逐个纵向功能闭环迁移；既不恢复 V2.3 整体运行时，也不继续根据计划摘要重新猜测和简化实现成熟功能。

这意味着：

1. 保留 V3 的 Broker、签名 Job Spec、Runner digest、SQLite、CAS、SHA、Managed Worktree、幂等、Draft PR 和发布回滚链。
2. 从 V2.3 提取真实状态机、错误、事件、恢复行为和前端交互，再接入 V3 的 repository、command、event 和 API 边界。
3. 替换当前固定返回值、立即完成、默认满分等占位实现。
4. 没有真实业务行为、聚焦测试和验证证据的能力不得标记为 `implemented`。

## 3. 当前审计结果

### 3.1 规模和覆盖旁证

| 项目 | V2.3 | 当前 V3 |
| --- | ---: | ---: |
| Git 跟踪文件 | 1087 | 228 |
| `*.test` / `*.spec` 测试源文件 | 185 | 30 |
| 当前测试声明 | - | 75 |
| V2.3 路由注册表 operation | 约 351 | 当前 Command Registry 为 59 个 mutation command |
| 顶层前端页面 | 成熟功能工作台 | 10 个简化页面 |

文件量和路由量不是完成度本身，但与逐项行为审计共同表明，当前 V3 尚未迁移 V2.3 的大部分成熟工作流。

### 3.2 未闭合能力统计

- 未闭合能力簇：22 个
- 定义性能力未实现：3 个
- 已有基础但闭环不完整：19 个
- 仅差真实外部证据：0 个

当前 `feature-catalog.json` 将 26 项全部标为 `implemented`，但治理脚本只检查字段、ID、目标路径和测试文件是否存在，不检查行为等价，因此该结果不能作为恢复完成率。

### 3.3 未闭合能力清单

| # | 状态 | 主要缺口 |
| ---: | --- | --- |
| 1 | 部分实现 | Session token 未接入 HTTP 鉴权；Setup readiness 未成为项目、执行和交付硬门禁。 |
| 2 | 部分实现 | Codex Device Auth、发现/导入、Profile 独立 Probe、Profile-specific `CODEX_HOME` 和 Profile 到 Runner 的选择链。 |
| 3 | 部分实现 | Host Runner、Profile 驱动的 Custom Provider、Web Search、Reasoning、Timeout、Sandbox 和 runtime recovery。 |
| 4 | 部分实现 | Tool Registry CRUD/health、stdio MCP、完整 HTTP MCP resources/actions、分页、operation lifecycle、Context/GitHub 工具注入。 |
| 5 | 部分实现 | Draft Project、Intake retry/cancel/resume、Brief preview/confirm/template 和 Workflow Draft。项目当前直接进入 `active`。 |
| 6 | 部分实现 | 真正的 Workstream/Task 两级模型、Canvas 布局历史、结构 Proposal 和完整 Node Contract。当前主要是扁平 Task 的 `level=1|2`。 |
| 7 | 未实现 | 真实 Workflow Generation 和独立 critic。当前同步返回固定两个节点并直接判定通过。 |
| 8 | 部分实现 | 七阶段 checkpoint、失败阶段 replay、人工/PR checkpoint、pause/resume 和 replan。 |
| 9 | 部分实现 | Evidence、Rubric、Quality Review 驱动的 Outcome，以及 waiver 审批、撤销和证据变化后的重评。 |
| 10 | 部分实现 | Repository Connection/Target/Line、多仓库、fault state、archive/upload/trash/restore/purge。 |
| 11 | 部分实现 | GitHub App JWT、Installation Token、仓库发现、Webhook HMAC/去重、PR Intent 和 Delivery Policy/Event。 |
| 12 | 未实现 | 真正的四层 AI Assist。当前 Turn 只保存用户消息并立即完成，没有 assistant 回复和原生工具、命令、文件、diff、reasoning 事件。 |
| 13 | 部分实现 | Assist Attachment 完整 UI、Monaco 文件树/多标签/显式保存、controlled test task 和完整 Diff Review。 |
| 14 | 部分实现 | Proposal before/after/hash 展示和语义执行；Runtime User Input 与 Execution 等待、恢复的联动。 |
| 15 | 未实现 | 独立 Windows Native Bridge、pairing、DPAPI、Bridge RPC、ConPTY/Git bundle 往返。当前是 API 进程内直接运行本机 PTY。 |
| 16 | 部分实现 | 全量 Context Map 投影、受控搜索、Policy/ACL/Exchange Grant、敏感级、新鲜度、token budget 和索引恢复。 |
| 17 | 部分实现 | 完整 Context Pack v5，包括精确 document version、Outcome/Rubric hash 和完整 Memory Manifest。 |
| 18 | 部分实现 | Asset Candidate confirm/reject、Attestation、Relation、Trace、Digest、CodeChange 和 TestResult。 |
| 19 | 部分实现 | Deployment/Browser/Viewport 结果进入 CAS 并绑定 Evidence 链。当前脚本截图仍是测试目录产物。 |
| 20 | 部分实现 | Quality Review worker/parser isolation、DOCX/XLSX、prepare snapshot、freshness/policy/rubric、逐维人工评分和 Outcome 联动。 |
| 21 | 部分实现 | Context Map、Node Workspace/Monaco、Quality/Outcome、Repository Line 等成熟前端工作流。 |
| 22 | 部分实现 | V2.3 数据导入及中断恢复、用户级 `up/down/logs/status/backup/restore/reset`、`/health` 和 `/system/deployment`。 |

## 4. V2.3 和 V3 的真实优势

### 4.1 V2.3 的优势

V2.3 的优势集中在产品能力和工作流成熟度：

- 四层 Assist 及真实模型、工具和事件生命周期。
- Workstream/Task、Workflow Canvas、Generation、critic 和七阶段执行。
- 完整 Context、Quality Review、Outcome 和 Evidence 工作流。
- GitHub App、Repository Line、Delivery、Windows Bridge 和 MCP 能力。
- 更完整的前端信息架构、异常状态和用户操作路径。
- 更大规模的行为测试和历史边界条件积累。

从当前用户可用性看，V2.3 明显优于当前 V3。

### 4.2 V3 已经落地的优势

V3 的优势集中在可信执行和运维基础：

- SQLite 外键、事务、revision 和幂等键替代全局 state snapshot。
- Broker 是 Docker CLI 唯一所有者。
- HMAC 签名 Job Spec、nonce、deadline、digest、路径和资源约束。
- 临时 Runner、受限网络、只读根文件系统、cap-drop 和临时凭据清理。
- Execution 固定 Brief、Workflow、Repository SHA、Context Pack 和输入 Asset。
- Managed Worktree、baseline SHA、单写锁和 stale protection。
- CAS、Diff SHA、输出检查、rollback asset 和 Evidence Link。
- Delivery 分支、expected head SHA、Draft PR、合并后本地 baseline 同步。
- 镜像身份、SBOM、临时卷验收、备份 hash、恢复和 rollback receipt。
- 统一 `/api/v1`、V3 error envelope、operation receipt 和 cursor replay。

这些优势主要降低执行、数据、交付和发布风险，不会直接补齐用户功能。

### 4.3 当前仍属于纸面设计的 V3 能力

下列表虽然已经进入 schema，但没有实际业务读写，不能算已落地优势：

- `connected_accounts`
- `setup_states`
- `config_revisions`
- `project_intakes`
- `workflow_drafts`
- `execution_stage_checkpoints`
- `repository_connections`
- `repository_targets`
- `repository_lines`
- `pull_request_intents`
- `delivery_policies`
- `delivery_events`
- `context_policies`
- `context_summaries`
- `asset_blobs`
- `asset_attestations`
- `asset_relations`
- `traces`
- `digests`
- `code_changes`
- `test_results`

## 5. 底座选择判断

### 5.1 方案 A：直接以 V2.3 为主干改造

优点：

- 成熟用户功能和 UI 保留最多。
- 短期恢复演示功能较快。
- 边界行为和异常流程丢失较少。

主要风险：

- 旧 state runtime、迁移链、版本路由和兼容 facade 与大量业务模块耦合。
- 改造持久化、API、事件、Runner 和 Evidence 边界会触碰几乎所有功能。
- 容易长期形成 V2/V3 混合运行时，最终难以证明旧架构已退出。
- 发布、恢复和安全边界需要重新建立和重新取证。

结论：适合只追求短期功能演示、不坚持 V3 架构约束的场景；不适合作为最终 V3 运行时主干。

### 5.2 方案 B：基于当前 V3 重新编写全部功能

优点：

- 可以严格保持 V3 数据、API 和安全边界。
- 不会携带旧运行时依赖。

主要风险：

- 容易根据计划摘要重新猜测成熟行为。
- 会遗漏 V2.3 已经处理的状态机、恢复、并发和 UI 边界。
- 当前固定 generation、立即完成 Assist、100/0 Outcome 和默认质量分数已经证明这种方式会产生行为缩水。

结论：不应继续采用从需求名称重新设计成熟功能的方式。

### 5.3 推荐方案：V3 底座加 V2.3 定向迁移

保留 V3 的平台基础，对每个功能执行：

```text
读取 V2.3 真实实现和测试
-> 提取可执行行为契约
-> 识别可复用领域逻辑
-> 替换旧 state/API/事件依赖
-> 接入 V3 Repository/Command/Event/Adapter
-> 迁移成熟 UI 交互
-> 双端行为对照
-> 验证失败、恢复和回滚
```

迁移的是成熟业务行为和可复用算法，不迁移旧路由、旧 state runtime、旧迁移链和版本后缀模块。

## 6. 当前 V3 重演 V2.3 混乱的风险

当前已经出现以下早期信号：

1. `apps/api/src/domain.mjs` 超过 2400 行，承担过多领域职责。
2. `apps/api/src/http.mjs` 使用大型条件链集中维护路由。
3. `apps/web/src/pages.tsx` 集中全部页面和大量工作流状态。
4. Schema 预留大量没有运行时所有者的表。
5. Catalog 状态和开发计划状态相互矛盾。
6. 当前测试主要验证简化契约自洽，没有证明与 V2.3 行为等价。
7. 多个占位实现返回成功状态，掩盖功能未接入事实。

如果继续横向增加表、路由和页面，再集中补业务逻辑，V3 会再次形成难以维护的大型共享模块和永久半成品。

## 7. 强制架构规则

### 7.1 领域纵向模块

目标结构：

```text
apps/api/src/modules/
  identity/
  setup/
  workflow/
  assist/
  execution/
  context/
  evidence/
  quality/
  repository/
  delivery/
```

每个模块根据实际需要包含：

```text
contract.mjs
commands.mjs
queries.mjs
service.mjs
repository.mjs
events.mjs
```

依赖方向固定为：

```text
HTTP -> Command/Query -> Domain Service -> Repository/Adapter
```

约束：

- Raw SQL 只允许进入 repository 或专用 migration。
- Docker CLI 只允许进入 Broker。
- GitHub 网络请求只允许进入 GitHub adapter。
- Secret 只通过 credential reference 和受控解析器获取。
- 领域服务不得依赖 HTTP request/response。
- 文件访问必须通过受控 workspace、CAS 或 attachment adapter。
- 禁止模块循环依赖。

### 7.2 一个领域只保留一个当前实现

禁止新增 `assist-v12.mjs`、`workflow-v20.mjs` 一类按版本复制的运行时模块。

版本变化通过以下机制表达：

- 数据库 migration。
- payload `schema_version`。
- 边界兼容 adapter。
- 有到期版本和删除测试的 feature flag。

历史实现保留在 Git，不保留在当前运行时目录。

### 7.3 数据表必须有唯一业务所有者

每张表必须登记：

- 所属领域模块。
- 写入 command。
- 查询入口。
- 对外事件。
- 清理和归档策略。
- migration 和 rollback。
- 聚焦测试。

新增表若没有运行时读写、所有者和测试，Schema Gate 应失败。禁止先批量建表再等待未来功能接入。

### 7.4 未完成能力不得伪装成功

- Generation 未调用真实生成器时，不得创建 `completed` candidate。
- Assist 没有 assistant response 时，不得把 Turn 标记为 `completed`。
- Quality Review 没有真实人工或模型评价时，不得默认 100 分。
- Outcome 没有绑定 Evidence 时，不得判定 requirement passed。
- 外部集成只保存配置元数据时，不得标记为 integration available。

未完成接口应通过 capability gate 或明确状态暴露，而不是返回模拟成功结果。

## 8. 功能状态和完成标准

Catalog 状态应统一为：

```text
planned -> scaffolded -> implemented -> verified -> released
```

### 8.1 `scaffolded`

- 可以有 schema、类型和接口草案。
- 正式能力列表不得将其显示为可用。

### 8.2 `implemented`

必须同时具备：

- 真实领域行为。
- 持久化读写和约束。
- V3 API/Command/Query。
- 稳定事件或 operation receipt。
- 主要 UI 工作流。
- 正常、失败、并发和恢复测试。
- 无旧 runtime 依赖。

### 8.3 `verified`

在 `implemented` 基础上还必须具备：

- 集成测试。
- 三视口浏览器验证，或真实 Runner/GitHub/Bridge 外部探针。
- Evidence manifest 和原始测试输出。
- Secret、越权和错误注入检查。

### 8.4 `released`

在 `verified` 基础上还必须具备：

- 临时卷发布演练。
- 备份和恢复 hash 一致。
- 可执行 rollback。
- 正式 release receipt。

Catalog 状态应由可验证产物推导，不能只依赖人工编辑 JSON。

## 9. 恢复开发方式

### 9.1 先建立 V2.3 行为契约

每项迁移前提取：

- 输入和输出。
- 状态转换。
- 错误码和错误条件。
- 事件类型、顺序和 cursor 行为。
- 幂等和 revision 行为。
- 中断、重启和恢复行为。
- UI 操作序列和异常状态。

这些 characterization tests 是迁移标准。V3 新测试必须证明行为达到目标，而不是只证明当前简化实现内部一致。

### 9.2 每次只恢复一个纵向闭环

固定批次结构：

```text
Schema
-> Repository
-> Domain
-> Command/Query
-> API/Event
-> UI
-> Unit/Integration/E2E
-> Evidence
-> Rollback
```

任何层缺失时，该功能保持 `planned` 或 `scaffolded`。

### 9.3 双端行为对照

对同一组净化 fixture，分别运行 V2.3 行为源和 V3 迁移实现，对比：

- 最终业务状态。
- 关键中间状态。
- 错误分类。
- 事件序列。
- 生成资产和 hash。
- UI 可执行工作流。

允许 V3 API 和内部数据模型不同，但用户行为、恢复能力和业务结果不能缩水。

## 10. 自动治理门禁

CI 至少加入以下检查：

1. `domain.mjs`、`http.mjs` 和 `pages.tsx` 不再继续承接新领域逻辑。
2. 禁止新增旧 API alias 和版本后缀 runtime 文件。
3. Raw SQL、Docker CLI、外部网络和 Secret 访问必须位于指定边界。
4. 检测模块循环依赖和跨领域 repository 写入。
5. 检测只有 schema、没有业务引用的新增表。
6. Catalog 的 `implemented` 必须关联真实行为测试、UI 测试和 Evidence。
7. 每个 mutation 检查幂等或 `expected_revision`。
8. 每个长任务检查 operation receipt、event cursor 和恢复测试。
9. 每个外部集成检查 probe、timeout、retry、credential redaction 和 cleanup。
10. 每个恢复批次检查 patch、测试原始输出和可执行 rollback。

## 11. 建议执行顺序

在继续恢复用户功能前，先完成一个架构稳定批次：

1. 将错误标记的 `implemented` 降级到真实状态。
2. 固定领域模块、依赖方向、表所有权和外部 adapter 边界。
3. 拆分 `domain.mjs`、`http.mjs` 和 `pages.tsx`，保持现有真实行为不变。
4. 建立 V2.3 characterization suite 和行为差异报告。
5. 删除或隔离固定返回值、默认满分和立即完成等占位成功逻辑。
6. 按依赖顺序恢复功能：

```text
Identity/Setup/Provider
-> Project/Intake/Brief/Workflow
-> Workflow Generation/Assist
-> Context/Files/Approval
-> Execution/Outcome/Evidence/Quality
-> Repository/GitHub App/Delivery
-> 完整前端和运维闭环
```

## 12. 最终原则

> V3 只保留一个当前实现，兼容放在边界，历史留在 Git；表、路由、事件和页面必须有明确领域所有者；功能迁移以 V2.3 可执行行为为标准；没有真实行为、失败恢复和验证证据就不算完成。

这个原则同时保留 V2.3 的产品成熟度和 V3 的可信执行基础，是避免 V3 再次积累版本副本、共享状态、兼容层和虚假完成状态的核心约束。
