# V3 功能恢复测试计划

## 状态与证据规则

- `planned`：只有行为来源和目标范围。
- `scaffolded`：存在 schema、contract 或接口，但 capability 不得显示 ready。
- `implemented`：真实领域行为、持久化、Command/API/Event、主要 UI、正常/失败/并发/恢复测试和 Evidence 全部存在。
- `verified`：增加集成或外部探针、三视口 UI（适用时）、Secret/错误注入检查和通过的 verification record。
- `released`：增加临时卷发布、备份恢复 hash、可执行 rollback 和通过的 release receipt。

## T0 治理

- `pnpm recovery:plan`：检查 R0-R9、领域覆盖、Terminal/Bridge 分离和计划完整性。
- `pnpm recovery:catalog`：检查五态、ID、模块依赖、表/Command/Event 唯一所有者、单体冻结、SQL 边界、循环依赖、占位成功和旧 Runtime。
- `pnpm recovery:coverage`：每项至少映射 T0-T8；达到 `implemented` 的项必须有行为测试、UI 测试（适用时）和 Evidence。
- `pnpm recovery:impact --audit`：读取 staged、unstaged 和 untracked 变更；未映射源码失败。

## T1 Schema、Migration 与回滚

- 空库顺序执行全部 migration，写入 `schema_migrations` checksum 和 `PRAGMA user_version`。
- 当前 v1 必须通过 fingerprint 才登记 baseline；schema 漂移、未知版本、history gap 和 checksum 冲突停止启动。
- 重复启动不重复 DDL或 ledger；DDL 失败在同一事务回滚；异常进程退出后未提交 DDL 不残留并可重放。
- 迁移前快照 manifest 固定版本、源路径、from/to version 和 SHA-256；恢复先校验 snapshot hash，恢复后数据库 hash 一致。
- V2.3 golden 只由 detached 临时 worktree 提取并确认源树前后无改动；CI 只用当前 V3 重放已净化 fixture，不导入旧 Runtime。
- 现有 SQLite foreign key、STRICT、WAL、FULL synchronous、FTS5 和 immutable trigger 保持。

## T2 Identity、Secret、Setup 与 Probe

- 覆盖 owner/session、创建/轮换/撤销/过期、Codex Device Auth、Profile 发现、独立 Probe、GitHub App 安装和 readiness gate。
- 凭据明文不得进入 SQLite、日志、SSE、HTTP error、Broker、CAS 或 Evidence。
- 覆盖空、损坏、model 不一致、超时、强制 Probe、JWT/token 权限失败、仓库发现和 webhook HMAC。

## T3 Runner、Broker 与 MCP

- 覆盖 Job Spec 白名单、digest、deadline、resource、network、HMAC 过期/重放、cancel/timeout/crash/retry 和临时凭据清理。
- Docker 与 Host Runner 都验证指定 Profile 和独立 `CODEX_HOME`。
- REST、HTTP MCP 和 stdio MCP 共用 Command Registry，并保持结果、幂等、scope、cursor 和 audit 等价。

## T4 Project、Workflow、Generation、DAG 与 Outcome

- 覆盖 Draft/Intake retry/cancel/resume、Brief preview/confirm、Repository line fault/recovery 和重启持久化。
- 覆盖 Workstream/Task、布局 revision、Node Contract、循环/反向依赖、重复输出、路径冲突和 revision race。
- Generation/critic 覆盖 cancel/retry/apply/replan、空白失败草案和 critic rejection；未接真实 generator 时必须显式失败。
- Outcome 只有绑定 Evidence 和评分时才能 passed；waiver 覆盖 grant/revoke/expiry 和 Evidence 变化后的重评。

## T5 Assist、Files、Attachment、Terminal、Approval 与 Bridge

- 覆盖四层 scope snapshot、Goal/Plan、assistant response、native events、follow-up/steer/interrupt/resume/retry 和 1000 cursor replay。
- Attachment 覆盖 MIME/SHA/配额/安全预览；Files 覆盖 Monaco 保存、Change Batch、stale protection、controlled test、Apply/Undo 和 Diff Review。
- Approval/User Input 与等待中的 Assist/Execution 相互恢复，Proposal 校验 before/after/hash。
- Terminal 覆盖真实 PTY、WebSocket reconnect、SIGINT、resize、stop、orphan recovery、跨 chunk 脱敏和 CAS artifact。
- Bridge 独立覆盖 pairing、DPAPI、RPC、ConPTY、Git bundle SHA/ref/path；不得用 API 进程内 PTY 代替 Bridge 验证。

## T6 Context、Evidence 与 Quality

- 覆盖 Context map/search/read/selection/policy/rebuild、1000 nodes、projection crash、索引损坏和 pending job 恢复。
- Context Pack v5 校验 document version、Selection v2、retrieval plan、Outcome/Rubric hash 和 Memory Manifest。
- 覆盖 Asset Candidate/Blob/Attestation/Relation/Trace/Digest/CodeChange/TestResult、capture retry/discard 和 secret-output rejection。
- parser isolation 覆盖文本、Markdown、JSON、CSV、XML/SVG、PDF、DOCX、XLSX 和静态图片；音视频、PPTX、压缩包返回稳定排除错误。
- 人工语义分数必须显式提供，门槛固定 80，不得默认满分。

## T7 Repository 与 GitHub Delivery

- 覆盖 Connection/Target/Line、只读外部源、Managed staging/checkout、单写锁、fault state 和 archive/trash/restore/purge。
- 覆盖项目/交付分支幂等、PR Intent、patch SHA、tests/diff check、Draft PR 去重、expected head SHA、Ready/Merge 和 baseline sync。
- 注入 429/502/timeout、head race、merge conflict、重复 Webhook、合并成功但清理失败；每种状态都可恢复。
- 真实 fixture 只使用预先创建的空仓库和现有 GitHub App。

## T8 Browser、性能、运维与发布

- 浏览器至少覆盖 `1440x900`、`1024x768`、`390x844`，检查 page/console error、布局重叠、离线和 SSE reconnect。
- 性能场景包括 1000 Context Nodes、1000 SSE replay、10 Execution、100 MCP read、大 Evidence 和多文件 Quality。
- importer 覆盖 dry-run、ID mapping、checkpoint、resume、输入不变 hash report 和中断恢复。
- `up/down/logs/status/verify/backup/restore/reset` 和 `/api/v1/system/deployment` 产生 receipt。
- 发布演练使用 digest-pinned image、临时卷、动态端口、复制数据和 hash restore；rollback 必须实际执行并验证基线行为。

## 固定执行顺序

```text
pnpm recovery:plan
pnpm recovery:catalog
pnpm recovery:coverage
pnpm recovery:impact --audit
pnpm check
pnpm test
pnpm test:integration
pnpm test:security
pnpm test:e2e
pnpm test:release
pnpm verify
```

任何命令失败时不得提升 Catalog 状态；真实 Runner、GitHub 或 Bridge capability 缺失时只记录 candidate，不进入 `released`。
