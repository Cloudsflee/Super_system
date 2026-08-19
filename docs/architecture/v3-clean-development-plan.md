# V3-Clean 分阶段开发计划

状态：实施规划，不是功能完成声明。
计划基线：`8edefc7`。
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
- 本文档阶段不改源码、schema、测试或 Catalog。

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
- 定义 `schema_meta`、`schema_migrations`、`aggregate_heads`、`operations`、
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

### 目标

恢复 V2.3 多主体能力，把同一个授权谓词接入 HTTP、MCP、Importer、Replay、
Evidence 和 Gateway。

### 领域范围

- `actors`、`teams`、`team_memberships`、`sessions`、`project_acl_entries`、
  `invitations`、`exchange_grants` 的 clean 实体和 revision；
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
- Gateway 只验证签名、scope 和 project allowlist，业务写入仍回到 API。

### 验收

- 不同 team/project 的读写、MCP、Evidence、Replay 和 importer 查询隔离；
- stale membership/ACL revision 返回 `revision_conflict`；
- secret/token/cookie 不出现在 DB、event、audit、error、CAS 或 Evidence；
- restart 后 session revoke、credential rebind 状态正确恢复；
- 形成 identity/ACL isolation、credential rebind 和 Gateway denial receipt。

## 7. P3：Project、Brief、Repository、Workflow、Generation、Critic

### 目标

恢复从项目入口到可执行、可审查 Workflow Draft 的业务链，不提前运行未验收的
Runner。

### 领域顺序

1. Project draft/intake、owner/team/ACL 和 lifecycle；
2. Brief revision、confirm/preview/template、CAS hash；
3. Repository Connection/Target/Line、只读 source、managed workspace、
   single-writer lock、fault/archive/restore；
4. Workstream/Task 两级 DAG、Node Contract、proposal before/after/hash；
5. Generation operation、候选版本、critic 独立决策和 stale/retry/cancel；
6. Outcome requirement 只记录目标和验收规则，不伪造评分结果。

### 交付面

- 所有 mutation 使用 API v2 command registry、idempotency 和 expected revision；
- 事件包含 aggregate revision、operation link、actor/project scope 和
  redacted payload hash；
- Repository adapter 负责 HTTPS、local allowlist、Git bundle、source drift；
- Web 支持 intake、Brief confirm、DAG canvas、proposal review 和 critic 状态；
- V2.3 project/workflow golden 与 clean domain service 逐项对照。

### 退出条件

项目可在没有 Runner 的情况下完成 Draft → Brief → Workflow → Critic 的
可审查闭环；重复提交幂等，旧 revision 被拒，repository source drift 可恢复；
generation 不再同步返回固定节点；project/workflow golden、UI receipt 和
security scope receipt 均通过。

## 8. P4：Context、Projection、Pack、MCP、Exchange、Gateway

### 目标

把项目上下文和工具能力接到统一 ACL、事件和 operation 模型，保证 projection
是可重建的派生物而不是第二个业务 head。

### 领域范围

- Context source/node/document version/edge、sensitivity、freshness、policy；
- projection job 的 lease、checkpoint、stale recovery、cancel/retry；
- deterministic selection、Context Pack hash、Memory Manifest、Outcome/Rubric
  hash 和 token budget；
- MCP client/tool/resource registry、health、HTTP/stdio transport；
- Exchange request/grant/revoke/expiry 和跨项目 scope narrowing；
- Gateway forwarding receipt、签名验证、destination ACL re-check、无业务持久化。

### 验收

- 1000 context nodes 的稳定排序、索引重建和 hash/tamper 检查；
- 同一 command 在 REST、MCP HTTP、stdio 和 Gateway 的 schema/result 等价；
- project ACL、sensitivity、grant expiry 和 source allowlist 全路径一致；
- SSE 断线后从 durable cursor replay，不重复或越权；
- Context/MCP parity、Gateway independent probe、security boundary 和性能
  receipt 通过。

## 9. P5：Assist、Files、Attachments、Approval、Terminal、Bridge

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

### 验收

- 没有 assistant response、工具结果或完整事件链时，Turn 不得标记 completed；
- attachment/path/scope/size 校验和 preview 均不能泄露绝对路径或 secret；
- approval/user-input/terminal/bridge 的 stale revision、cancel、resume、
  reconnect 和 replay 具备集成测试；
- Windows Bridge 通过独立外部 probe，Docker socket 仍只在 Broker；
- Assist UI、mobile layout、event cursor 和 Evidence receipt 全部关联矩阵行。

## 10. P6：Runner、七阶段 Execution、Checkpoint、Replay

### 目标

把已验收的 Workflow/Context/Assist 接入签名 Runner，并实现可恢复的七阶段
执行：`prepare -> context -> run -> check -> review -> finalize -> deliver`。

### 实施要点

- immutable signed Job Spec、固定 image digest、runner profile、独立
  `CODEX_HOME`、temporary credential 和 capability allowlist；
- Docker Broker、Host Runner、Windows Bridge 各自返回统一 runner receipt；
- execution pins Brief/workflow/repository/context/asset revisions；
- stage checkpoint、task attempt、lease、pause/resume/replan/replay；
- SIGTERM、Broker restart、unknown job、parser/runner timeout 都产生可重试
  operation 状态，不重写历史 event；
- 任务输出只存 redacted summary、hash、CAS reference 和 bounded metadata。

### 验收

- 任意阶段注入中断后可从最近 checkpoint 恢复；
- 同一 execution id/spec 重复提交幂等，spec drift 返回 conflict；
- stale execution/repository/context revision 被阻断；
- Docker/Host/Bridge 的安全边界、签名、digest、资源配额和 credential cleanup
  通过独立 probe；
- 形成 1000-event replay、restart/recovery、runner HTTP 和 real-runner receipt。

## 11. P7：CAS、Evidence、Trace、Quality、Parser、Outcome

### 目标

建立从执行产物到人工质量裁决和 Outcome 的可信证据链，纳入所有 parser 格式，
包括音视频、PPTX 和通用压缩包。

### 领域与 worker

- canonical CAS bytes、asset version、relation、attestation、trace、digest、
  code change、test result；
- parser format registry 和 isolated worker protocol，包含 quota、timeout、
  sandbox、checkpoint、retry、unsupported/invalid/resource_exceeded；
- Quality Review run/report/event、rubric、逐维人工评分、stale/waiver/revoke；
- parser 只生成 Evidence/asset，不能直接写人类 verdict；
- Outcome 根据 Evidence、Quality、policy 和 waiver 计算，任何证据变化触发
  重新评估。

### 验收

- 每种注册格式都有正例、坏输入、资源超限、重试和 CAS tamper case；
- DOCX/XLSX、PDF、图片、音视频、PPTX、压缩包均走同一 worker envelope；
- secret/path/prompt sentinel 扫描覆盖 parser 输出、CAS、event、audit；
- quality threshold、人工决策、waiver/revoke 和 outcome 联动可重放；
- 形成 CAS manifest、tamper、quality human-review、parser isolation 和
  outcome golden receipt。

## 12. P8：Delivery、Deployment、Backup/Restore、Importer、Operations

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

1. `inspect`：V2.3 schema 23、当前 V3 schema 6、CAS、Context Index、附件和
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

## 13. P9：Web 完整闭环、移动/Offline、SSE reconnect、发布

### 目标

让 Web、MCP 管理和运维视图消费同一 API/Command contract，完成跨阶段用户流程，
并以三视口和离线重连证据作为发布门槛。

### 工作项

- Web router、query cache、mutation/idempotency、operation center、error/empty/
  loading/manual-input 状态；
- Project → Brief → Workflow → Context → Assist → Execution → Evidence →
  Outcome → Delivery 全链路；
- Team/ACL/Exchange/Gateway/Runner/Parser/Operations 管理界面；
- desktop/tablet/mobile（至少 1440x900、1024x768、390x844）布局和无障碍；
- Offline queue、cursor replay、SSE reconnect、duplicate event 和 stale UI；
- 浏览器 console/layout overlap、下载 receipt、CAS preview 和 redacted error。

### 发布门禁

- `pnpm check`、`pnpm test`、`pnpm test:integration`、`pnpm test:security`、
  `pnpm test:e2e`、`pnpm test:release`、`pnpm verify` 全部通过；
- Catalog 每项达到 `released` 所需 Evidence，而不是仅 schema/接口存在；
- 临时卷发布、健康探针、备份恢复 hash 和实际 rollback 通过；
- 三视口截图、SSE reconnect、offline 和人工输入场景无错误/重叠；
- 外部 Codex、GitHub、Gateway、Runner、Bridge、parser probe 按要求有新 receipt。

## 14. 跨阶段测试矩阵

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

## 15. 依赖、并行和停止规则

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

## 16. 首批实现任务（P1 backlog）

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

## 17. 变更控制

任何对阶段顺序、API、schema、import mapping、权限或 parser 范围的提议，必须：

1. 在 `decision-log.md` 建立新决策 id；
2. 更新受影响的 capability matrix 行；
3. 提供 schema diff、API/MCP 影响、测试和 rollback 影响；
4. 通过文档一致性和 architecture gate；
5. 才能进入代码实现。

本计划是执行顺序的唯一入口；旧的恢复计划仅保留在归档目录作为历史材料。
