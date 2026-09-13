# V3-Clean 分阶段开发计划

状态：P1-P8 Evidence 已验证；P8 Delivery/Deployment/Importer/Operations 已按
`D-037` 完成最终门禁；P9 Web/Offline/Release 已按 `D-038` 完成最终门禁并固定以
`423a7b4ca199ff2f11cbef1758802cdad22af8e0` 为唯一基线；P7 Evidence/Quality/Parser/Outcome 已按
`D-036` 和 forward-only `007-evidence-quality-parser-outcome` 完成最终门禁。
Evidence、Quality、Outcome 和 Attachments 为 `verified`，Clean/Historical
Catalog 为 `27/0/27`；27 行均由 P9 final release receipt 推进为 `released`。
P9 published receipt 为 `run-1787933538303`，`status=verified` 且
`provisional=false`。
P9 active phase 与 schema version 解耦，schema 保持 v8、ledger
保持 `[1..8]`，不新增 migration。P7 固定基线：
`af8fcaf2f5df7a0667a7f31c5784afbdc9a48ceb`；最终 receipt 为
`docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/verification.json`。
规范来源：同目录下的 `v3-clean-break.md`、`clean-schema.md`、
`api-v2-contract.md`、`import-contract.md`、`v23-capability-matrix.md` 和
`decision-log.md`。
责任人：工程负责人；每个阶段由对应领域 owner 对行为、数据、权限、测试
和 Evidence 共同负责。

本计划只定义如何实施 V3-Clean。当前分支已经存在的 V6/R6 代码、旧
migration、旧数据库和旧 Evidence 是行为/迁移 fixture，不因本计划而成为
clean runtime 的启动依赖。

## 1. 目标与当前基线

### 1.1 目标

最终系统只有一个 V3-Clean runtime：

```text
HTTP/API v2 + SSE/JSON replay + MCP HTTP/stdio/Gateway
                         ->
                 Command/Query Registry
                         ->
                    Domain Services
                         ->
             Canonical Repository + one transaction
                         ->
        Runner / Parser / GitHub / Bridge / CAS adapters
                         ->
             clean SQLite + CAS + immutable receipts
```

目标必须同时恢复 V2.3 的业务面和 V3 的执行隔离、CAS、审计、回滚能力。所有
表、Command、Event、权限判断和 aggregate head 只有一个 owner；所有长任务
共享 `operations`、`events`、cursor 和 CAS 模型。

### 1.2 已确认基线

| 项目 | 当前事实 | 对实施的含义 |
| --- | --- | --- |
| 架构决策 | 6 份 clean-break 规范已落盘 | 代码实现必须先对照规范和决策日志 |
| 当前运行时 | V6/R6 代码仍在工作树中 | 作为只读 fixture；不能直接延伸为 clean runtime |
| 当前 Catalog | 27 项；部分项只有 scaffold/Evidence | 状态必须由新行为、UI、集成和 Evidence 推导 |
| V2.3 输入 | 14 个 L0-L7 catalog 项、历史 route/schema/UI | 作为 characterization 和 importer 输入 |
| API | 目标固定为 `/api/v2` | 不保留 `/api/v1` 兼容路由 |
| 数据 | clean schema family 从 `user_version=1` 开始 | V1-V6 migration 只供离线 importer/历史证据使用 |
| 切换 | 离线一次性 cutover | 不做双写、共享写卷或长期双运行 |

### 1.3 非目标

- 不在阶段中逐步开放旧 API、旧 session 分支或兼容 flag；
- 不把旧表逐张复制成新表后宣称完成，所有迁移必须有语义映射和验证；
- 不把 parser 输出直接当成人工质量结论；
- 不把 Gateway 做成业务数据库或 Docker 控制面；
- 不在没有 receipt 的情况下手工提升 Catalog 状态；
- P0 文档阶段不改源码、schema、测试或 Catalog；P1-P9 实施阶段按本计划
  的 gate synchronization contract 同步修改这些工件。

## 2. 工作单元与完成定义

### 2.1 能力闭环

每个能力以一条可追踪闭环交付，而不是以文件数量交付：

```text
V2.3 行为 fixture
  -> capability matrix row
  -> clean schema/API/Command/Event
  -> domain service + repository + adapter
  -> UI/MCP surface
  -> unit + integration + security + UI test
  -> Evidence + rollback receipt
  -> Catalog 状态推导
```

矩阵行必须包含 API、Command、Event、表、状态机、UI、外部依赖、测试、
Evidence 和权限边界。跨域写入只能经过 domain service 或显式 repository
接口。

### 2.2 状态门槛

| 状态 | 必须存在 | 不足时的处理 |
| --- | --- | --- |
| `planned` | 矩阵行、依赖和验收定义 | 只允许设计和 fixture 分析 |
| `scaffolded` | schema/contract/interface | 不得对外宣称可用 |
| `implemented` | domain 行为、适用 UI、行为测试和 Evidence | 缺一项保持 scaffolded |
| `verified` | 集成测试或独立外部 probe receipt | 记录实际命令、输入、输出、退出码 |
| `released` | 临时卷发布、健康探针和实际 rollback receipt | 只能在切换门禁中提升 |

### 2.3 每个阶段的固定工件

每个阶段目录必须留下：

1. 修改后的 artifact（schema、代码、UI 或配置）；
2. patch/diff、schema diff 或 import mapping；
3. verification record，包含 baseline/modified 命令、输入、字面输出和
   退出状态；
4. runnable rollback receipt；
5. 更新后的 capability matrix 行和 Evidence 索引。

阶段失败时，失败 artifact 保留但不可挂载为生产；修复后从 checkpoint 或
   新批次继续，不覆盖失败报告。

### 2.4 门禁同步契约

测试计划不是独立工件。下列稳定规则与根目录 `AGENTS.md`、`docs/testing.md`、
package/CI 命令、门禁实现、Catalog、能力矩阵和 Evidence 构成同一个跨阶段契约。

| ID | Requirement |
| --- | --- |
| GS-001 | A change to tests, gate commands, routes, schemas, ownership, phase scope, status rules, or receipt shapes MUST trigger gate-sync review. |
| GS-002 | The phase plan, testing policy, package/CI commands, gate implementation, tests, Catalog/matrix, and Evidence references MUST update atomically. |
| GS-003 | Every governed inventory MUST be bidirectional and MUST reject missing, stale, duplicate, and orphan entries. |
| GS-004 | Every Git-visible non-build path MUST be classified; every new governance file MUST declare an owner and phase and be registered in the Catalog. |
| GS-005 | Only final verified, non-provisional receipts MAY promote status; failed and checkpoint receipts remain immutable. |
| GS-006 | Rollback verification MUST include a runnable dry-run and an isolated actual apply with byte-exact comparison. |
| GS-007 | Any gate failure MUST freeze the affected Catalog status and block dependent phases. |

P1 的同步命令清单固定为：

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm test:p1
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm verify
```

门禁实现必须从 package script 清单双向核对上述命令；新增、删除或改名都要在
同一变更中更新三份规则文档、测试、Catalog/矩阵和 Evidence。当前 P1
gate-contract receipt 为
`docs/evidence/v3-clean-p1-gate-contract-complete-20260819/verification.json`。

## 3. 阶段总览

| 阶段 | 名称 | 依赖 | 主要产出 | 退出凭证 |
| --- | --- | --- | --- | --- |
| P0 | 文档、治理和行为基线 | 无 | 规范、索引、V2.3 characterization 清单 | architecture/document gate |
| P1 | Clean baseline、API v2 和平台内核 | P0 | 新 schema family、registry、operations/events/CAS、错误 envelope | clean-start receipt |
| P2 | Identity、Team、Actor、Credential 和 ACL | P1 | 会话、成员关系、项目权限、rebind 流程 | identity/ACL isolation receipt |
| P3 | Project、Brief、Repository、Workflow、Generation、Critic | P1/P2 | 项目入口到可审查工作流草案 | project/workflow golden |
| P4 | Context、Projection、Pack、MCP、Exchange、Gateway | P2/P3 | 受权限约束的上下文和工具边界 | context/MCP parity receipt |
| P5 | Assist、Files、Attachments、Approval、Terminal、Bridge | P2/P4 | 人机协作和本地执行交互 | Assist/Bridge replay receipt |
| P6 | Runner、七阶段 Execution、Checkpoint、Replay | P3/P4/P5 | 可暂停、恢复、重试的执行链 | runner/restart receipt |
| P7 | CAS、Evidence、Trace、Quality、Parser、Outcome | P4/P6 | 证据链、全格式解析和人工裁决 | quality/CAS tamper receipt |
| P8 | Delivery、Deployment、Backup/Restore、Importer、Operations | P2-P7 | 外部交付、离线导入和部署回滚 | import/cutover/rollback receipt |
| P9 | Web 完整闭环、移动/Offline、发布 | P1-P8 | 全视口产品流程和 release gate | release promotion receipt |

P1-P7 是业务依赖顺序；P8 的 importer 只能在所有目标域模型冻结后实现。Web
组件可以在各阶段做薄 UI 骨架，但 P9 才能把跨域流程、Offline、Gateway 管理
和运维视图作为完整能力验收。

## 4. P0：文档、治理和行为基线（已完成）

### 目标

锁定 clean-break 决策、V2.3 L0-L7 能力矩阵、clean schema、API v2、import
contract、决策日志和文档索引，防止实现过程中重新引入兼容模式。

### 工作项

- 从 V2.3 commit、route registry、schema、UI 和 catalog 生成净化行为输入；
- 为当前 27 个 Catalog 条目和 V2.3 14 个 L0-L7 条目建立双向矩阵行；
- 标记当前代码中的旧 API、旧 migration、shadow head、second operation
  model 和 parser exclusion；
- 建立架构扫描、preflight、receipt 和 rollback 的固定格式；
- 将失效代码文档归档，并把活动入口统一到 `docs/document-index.md`。

### 退出条件

- `27/27` 当前 Catalog、`14/14` V2.3 Catalog 和 L0-L7 全覆盖；
- 文档之间没有 API、schema family、parser 范围或 import 策略矛盾；
- 归档文件不再被活动 README 或代码契约链接；
- 架构 gate 命令和失败解释已写入 receipt。

## 5. P1：Clean baseline、API v2 和平台内核

### 目标

先建立不依赖旧 runtime 的空库、事务和公共边界。后续领域只能使用这一套
operation/event/CAS/authorization 基础设施。

### 数据与迁移

- 建立 `v3-clean` family marker，`PRAGMA user_version=1` 的 clean baseline；
- 定义 `schema_meta`、`schema_migrations`、`actors`、`aggregate_heads`、`aggregate_revisions`、`operations`、
  `operation_links`、`events`、`event_cursors`、`idempotency_keys`、
  `audit_events`、`cas_objects` 和 `receipt_manifests`；
- 每次 migration 记录 checksum、snapshot、foreign-key check 和 rollback；
- 空库重复启动、半成事务重启、checksum 漂移和 DDL 回滚必须可验证；
- 启动遇到历史 family 时只产生 importer request receipt，并拒绝业务流量。

### API、Command 和 Event

- 实现统一 success/error redacted envelope、request id、idempotency 和
  expected revision 校验；
- 从 registry 生成/校验 REST `/api/v2`、MCP binding 和 query metadata；
- 实现 operation receipt、`202` 长任务、稳定 error code、分页和 download
  receipt；
- 实现同一 `events` 表支持 SSE `Last-Event-ID` 和 JSON replay；
- 历史 `/api/v1` 地址返回明确 retired-route 结果或不注册，不做 facade。

### 测试与凭证

- clean empty DB、重复启动、事务原子性、CAS canonical hash、redaction；
- route/command/MCP parity、unknown field、missing idempotency/revision、
  cursor reconnect；
- 运行 architecture scan，确保没有旧 runtime import、compat flag、
  `assist_operations` 或第二 head model。

### 退出条件

有一份可从空目录启动的 clean baseline receipt；所有基础表一 owner；API v2
contract probe 与 SSE/JSON replay 等价；失败 migration 和 rollback 均有字面
输出；P2 只能在该 receipt 通过后开始。

## 6. P2：Identity、Team、Actor、Credential 和 ACL

决策：D-029。P1 `001-clean-baseline` 和
`docs/evidence/v3-clean-p1-gate-contract-complete-20260819/` 保持不可变；P2
只通过 forward-only `002-identity-acl` 把 clean volume 从 `user_version=1`
升级到 `2`。

### 目标

恢复 V2.3 多主体能力，把同一个授权谓词接入 HTTP、MCP、Importer、Replay、
Evidence 和 Gateway。

### 领域范围

- `actors`、`teams`、`team_memberships`、`sessions`、`project_memberships`、
  `project_invitations`、`project_acl_entries` 的 clean 实体和 revision；
- `exchange_grants` 由 Exchange/MCP owner 负责写入，P2 Identity 只读并缩小
  已有权限；P3 前用注入的 `ProjectScopeResolver` 验证项目引用；
- owner/admin/member/observer 等角色和项目 scope；
- session 只保存 hash、expiry、revoke 和 revision；
- credential/profile 只保存 provider、scope、revision、external reference、
  probe 状态和 `rebind_required`；
- Codex/GitHub/MCP/session secret 重新绑定或轮换，不导入旧密文；
- ACL decision、team membership 和 exchange narrowing 的统一 predicate。

### API、UI 和适配器

- `/api/v2/actors`、`/teams`、`/projects/{id}/members`、`/permissions`、
  `/sessions`、`/credentials`、`/profiles`；
- actor switch、邀请、grant/revoke、credential rebind 和 probe 都返回
  operation/audit receipt；
- Web 提供 Team/Member/Credential/Scope 管理的 loading、empty、denied 和
  rebind-required 状态；
- Gateway 只验证签名、scope 和 project allowlist，业务写入仍回到 API；P2
  使用确定性 denial fixture，不宣称独立 Gateway 已实现。

### 验收

- 不同 team/project 的读写、MCP、Evidence、Replay 和 importer 查询隔离；
- stale membership/ACL revision 返回 `revision_conflict`；
- secret/token/cookie 不出现在 DB、event、audit、error、CAS 或 Evidence；
- restart 后 session revoke、credential rebind 状态正确恢复；
- 形成 identity/ACL isolation、credential rebind 和 Gateway denial receipt。

### P2 固定门禁和 Evidence

```text
pnpm check
pnpm scan:clean
pnpm test:p2
pnpm test:p1
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration
pnpm test:security
pnpm verify
git diff --check
```

P2 Evidence 固定为
`docs/evidence/v3-clean-p2-identity-acl-20260819/`，并包含 schema
diff/snapshot、owner/route/authorization inventory、isolation/rebind/Gateway
denial receipts、modified artifact、patch、literal verification output 和
可执行 rollback。Rollback 封存 P2 DB/CAS/Vault 后恢复 P1 artifact/volume；
验证必须在隔离副本实际 apply 并逐字节比较，不能运行 down migration。

### P2 execution receipt

`docs/evidence/v3-clean-p2-identity-acl-20260819/manifest.json` 和
`verification.json` 均为 `verified`，`provisional=false`；10 个固定命令、
P2/P1/Web/全量 integration/security 验收均通过。Rollback dry-run 和隔离
副本 actual apply 通过，`byte_exact_mismatches=0`；Evidence 路径、凭据和
主机路径扫描均为零命中。P2 的 fake-provider、组件级 Web 和 Gateway denial
边界按既定非目标保持在 `implemented`/`scaffolded`，真实 provider、独立
Gateway、完整 Web 发布与 P3 Project/Workflow 仍由后续阶段承接。

## 7. P3：Project、Brief、Repository、Workflow、Generation、Critic

### 目标

恢复从项目入口到可执行、可审查 Workflow Draft 的业务链，不提前运行未验收的
Runner。

### 领域顺序

1. 通过 forward-only `003-project-workflow` 支持空库 `0 -> 3`、P1
   `1 -> 3` 和 P2 `2 -> 3`，不改 `001`/`002`，不提供 down migration；
2. Project draft/intake、owner/team/统一 ACL 和 archive/restore lifecycle；
3. Brief revision、confirm/preview/template、canonical CAS hash；
4. Repository Connection/Target/Line、只读 source、managed workspace、
   single-writer lock/fencing、fault/recovery；
5. Workstream/Task 两级 DAG、Node Contract、proposal before/after/hash；
6. Generation operation、候选版本、critic 独立决策和 stale/retry/cancel；
7. Outcome requirement 只记录目标和验收规则，不伪造评分结果。

### Owner 与边界

- Project 独占 `projects`、`project_intakes`、`briefs`、`brief_revisions` 和
  requirement-only `outcome_requirements`；
- Repository 独占 connection/target/line/workspace/lock；Workflow 独占
  workflow/revision/node/contract/generation/proposal；Critic 独占 immutable
  critic receipt；
- 所有 owner 复用 P1 generic operations/events/CAS/aggregate heads 和 P2
  `authorize()`，不得创建影子 ledger/head；
- repository/generator/critic 使用 deterministic fake adapter；真实 GitHub、
  Codex、Gateway、Runner 和 Outcome evaluation 不属于 P3 状态声明；
- P1/P2 Evidence 和 migrations 是只读输入，P3 Evidence 使用独立目录和卷。

### 交付面

- 所有 mutation 使用 API v2 command registry、idempotency 和 expected revision；
- 事件包含 aggregate revision、operation link、actor/project scope 和
  redacted payload hash；
- Repository adapter 负责 HTTPS、local allowlist、Git bundle、source drift；
- P3 adapter 以 fixture probe 覆盖 source revision/hash、generator candidate
  和 critic decision；真实 provider receipt 延后；
- Web 组件切片支持 loading、empty、denied、revision conflict、source drift/
  retry、intake、Brief confirm、repository、workflow、proposal 和 critic 状态，
  且所有请求只使用 `/api/v2`；完整多视口/offline/跨域 E2E 延后到 P9；
- V2.3 project/workflow golden 与 clean domain service 逐项对照。

### 退出条件

项目可在没有 Runner 的情况下完成 Draft → Brief → Workflow → Critic 的
可审查闭环；重复提交幂等，旧 revision 被拒，repository source drift 可恢复；
generation 不再同步返回固定节点；project/workflow golden、UI receipt 和
security scope receipt 均通过。Migration 覆盖 DDL/ledger/receipt/commit 故障、
checksum/snapshot 漂移、重复启动和中断恢复；generation/intake restart 在无法
确认外部结果时保守落为 failed/retryable。最终执行 P3 command inventory，
并对 rollback 做 dry-run、隔离 actual apply 和逐字节比对。

### P3 固定门禁和 Evidence

```text
pnpm check
pnpm scan:clean
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm evidence:p3
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration
pnpm test:security
pnpm verify
git diff --check
```

### P3 execution receipt

`docs/evidence/v3-clean-p3-project-workflow-20260819/manifest.json` 和
`verification.json` 均为 `verified`，`provisional=false`。空库、P1 和 P2
卷均完成 `001 -> 002 -> 003`，migration/DDL/ledger/receipt/commit fault、
checksum/snapshot drift、lifecycle/CAS、restart、跨项目隔离和 deterministic
fixture adapter probes 均通过。P3 receipt 当时验证 `apps/api/server.mjs`
以 `targetVersion=3` 启动，并由
`tests/p3/active-entrypoint.test.mjs` 与 `tests/p3/http-contract.test.mjs`
验证 `/readyz`、API v2、retired route 和 session/ACL 边界。隔离副本执行 rollback dry-run 与 actual apply，
`byte_exact_mismatches=[]`；failure checkpoint 保存在独立的
`docs/evidence/v3-clean-p3-project-workflow-20260819-failed-baseline/`，不属于
最终批次。P3 只提升 Project、Workflow、Generation 和 Repository 四行；Outcome
评分/waiver、真实 provider、完整 Web 发布和 P9 E2E 仍保持原状态。

## 8. P3.1：Clean debt burn-down（D-031、D-032）

### 目标与边界

P3.1 是 forward-only 的代码、入口、门禁、Catalog 和 Evidence 整理阶段，
不创建新业务表、migration 或 API 版本。P1/P2/P3 migration 与已验证
Evidence 只读；P4 以后 runtime、真实 provider、完整 Outcome evaluation、
release Web/E2E 仍不在本阶段。

### 领域 owner 与统一账本

- `ProjectWorkflowService` 继续是 HTTP/runtime facade，并把 Project、
  Repository、Workflow、Outcome 责任转发到各自 owner；`IdentityService`
  同样转发 Actor、Session、TeamAccess、CredentialProfile。
- 所有 owner 共享同一 `db/events/operations/authorization` 实例；
  `OperationService.createInTransaction/linkInTransaction/receiptFromRow`
  和 `EventService.appendAggregateInTransaction` 是唯一账本入口。
- 状态更新、operation、aggregate revision、event/head、audit 和
  idempotency response 保持一个事务；外部 fixture adapter 在事务外执行，
  不确定结果保留 `failed/retryable`。

### Clean Web、E2E 与分层门禁

默认 Web 导航只挂载 Setup、Identity、Projects、Workflow，所有请求走
`/api/v2`，Setup 通过 HttpOnly cookie 接收 session proof。`scripts/e2e.mjs`
启动 Clean API 与临时 Vite proxy，覆盖 setup/cookie、project/intake/brief/
workflow/generation、ACL denial、replay 和 mobile/laptop/desktop 三视口；
`scripts/e2e-legacy.mjs` 仅由 `fixture:legacy:e2e` 显式调用。

`test:integration`/`test:security` 是 Clean + historical 分层 wrapper：
Clean 失败阻断并返回非零，历史失败写入 advisory receipt（含命令、退出码、
摘要和 redaction 结果）但不提升 Clean 状态。`verify` 的阻断顺序固定为：

历史 R5 source-hash replay 由 `fixture:legacy:integration` 显式执行；`pnpm test`
只按名称跳过该断言，并继续执行其余 unit 与 Clean Web tests。package script
总数保持 42。

D-032 further fixes the publication boundary: a fully successful wrapper emits
only `aiws.v3-clean.layered-gate-result.v2` with `receipt: null`; a Clean or
Historical failure appends its complete redacted output to the ignored local
`.ai-workspace/gate-receipts/` directory using a timestamp/PID filename and
exclusive creation. The local diagnostic receipt is never a Catalog promotion
input; promotion still requires the immutable final `verification.json`.

```text
check -> audit:p1 -> scan:clean -> test:p1 -> test:p2 -> test:p3 -> test:p31
  -> test -> test:integration -> test:security -> build -> test:e2e
  -> git diff --check
```

### Catalog 与 Evidence

`feature-catalog.index.json` 引用 disjoint 的
`feature-catalog.clean.json`（P3.1 receipt 固定九个 Clean id）和
`feature-catalog.historical.json`（其余 fixture id）；P4 在最终 receipt 后
原子迁移四行而不改变总数；根
`feature-catalog.json` 保留 P1 兼容聚合并携带同一引用。`scripts/catalog-loader.mjs`
拒绝缺失、重复、stale、orphan 的 id、矩阵覆盖、owner/test/Evidence 路径，
以及把 historical status 当作 Clean 可用的解释。

P3.1 formal Evidence 目录为
`docs/evidence/v3-clean-p3-1-debt-burn-down-20260820/`。每次运行写入
`attempts/<run-id>/`，failed/checkpoint receipt 不覆盖；final
`verification.json`/`manifest.json` 独占创建。必须提供 preflight、原始/修改
hash、artifact、patch、verification、manifest、rollback、service/route
inventory、catalog diff、gate/advisory/secret scan。rollback 先 dry-run，
再在隔离副本 apply，并输出 `byte_exact_mismatches=[]`。

门禁收据卫生 Evidence 为
`docs/evidence/v3-clean-p3-1-gate-receipt-hygiene-20260820/`；它记录源码
patch、四份历史成功收据迁移的 SHA-256、验证输出和隔离回滚，不改变 P1/P2/P3
Evidence 或 P1 兼容 Catalog。

### P3.1 退出条件

- `tests/p31/`、Clean Web tests、Clean integration/security gates 和三视口
  E2E 通过，活动请求计数中 `/api/v1=0`；
- Clean/Historical Catalog 双向覆盖、workspace classification 和 gate-sync
  通过；历史失败只保留可见 advisory receipt；
- final P3.1 receipt 为 verified、非 provisional，rollback dry-run 与隔离
  actual apply 均有字面输出和退出码；P3 四行状态保持原值，Frontend 仍为
  `scaffolded`，不宣称 release。

## 9. P4：Context、Projection、Pack、MCP、Exchange、Gateway

### 目标与边界

D-033 以 `3f1d9e7` 为基线，用 forward-only
`004-context-projection-mcp` 把活动 schema 升至 `user_version=4`。P4 只交付
Context/Projection/Pack、MCP/Exchange、独立 Gateway 和对应 Clean Web slice；
真实 Codex/GitHub、Assist、Runner、Parser、Outcome evaluation、Offline、完整
Gateway 运维和 release workflow 留在 P5-P9。

### Schema、owner 与 projection

- Context 独占 source/node/document version/edge/policy/selection/pack；Projection
  独占 job/index snapshot；MCP 独占 client；Exchange 独占 request/grant；Gateway
  独占 forwarding receipt。Policy 历史写 generic `aggregate_revisions`，projection
  event 只写 generic `events`，不创建 domain head/event ledger。
- Project、Brief、Repository、Workflow、Node Contract 和 Note adapter 生成稳定
  URI、版本、contains/reference edge；正文和 MiniSearch serialization 写 Clean
  CAS。Secret 在排序和索引前排除，allowlist/freshness/sensitivity/ACL 在检索前
  统一过滤。
- Worker 以 lease、revision 和 fencing token 发布；最终事务重检输入 hash、CAS、
  lease 和 revision。漂移、cycle、tamper 或 lease 丢失不发布部分结果；retry 新建
  job/operation 并保留 lineage，cancel/retry 均做 revision CAS。
- Selection 固定按 pinned、score、type、stable URI/id 排序，token budget 为
  256-128000。`aiws.context_pack.v5` 的 CAS payload 固化 selection snapshot；公共
  envelope 只返回 hash/revision/manifest 元数据，mandatory evidence 缺失返回
  `evidence_incomplete`。

### Transport、Exchange 与 Gateway

`CleanCommandDispatcher` 是 REST、MCP Streamable HTTP、MCP stdio 和 Gateway 的
唯一 handler inventory；MCP protocol 固定 `2025-06-18`。Client token 仅创建时
返回一次，SQLite 只保存 peppered HMAC、prefix、expiry、actor、project/tool
allowlist 和 revision。Exchange 采用
`requested -> partially_approved -> active -> revoked|expired`，source/target 双侧
批准后才创建 grant；grant 只收窄现有 ACL，Pack 仍由 Context owner 创建。

`apps/gateway` 是独立无状态进程，只负责 HTTP forward、stdio bridge、签名和
health；它不导入 SQLite、CAS/domain repository，不访问 Docker。API 校验
HMAC-SHA256(method/path/timestamp/nonce/canonical-body-hash)、60 秒时钟偏差和
nonce replay，再重检 client/grant/project/tool scope。Receipt 只保留 command、
request/response hash、decision、operation link 和时间。

### Web、门禁与 Evidence

默认 Clean Web 增加 Context Map/history/policy/selection/Pack 和 MCP/Exchange
controls；`scripts/e2e.mjs` 覆盖 390x844、1024x768、1440x900，要求无 overlap、
overflow、console/page error 且 `/api/v1=0`。P4 固定门禁为：

其中 `pnpm test` 排除只读 R5 source-hash replay；该断言在现有
`fixture:legacy:integration` Historical advisory 层执行，不参与 Clean 状态提升。

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
node scripts/v3-clean-p4-performance.mjs
node scripts/v3-clean-p4-gateway-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
pnpm verify
pnpm evidence:p4
git diff --check
```

Formal Evidence 位于
`docs/evidence/v3-clean-p4-context-mcp-20260820/`，包含 preflight、原始/修改
hash、binary patch、schema/owner/route/parity inventory、migration、1000-node
performance、独立 Gateway probe、browser、secret scan、verification、manifest
和 runnable rollback。Rollback 不执行 down migration；它 reverse-check 源码
patch，在隔离目录恢复 v3 SQLite/CAS 快照并验证 `user_version=3`、FK、migration
ledger 和四份 artifact，最终输出 `byte_exact_mismatches=[]`。
SQLite integrity probe 只打开系统临时目录中的 snapshot 字节副本并在 `finally`
清理 WAL/SHM；Evidence snapshot 与恢复目标只参与 hash 比较。
Catalog gate 对 final manifest 与顶层 Evidence 文件做双向 SHA-256 校验，拒绝
missing、hash mismatch 和 WAL/SHM 等 orphan 文件。
普通 rerun 不得覆盖 verified final；显式纠错 `--supersede` 必须先把旧顶层
Evidence 原字节归档到 `attempts/superseded-final-<run-id>-*`，并在新
verification/manifest 写入 `supersedes_run_id`。

最终非 provisional receipt 统一提升 `REC-D4-MCP-004`、
`REC-D4-SCOPE-016`、`REC-D9-CONTEXT-017` 和
`REC-D9-PROJECTION-018`。Clean/Historical 数量为 13/14，总数保持 27；Frontend
和 Outcome 仍为 `scaffolded`，P5 只在上述四行和 final receipt 一致后解锁。

## 10. P5：Assist、Files、Attachments、Approval、Terminal、Bridge

### 目标

恢复完整的人机协作面，同时严格使用 generic `operations` 和 `events`；Assist
不能重新创建独立 operation ledger。

### 领域范围

- Assist session/turn/message/goal/plan/assistant response/tool call/reasoning
  的状态机和 operation link；
- files、attachments、CAS preview/download、change batch、diff review；
- runtime approval、user input、pause/await/resume；
- Terminal PTY capability、cursor replay、write lock、redaction；
- Windows Bridge pairing、DPAPI、ConPTY、Git bundle 往返和 revoke；
- 四层 Assist 行为（规划、工具、文件/diff、执行反馈）和失败恢复。

P5 使用 `005-assist-files-terminal-bridge` 将活动 schema 升至
`user_version=5`。Assist adapter 协商 app-server v2 schema hash，session 固定
scope/Brief/Workflow/Repository/Context Pack/Profile/Credential revision；
数据库只保留 provider opaque ids，assembled prompt 和 credential lease 只在调用
内存中存在。Terminal 的 `terminal_events` 只投影 generic `events` 与 CAS chunk，
canonical cursor/head 仍由共享服务维护。Windows Bridge 是独立 loopback 进程，
不加载 SQLite、Clean CAS 或 Docker API；pairing 使用 Ed25519/X25519/HKDF/AES-GCM，
请求使用 timestamp/nonce/body-hash HMAC。

### 验收

- 没有 assistant response、工具结果或完整事件链时，Turn 不得标记 completed；
- attachment/path/scope/size 校验和 preview 均不能泄露绝对路径或 secret；
- approval/user-input/terminal/bridge 的 stale revision、cancel、resume、
  reconnect 和 replay 具备集成测试；
- Windows Bridge 通过独立外部 probe，Docker socket 仍只在 Broker；
- Assist 外部 probe 必须把 credential 作为可清零 Buffer 注入隔离
  `CODEX_HOME`，实际完成固定回复契约的最小 turn，并收到连续事件、assistant item、
  全部 terminal tool result 和 `turn/completed`；缺凭据或缺任一项只生成
  provisional candidate；
- Assist/Files/Approval/Terminal/Connections UI、mobile layout、event cursor 和
  Evidence receipt 全部关联矩阵行；活动 Web 请求中的 `/api/v1` 计数为零。

P5 固定验收清单：

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
pnpm test:p5
node scripts/v3-clean-p5-performance.mjs
node scripts/v3-clean-p5-assist-probe.mjs
node scripts/v3-clean-p5-bridge-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
pnpm verify
pnpm evidence:p5
git diff --check
```

P5 Evidence 记录 schema/owner/route/protocol inventory、migration、真实
app-server/Windows Bridge probe、性能、browser、secret scan、四角色工件和
rollback。Rollback 在隔离目录恢复 v4 SQLite/CAS/Vault/workspace/Bridge fixture
snapshot，并验证 `1,2,3,4`、`user_version=4`、FK 空集和
`byte_exact_mismatches=[]`。最终 receipt 为 `verified` 且
`provisional=false` 时才原子迁移六个 D8 条目；Assist/Files/Approval/Terminal/
Bridge 晋级 `verified`，Attachments 晋级 `implemented`，Clean/Historical 为
`19/8`，Frontend/Outcome 保持 `scaffolded`。
Final Evidence is immutable after publication: the regular `verify` gate uses
the read-only `pnpm evidence:p5 -- --verify` check, which also reopens the
Assist probe and rejects skipped/provisional model turns, while a corrective receipt
must use the explicit `--supersede` path.

## 11. P6：Runner、七阶段 Execution、Checkpoint、Replay

### 目标

以 verified P5 `54381746da0f01fd60da2e11ed247f2ed2f11c8b`
为固定基线，把 Workflow/Context/Assist 接入签名 Runner，并实现可恢复的七阶段
执行：`prepare -> context -> run -> check -> review -> finalize -> deliver`。

### Schema、所有权和状态机

`006-runner-execution-checkpoint-replay` 将 `0/1/2/3/4/5` forward-only
升级到 `user_version=6`。Runner 独占 `runner_profiles`、`job_specs`、
`runner_receipts`；Execution 独占 `executions`、`execution_inputs`、
`task_attempts`、`execution_stage_checkpoints`、`execution_events`。最后一张表
只是一对一 generic-event 投影；operation、event、cursor、aggregate head 和 CAS
仍各只有一个 canonical owner。Job Spec、receipt、execution input、terminal
attempt 和 checkpoint 均由 trigger 保持不可变；checkpoint 唯一键包含 execution、
generation 和 stage。

Execution 状态固定为 `draft -> queued -> running -> pause_requested |
awaiting_approval -> paused -> running -> completed | failed | cancelled`。
Attempt 状态固定为 `pending -> ready -> leased -> running -> succeeded | failed |
cancelled | expired | external_result_unknown`。每个阶段先在一个事务中创建
operation/checkpoint/event/head，再执行外部动作，并用第二个 revision-checked
事务提交结果。

### 阶段、调度和恢复

- `prepare` 固定 Brief、Workflow、Repository、Context Pack、input refs 和 Runner
  profile revision/hash；`context` 生成受限 CAS staging；
- `run` 按稳定拓扑顺序调度，read 并行度最多 4，write 串行；`check` 只运行
  allowlisted check id；
- `review` 复用 P5 Approval owner；`finalize` 校验全部 attempt/receipt/checkpoint；
  `deliver` 只生成 delivery-ready handoff manifest，不创建 PR；
- pause 停止新调度并在安全边界释放 lease；resume 重新校验 workspace 和 pins；
  replan 创建带 lineage 的新 execution；stage replay 在原 execution 中增加
  generation 并保留旧 checkpoint 字节；
- restart 查询 Docker label、Host process 或 Bridge job。terminal receipt 正常提交，
  running job 续租，未知结果记录 `external_result_unknown` 并暂停 execution。

每个 execution 最多 100 tasks、500 dependency edges；每 task 最多 3 attempts，
仅已知 transient failure 按 1 秒、4 秒退避。deadline 上限 15 分钟，输入/输出
路径各 64 个，Context Pack 512 KiB，redacted stdout/stderr 合计 2 MiB，输出文件
合计 10 MiB。`light` 固定为 1 CPU/1 GiB/256 pids/256 MiB tmpfs，`standard`
固定为 2 CPU/4 GiB/512 pids/1 GiB tmpfs。

### Runner、Broker 和协议

- immutable signed Job Spec、固定 image digest、runner profile、独立
  `CODEX_HOME`、temporary credential 和 capability allowlist；
- Docker Broker、Host Runner、Windows Bridge 各自返回统一 runner receipt；
- canonical contract 为 `runner.job-spec.v2` 和 `runner.receipt.v2`。Job Spec 只含
  opaque refs、revision/hash、digest、deadline、capabilities 和相对路径，由 Clean
  Vault Ed25519 service key 签名；Broker/Bridge 用各自 Ed25519 identity 签 receipt；
- 传输另用 timestamp/nonce/body-hash HMAC。Docker 固定 digest、drop all
  capabilities、read-only root、no-new-privileges、受限 tmpfs/mount/network；Host
  使用独立 `CODEX_HOME`、受管 workspace 和完整 process-tree cleanup；Bridge
  提供 submit/status/cancel 且只保存 DPAPI lease、nonce journal 和本地进程状态；
- 历史 `apps/runner-broker/server.mjs` 只作 fixture；`dev:broker` 指向不导入历史
  contract/API 的 `clean-server.mjs`。API 不接触 Docker socket，只调用 adapter；
- write attempt 在 disposable task workspace 中运行，成功后由 Repository owner
  和 fencing lease 合并，中断恢复最近 checkpoint hash。

### Public API 与 Web

Runner registry 固定 6 条命令：profile list/create/get/update/probe/disable。
Execution registry 固定 12 条命令：list/create/get/events/attempts/checkpoints、
start/pause/resume/cancel/replan/stage replay。Create 返回 201，长任务返回 202，
query 返回 200；mutation 要求 Idempotency-Key 和 registry 指定的 expected
revision。Profile mutation/probe 仅 REST/Web，profile read 和全部 Execution
保持 REST/Web/MCP/Gateway 双向登记。

默认 Web 导航加入 Execution；页面展示 execution list、七阶段 rail、task/
attempt、checkpoint/event 与 pause/resume/cancel/replan/replay。Connections 加入
Runner Profiles，展示 Docker/Host/Bridge readiness、digest、capabilities、limits、
probe 和 disable。Clean E2E 覆盖 approval wait/resume、deliver generation 2 replay、
cursor/duplicate/partial event 处理，以及 390x844、1024x768、1440x900 无重叠和
无横向溢出。

### 验收

- migration 覆盖 `0..5 -> 6`、drift、重复启动和 DDL/ledger/receipt/commit fault；
- execution 覆盖 DAG cycle/missing dependency、稳定调度、pause/resume/cancel、
  approval、replan、任意阶段 replay、stale revision/pins 和 restart；
- Runner 覆盖签名/digest/path/deadline/capability tamper、nonce replay、quota、
  SIGTERM/kill、credential zeroization、CAS/output tamper 和三 adapter parity；
- performance 门槛为 1000-event replay p95 <=200 ms、100-task planning p95
  <=150 ms、100-attempt detail p95 <=200 ms、replay validation p95 <=500 ms；
- 最终 Evidence 位于
  `docs/evidence/v3-clean-p6-runner-execution-20260824/`，含 schema/owner/route/
  protocol/Catalog inventory、migration、四类 probe、performance/browser/secret
  scan、四角色工件和 runnable rollback。isolated apply 必须恢复 v5 SQLite/CAS/
  Vault/workspace/Broker/Bridge，确认 ledger `[1,2,3,4,5]`、FK 空集、八张 P6 表
  缺席和 `byte_exact_mismatches=[]`；
- 仅 final `verified`、`provisional=false` receipt 把 Runner/Execution 晋级
  `verified`，Catalog 为 `21/6/27`；Frontend/Outcome 保持 `scaffolded`。

## 12. P7：CAS、Evidence、Trace、Quality、Parser、Outcome

### 目标

建立从执行产物到人工质量裁决和 Outcome 的可信证据链，纳入所有 parser 格式，
包括音视频、PPTX 和通用压缩包。

### Schema 与所有权

- 活动 schema 升到 `user_version=7`，migration 覆盖 `0..6 -> 7`；P1-P6
  migration 与 Evidence 保持只读；
- Parser 独占 `parser_formats/parser_runs`；Evidence 独占 `assets/asset_versions/
  asset_blobs/asset_relations/asset_attestations/traces/digests/code_changes/
  test_results`；Quality 独占 `quality_review_runs/reports/events/human_reviews`；
  Outcome 独占 `outcome_evaluations/outcome_waivers`；
- `outcome_requirements` 继续由 Project 管理，`cas_objects` 继续由 CAS 管理；
  P7 不建立第二套 operation/event/cursor/head/CAS；
- asset version/blob/relation/attestation、report、human review、Outcome
  evaluation/waiver 和 terminal parser run 均不可变；retry 只追加 lineage。

### Evidence 与 Parser

- generic `event_cursors` 消费 `execution.completed`，重验 generation、handoff、
  workspace checkpoint 和 Runner receipt，从受管相对输出、Attachment、File
  Ref、test/check receipt 生成 asset、trace、digest、code change 和 test result；
- 外部解析分 enqueue 与 receipt 两个事务；receipt 在 CAS 提交前验证签名、
  nonce、manifest/hash、quota、secret scan、input/format/limits/image/checkpoint
  pins；逻辑删除只写 tombstone，物理 GC 留给 P8；
- Clean Broker 提供 `/internal/v2/parser-jobs` submit/status/cancel，API 只调用
  adapter。Docker worker 使用固定 digest 的 Node 24 image 和 `parser.job.v1`、
  `parser.receipt.v1`、`evidence.asset.v2`；
- 21 个注册格式覆盖 text/Markdown/JSON/CSV/XML/SVG、PDF、DOCX、XLSX、PPTX、
  PNG/JPEG/WebP/GIF、audio/video、ZIP/TAR/GZIP/7Z/RAR。worker 依赖固定为
  `officeparser@7.8.0`、`pdfjs-dist@6.1.200`、`csv-parse@7.0.2`、
  `saxes@6.0.0`、`@napi-rs/canvas@1.0.8`、`libarchive.js@2.0.2`、
  `ffmpeg-static@5.3.0` 和 `ffprobe-static@3.1.0`；
- 配额固定为 25 MiB input、100 MiB expanded、1024 entries、递归 3 层、
  压缩比 1000、240000 字符、20 images、500 PDF pages、500 slides、100000
  cells、15 分钟 media、120 秒 deadline；拒绝加密包、links、path traversal、
  external entities 和 media signature mismatch；
- parser 状态为 `queued -> running -> parsed|unsupported|invalid|
  resource_exceeded|failed|cancelled|external_result_unknown`，最多三次 attempt；
  只有已知 transient failure 使用 1 秒、4 秒 backoff，未知外部结果不自动重放。

### Quality、Outcome 与 Web

- rubric 为 1-20 dimensions，enabled weight 合计 100，threshold 默认 80；每个
  run 最多 16 assets。自动 report 只包含确定性检查和非权威建议；
- 人工 decision 必须提交全部逐维分数、理由、精确 report/input/rubric hash、
  active session proof 和 project approval；parser 不生成 human verdict；
- Outcome evaluator 固定为 `evidence_count/test_pass/digest_match/human_score`，
  派生 `passed/completed_with_gaps/waived/blocked`；Evidence、rubric、execution
  input、human decision、waiver/revoke/expiry 变化均追加 evaluation generation；
- Web 默认导航增加 Evidence；项目 asset view 展示 version、lineage、
  attestation、parser status 和受限 preview。Execution 增加 Evidence、Quality、
  Outcome tabs，以及 start/cancel/retry、逐维评分、waiver/revoke 和 stale/tamper/
  resource-exceeded/reconnect/duplicate/partial-event 状态；所有请求只用 `/api/v2`。

### 验收与 Evidence

- `test:p7` 覆盖 migration fault、immutable/CAS、ACL/revision/idempotency、格式
  正例与坏输入、quota/timeout/tamper/cancel/retry/restart、Quality/Outcome replay；
- performance 门槛为 1000-event Evidence replay p95 <=200 ms、100-asset lineage
  p95 <=200 ms、16-asset/500-anchor Quality detail p95 <=300 ms、100-requirement
  Outcome evaluation p95 <=200 ms；真实格式解析 latency 仅记录；
- parser image 必须用 `docker build --provenance=false --target parser-worker`
  连续构建两次且 image ID 一致；缺少 Docker/dependency 或 provisional probe
  只保留 candidate，不晋级 Catalog；
- 最终 Evidence 位于
  `docs/evidence/v3-clean-p7-evidence-quality-outcome-20260824/`，含 schema/owner/
  route/protocol/format/Catalog inventory、migration、五类 probe、performance/
  browser/secret scan、四角色工件和 runnable rollback；
- isolated apply 恢复 v6 SQLite/CAS/Vault/workspace/Broker/Bridge/parser，确认
  `user_version=6`、ledger `[1,2,3,4,5,6]`、FK 空集、17 张 P7 表缺席和
  `byte_exact_mismatches=[]`；
- 仅 final `verified`、`provisional=false` receipt 把 Evidence/Quality 从
  Historical 移入 Clean，并把 Evidence、Quality、Outcome、Attachments 晋级
  `verified`，Catalog 为 `23/4/27`；Frontend 保持 `scaffolded`。

## 13. P8：Delivery、Deployment、Backup/Restore、Importer、Operations

### 目标

完成外部交付和一次性数据导入，把所有业务域放入 clean 卷后再切换，不把
importer 混入 API runtime。

### Delivery 与运维

- GitHub App/Installation、repo discovery、Webhook HMAC/dedup、PR Intent、
  Delivery Policy、Draft PR、merge recovery 和 baseline synchronization；
- Deployment candidate/verification、browser/viewport evidence、health gate；
- backup/restore/reset、operations list/cancel/replay、receipt retention；
- temporary volume、SBOM、image/source identity 和 deployment rollback。

### Importer 实施顺序

1. `inspect`：V2.3 schema 23、当前 V3 schema 7、CAS、Context Index、附件和
   release manifest 的只读完整性；
2. `dry-run`：实体计数、ID mapping、引用翻译、语义冲突、credential rebind；
3. `run`：按 dependency order 写临时 clean DB/CAS，并在每个 domain 后 fsync
   checkpoint；
4. `resume`：校验 source/plan/mapping/target hash，只重放未完成 domain；
5. `verify`：row/relation/head/event/ACL/CAS/golden/secret 全检查；
6. `cutover`：通过 operator approval、health probe 后原子切换；
7. `rollback`：恢复旧部署 artifact，目标卷保持 sealed，不恢复旧 API/runtime。

### 退出条件

- 两个输入源均通过 byte-level manifest 和 schema fingerprint；
- dry-run 可重复，零未决语义冲突，所有字段/引用都有显式结果；
- 每个 domain 边界注入中断后 resume 一致；
- verify、cutover 和实际 rollback 均有字面输出和退出状态；
- 生产卷只含 clean schema/CAS，旧卷只读保存为 rollback artifact。

## 14. P9：Web 完整闭环、移动/Offline、SSE reconnect、发布

### 目标

让 Web、MCP 管理和运维视图消费同一 API/Command contract，完成跨阶段用户流程，
并以三视口和离线重连证据作为发布门槛。

固定基线为 `423a7b4ca199ff2f11cbef1758802cdad22af8e0`。P9 runtime
phase 为 9，但 schema 必须继续是 `user_version=8` 和 ledger `[1..8]`。
开发 origin 固定为 `http://127.0.0.1:5174`，release 使用动态 loopback
origin；不触碰生产卷或生产 pointer。

### 工作项

- Web router、query cache、mutation/idempotency、operation center、error/empty/
  loading/manual-input 状态；
- Project → Brief → Workflow → Context → Assist → Execution → Evidence →
  Outcome → Delivery 全链路；
- Team/ACL/Exchange/Gateway/Runner/Parser/Operations 管理界面；
- desktop/tablet/mobile（至少 1440x900、1024x768、390x844）布局和无障碍；
- Offline queue、cursor replay、SSE reconnect、duplicate event 和 stale UI；
- 浏览器 console/layout overlap、下载 receipt、CAS preview 和 redacted error。
- Operations owner 增加 project-scoped JSON/SSE replay；事件携带
  `previous_project_sequence`，SSE 在事件与 heartbeat 时重新授权；
- IndexedDB v1 只保存 cursor/outbox。离线 allowlist 固定为
  `project.update`、`brief.create`、`workflow.revise`、
  `context.selection.create`、`assist.goal.update` 和
  `outcome.requirement.create`，且同 aggregate FIFO、跨 aggregate 并发上限 3；
- Service Worker 使用 injectManifest，只 precache app shell；API/SSE/CAS/
  download/health/ready 一律 NetworkOnly。

### 发布门禁

- `pnpm check`、`pnpm test`、`pnpm test:integration`、`pnpm test:security`、
  `pnpm test:e2e`、`pnpm test:release`、`pnpm verify` 全部通过；
- Catalog 每项达到 `released` 所需 Evidence，而不是仅 schema/接口存在；
- 临时卷发布、健康探针、备份恢复 hash 和实际 rollback 通过；
- 三视口截图、SSE reconnect、offline 和人工输入场景无错误/重叠；
- 外部 Codex、GitHub、Gateway、Runner、Bridge、parser probe 按要求有新 receipt。
- formal Evidence 固定写入
  `docs/evidence/v3-clean-p9-web-release-20260826/`，rollback 必须恢复 P8
  schema v8、ledger `[1..8]`、pointer 和九类组件快照并报告
  `byte_exact_mismatches=[]`；
- 只有 final `verified`、`provisional=false` receipt 可把 Catalog 提升到
  `27/0/27`，否则保持 P8 `26/1/27`。

## 15. 跨阶段测试矩阵

| 测试层 | 重点 | 触发阶段 |
| --- | --- | --- |
| Architecture gate | 旧符号、旧 import、第二 operation/head、owner 唯一性 | 全阶段 |
| Schema/migration | clean empty DB、checksum、FK、snapshot、rollback、CAS | P1、P8 |
| Contract | API v2 envelope、idempotency、revision、MCP/REST parity | P1-P9 |
| Domain | 状态机、事务原子性、ACL、redaction、canonical hash | P2-P8 |
| Integration | restart、operation、event replay、adapter recovery、golden journey | P2-P9 |
| Security | secret/path/token、Docker boundary、scope、Gateway、parser sandbox | P1-P9 |
| UI/browser | loading/empty/error/manual input、三视口、offline、a11y | P3-P9 |
| Performance | 1000 events、1000 context nodes、多文件 parser、并发 operation | P4-P9 |
| Release | temp volume、SBOM、cutover、health、backup/restore、实际 rollback | P8-P9 |

任何层失败都保持对应 Catalog 状态，不允许用后续阶段的文件存在替代缺失
行为证据。

## 16. 依赖、并行和停止规则

### 依赖图

```text
P0 -> P1 -> P2 -> P3 -> P4 -> P5 -> P6 -> P7 -> P8 -> P9
              \----------------------> P8 importer ------------------/
```

UI 骨架、fixture 准备、parser characterization 和外部 probe 可以在依赖满足
后并行，但不能写入尚未冻结的业务表或绕过 owner。Importer 不能与生产 API
并行写入，P9 不能把 scaffold 状态包装成 release。

### 停止条件

出现以下任一情况，停止当前阶段并回到决策日志：

- 需要保留 `/api/v1`、旧 session、compatibility flag 或双写才能继续；
- 一个表、Command、Event 或权限判断出现两个 owner；
- 语义冲突被提议静默选择来源；
- receipt 缺少字面命令、输入、输出或退出状态；
- secret、token、完整 prompt 或宿主绝对路径进入公共 envelope/Evidence；
- 测试只证明 schema 存在，没有证明用户行为和失败恢复。

## 17. 首批实现任务（P1 backlog）

代码阶段开始后，按以下顺序拆成独立小提交；本轮不执行这些任务：

1. 建立 `v3-clean` schema family marker 和空库 migration harness；
2. 建立 `operations/events/event_cursors/aggregate_heads` 事务 API；
3. 建立 API v2 envelope、request metadata、route/query/command registry；
4. 实现 startup family/checksum/FK/CAS gate 和 historical-schema importer receipt；
5. 写 clean baseline、rollback、route parity、redaction 和 replay 测试；
6. 更新 capability matrix 的 P1 行并生成第一份 clean-start Evidence；
7. 只有 P1 exit receipt 通过后，开始 P2 Identity/Team/Actor/ACL。

每个小提交都要遵循根目录 `AGENTS.md` 的 preflight，并在提交前更新本计划
对应的阶段状态和 Evidence 路径。

## 18. 变更控制

任何对阶段顺序、API、schema、import mapping、权限或 parser 范围的提议，必须：

1. 在 `decision-log.md` 建立新决策 id；
2. 更新受影响的 capability matrix 行；
3. 提供 schema diff、API/MCP 影响、测试和 rollback 影响；
4. 通过文档一致性和 architecture gate；
5. 才能进入代码实现。

本计划是执行顺序的唯一入口；旧的恢复计划仅保留在归档目录作为历史材料。

## 19. P1 execution receipt

The first platform slice is implemented under `apps/api/src/clean/` and is
bootstrapped only by `apps/api/server.mjs`; `apps/api/clean-server.mjs` is an
internal HTTP composition module, not a second process entry. It owns the clean baseline,
generic operations/events/cursors, registry-backed API v2 probes, redaction,
and the local CAS. The historical server and migration modules remain fixture
inputs and are not imported by this clean entry.

Superseding receipt directory: `docs/evidence/v3-clean-p1-gate-contract-complete-20260819/`.

| Capability | Receipt/test | Status |
| --- | --- | --- |
| 001-clean-baseline, family/checksum/FK/WAL | `schema-snapshot.json`, `tests/p1/clean-platform.test.mjs` | verified |
| operation state machine and atomic head/event/audit | `golden-receipt.json`, `tests/p1/clean-platform.test.mjs` | verified |
| API v2 envelope, retired route, JSON/SSE replay | `route-inventory.json`, `tests/p1/clean-platform.test.mjs` | verified |
| canonical CAS, tamper and redaction receipts | `cas-manifest.json`, `tests/p1/clean-platform.test.mjs` | verified |
| global active/deferred surface, all-path classification and final Evidence synchronization | `workspace-audit.json`, `workspace-scope-inventory.json`, `tests/p1/workspace-sync.test.mjs` | verified |

P2 was gated on the receipt above. The rollback and architecture checks were
re-run on an isolated destination volume and passed; the immutable P1 receipt
remains the parent input for P2.

## P8 fixed baseline and gate

P8 固定基线 is `4ee1a436b2f810354602308d733fbee7423f3cf0`. Migration `008-delivery-deployment-importer-operations` advances the runtime to v8. Acceptance adds `test:p8`, five P8 probes, blocking release tests, and `evidence:p8`. Rollback runs against an isolated copy and must report `restored_user_version=7`, ledger `[1..7]`, no P8 tables, and `byte_exact_mismatches=[]`. GitHub and Docker absence produces a provisional candidate and freezes Catalog promotion.

The published P8 receipt `run-1787846480106` passes the full local gates,
real isolated GitHub delivery, Docker deployment, and actual seven-component
rollback with `status=verified` and `provisional=false`. Catalog is
`26/1/27`. P9 must start only from the pushed P8 final boundary; schema
remains v8 when that boundary is reached.

The synchronized additive P8 gate is the 51-script inventory in `AGENTS.md`
and `docs/testing.md`. Its P8-specific additions are:

```text
pnpm test:p8
node scripts/v3-clean-p8-performance.mjs
node scripts/v3-clean-p8-github-delivery-probe.mjs
node scripts/v3-clean-p8-importer-probe.mjs
node scripts/v3-clean-p8-deployment-rollback-probe.mjs
node scripts/v3-clean-p8-backup-restore-gc-probe.mjs
pnpm evidence:p8
```

## 20. P10 final business parity and governance closure

Decision D-039 activates P10 over the pushed P9 boundary
`bb55746b7e08cf7ee764d06a8fa23da91ad48e2f`. P10 is the final governance
phase: runtime phase 10, schema v9, and migration ledger `[1..9]`. It is the
last phase allowed to change governance, schema ownership, route inventories,
status rules, or Evidence shapes. Later work is product feature development and
performance optimization and must continue `audit:parity` and `pnpm verify`
without introducing another governance phase.

### P10 work packages

- Freeze the V2.3 source commit `e18dc0b616fa7ab2b00a6c05db23890ccd940175`
  with Git blob hashes for 14 L0-L7 cases, 360 routes, 98 collections, 11 Web
  routes, and seven optimization packages.
- Map every input exactly once to 19 business groups using only `equivalent`,
  `consolidated`, `retired_interface`, or `fixture_only`; final `gap` and
  `retired_business` entries fail the gate.
- Apply `009-final-business-parity-governance` and retain shared Operations,
  Event, aggregate-head, CAS, cursor, ACL, session-proof, Vault, and redaction
  owners.
- Complete Provider lifecycle, Brief template snapshots, Project and
  Repository deletion intents, Assist lifecycle/review, Quality policy/
  selection/advice/history, cross-platform archive worker, and parameterized
  Web workflows.
- Advance parser registrations to `node24-p10` at fixed digest
  `sha256:3c2c0f8f550f4c8a14c33661f1e4e85227aa02e3bd0844a8e1044ed368d202a0`;
  rebuild it twice and run 21 valid container samples plus hostile archives and
  the Windows-host wrapper.
- Verify temporary-volume release, dynamic loopback origin, backup/restore,
  isolated pointer switch, and actual P9 rollback. Production cutover and
  production volumes remain excluded.

### P10 gate inventory

```text
pnpm check
pnpm audit:p1
pnpm scan:clean
pnpm audit:parity
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact -- --audit
pnpm test:p1
pnpm test:p2
pnpm test:p3
pnpm test:p31
pnpm test:p4
pnpm test:p5
pnpm test:p6
pnpm test:p7
pnpm test:p8
pnpm test:p9
pnpm test:p10
node scripts/v3-clean-p10-parser-probe.mjs
node scripts/v3-clean-p10-github-deletion-probe.mjs
pnpm --filter @aiws/web test
pnpm test
pnpm test:integration:clean
pnpm test:security:clean
pnpm test:integration
pnpm test:security
pnpm build
pnpm test:e2e
node scripts/v3-clean-p10-release-probe.mjs
pnpm test:release
pnpm verify
pnpm evidence:p10 -- --verify
git diff --check
```

Formal Evidence is append-only at
`docs/evidence/v3-clean-p10-final-governance-20260829/`. A final receipt must
be verified and non-provisional, include complete parity mappings, external
probe records, three viewport receipts, all four workspace artifact roles, and
a runnable dry-run plus isolated actual rollback. Rollback restores P9 schema
v8, ledger `[1..8]`, all component snapshots, and
`byte_exact_mismatches=[]`; the Catalog remains `27/0/27`.

## 21. Post-P10 development reliability maintenance

Decision D-040 governs ordinary maintenance after final P10 closure. The fixed
baseline for this work is `5f2be38845d36236637c7f22a1b4df5611a6175b` on
`fix/aiws-post-p10-development-reliability`. Runtime phase 10, schema v9,
ledger `[1..9]`, `/api/v2`, and the `27 released / 0 historical` Catalog remain
fixed. DesignSignal product commit
`9f1ea086d5ab101fb453701df4199d6a2ca9f793` and Draft PR #2 are read-only while
the platform work is in progress.

The maintenance packages are:

1. prove every R5 fixture source from immutable raw Git blobs, report current
   drift without weakening checksum/privacy/six-contract behavior replay, and
   retain the existing fixture bytes;
2. replace Windows `shell:true` Gate scheduling with one process executor that
   owns Corepack/Pnpm resolution, argument arrays, redacted bounded capture,
   timing, stable errors, and process-tree timeout cleanup;
3. add Catalog-driven `verify:dev` and optimize formal `verify` by removing
   prior-phase live probes/fallbacks, duplicate Web/layered work, and duplicate
   Docker boundary builds; independent local validation commands run as one
   bounded parallel wave while the current P10 release probe retains the real
   production-image boundary check;
4. add the read-only `development:receipt` projection over existing v9 tables,
   with no runtime write, schema, route, or UI surface;
5. synchronize D-040, testing policy, package commands, Catalog/matrix rows,
   tests, and independent maintenance Evidence;
6. after platform acceptance, run a new isolated DesignSignal Round 2 project
   with its own SQLite, CAS, Vault, workspace, Broker, and Docker volume, using
   stage replay rather than a replacement full execution for stage failures.

The development Gate target is `<=120000 ms`; the formal Gate target is
`<=360000 ms` on the workstation that recorded `549714 ms`. A missing external
credential may keep the DesignSignal Live layer provisional, but platform
acceptance is determined by the Workflow/Execution/Checkpoint/Evidence/Outcome/
Draft-Delivery chain, R5 result, Shell diagnostics, and development receipt.

The maintenance delivery is append-only under
`docs/evidence/post-p10-development-reliability-20260905/` and contains
`modified-artifact.tgz`, `change.patch`, `verification.json`, and
`rollback.ps1`. Rollback must first dry-run and then apply in an isolated clone
and state copy, restore code to `5f2be38845d36236637c7f22a1b4df5611a6175b`,
retain schema v9/ledger `[1..9]`, and report `byte_exact_mismatches=[]` for
SQLite, CAS, Vault, workspace, Catalog, and P10 Evidence.

### 21.1 Provider boundary hardening

Owner: Workflow. Phase: post-P10 D-040 maintenance. The generator accepts only
a complete JSON document, permits at most one provider repair, and checks
ordinary task check/acceptance arrays without coercion or local filling.
The registered real-development-loop tests are additive; API v2, schema v9,
the existing command inventory and Catalog status are unchanged. GS-001 through
GS-007 review reuses existing Catalog test/Evidence references and keeps new
diagnostics outside formal Evidence. Protected Critic and Gate changes are
reviewed and committed separately from this generator correction.

### 21.2 Critic corrective gate-sync review

Owner: Workflow/Critic. Phase: post-P10 D-040. GS-001 through GS-007 require
bidirectional requirement/task and task/check receipts, strict row types,
duplicate/orphan/stale rejection, immutable provider mappings and preservation
of rejected status. Missing mappings produce rejection, never inferred rows.
The registered real-development-loop suite covers these cases and proves that
its assertions reach the independent provider-Critic branch. Existing commands,
Catalog entries and formal Evidence references remain unchanged.
