# V3 功能恢复开发计划

## 总体策略

- 当前 V3 是唯一运行时底座；V2.3 提交 `e18dc0b` 仅提供只读行为契约、领域算法、状态机和交互参考。
- 恢复顺序固定为：治理与迁移底座、身份配置、项目入口、Workflow、Context/MCP、Assist、Execution/Evidence、Delivery、发布。
- Broker 隔离、签名 Job Spec、Runner digest、CAS/SHA、Managed Worktree、幂等和 Draft PR 安全链不得退化。
- Catalog 进度只使用 `planned -> scaffolded -> implemented -> verified -> released`，状态由测试、Evidence 和 release receipt 推导。
- 音视频、PPTX 和通用压缩包自动解析保持排除，不进入完成率。

## 公共架构与契约

- 公共 API 固定为 `/api/v1`；健康探针只使用 `/health` 和 `/readyz`。创建 mutation 强制 `Idempotency-Key`，更新和动作同时强制 `expected_revision`。
- 长任务返回 `202` operation receipt，包含 `operation_id`、`status`、`resource_id` 和起始 `cursor`；事件通过持久 cursor 重放。
- 依赖方向固定为 `HTTP -> Command/Query -> Domain Service -> Repository/Adapter`。SQL、GitHub、Secret、文件和 Runner 分别进入专用边界。
- `domain.mjs`、`http.mjs` 和 `pages.tsx` 冻结 R0 行数上限，只允许抽取；新实现进入 `modules/<domain>` 和 `features/<domain>`。
- migration 只向前执行。升级前生成 SQLite 快照和 SHA-256 manifest；代码回滚使用旧提交，数据回滚使用旧镜像和迁移前快照。
- V2.3 characterization 在隔离只读 worktree 运行并输出净化 golden；CI 只让 V3 对 golden 验证，不加载旧 Runtime。

## R0：恢复真相与治理

- R0a：拆分混合 Catalog 项，Terminal 与 Windows Bridge 独立计数；按五态重算状态。
- R0b：登记模块依赖、表唯一所有者、Command 和 Event 所有者。
- R0c：检查冻结单体增长、Raw SQL 边界、跨域写入、模块环、占位成功、旧 Runtime 和未映射变更。
- 验收：`recovery:plan/catalog/coverage/impact --audit` 通过；达到 `implemented` 的条目可定位行为测试、UI 测试和 Evidence。

## R1：Migration、模块骨架与行为金标准

- 建立 `schema_migrations(version,name,checksum,applied_at,duration_ms)`。
- 当前 v1 数据库必须通过 schema fingerprint 后才登记 baseline；空库按版本顺序执行 migration；checksum 漂移直接停止启动。
- 升级前创建一致性快照和 manifest，提供 hash 校验恢复入口。
- 验收覆盖空库、v1 baseline、重复启动、checksum 冲突、DDL 事务回滚、异常进程退出和快照恢复；现有 API、Broker、Terminal、CAS 和 Delivery 契约保持一致。

## R2：Identity、Setup、Credential 与 Provider

- 定向迁移 Vault、Codex Device Auth、发现/导入、Profile Probe 和 GitHub App 服务。
- 闭合 `users/sessions/setup_states/credential_refs/codex_profiles/github_app_configs/github_installations/config_revisions`。
- Setup UI 从空环境走到 ready；项目、执行和交付受 readiness 硬门禁；每个 Profile 使用独立 `CODEX_HOME`，Secret 扫描零泄漏。

## R3：Project、Brief 与 Repository Intake

- 恢复 Draft Project、Intake retry/cancel/resume、Brief preview/confirm、Workflow Draft、Repository Connection/Target/Line 和 fault lifecycle。
- 覆盖只读外部源、Managed staging/checkout、archive/upload/trash/restore/purge。
- 重启后 revision、confirmed brief、baseline SHA 和故障状态必须保持。

## R4：两级 Workflow、Generation 与 Critic

- 固定 Workstream/Task 两层、依赖、Node Contract、输入输出、工具和验收标准，并持久化布局 revision 历史。
- Generation 为异步 operation，generator 与 critic 独立；支持 cancel/retry/apply/replan proposal；失败保留空白草案。
- Canvas 覆盖结构编辑、布局、Contract 和 critic 报告；循环、重复输出、路径冲突、stale revision 和 critic rejection 返回稳定错误。

## R5：Context Projection、Context Pack 与 MCP

- 恢复 Context tree、document version、edge、selection、policy、projection job、summary 和 scope request/grant。
- 提供 map/search/read/selection/policy/status/rebuild，以及 MCP client/tool/operation/scope；HTTP 与 stdio 共用 Command Registry。
- Context Pack v5 固定 document version、Selection v2、retrieval plan、Outcome/Rubric hash 和 Memory Manifest；worker 崩溃、索引损坏和 pending job 可恢复。

## R6：Assist、Files、Approval、Terminal 与 Windows Bridge

- 接入真实 Assist runtime：四层 scope snapshot、Goal/Plan、follow-up/steer/interrupt/resume/retry、原生 message/tool/command/file/diff/reasoning/input 事件和 SSE replay。
- 完成 Attachment、Monaco、controlled test、Change Batch、stale protection、Apply/Undo、Proposal、Approval/User Input 联动。
- Terminal 保留当前 PTY 能力；Windows Bridge 独立完成 pairing、DPAPI、ConPTY 和 Git bundle 往返，不与 Terminal 合并计数。

## R7：Execution、Evidence、Quality 与 Outcome

- 七阶段固定为 `preflight/execute/collect/verify/attest/promote/finalize`；checkpoint 记录输入输出 hash、运行身份、CAS 引用、失败分类和 replay 来源。
- 支持 readiness frontier、人工/PR checkpoint、pause/resume、确定性失败暂停和指定阶段重放。
- Asset、Blob、Attestation、Relation、Trace、Digest、CodeChange、TestResult 和浏览器 Evidence 全部进入 CAS。
- Quality worker 覆盖文本、Markdown、JSON、CSV、XML/SVG、PDF、DOCX、XLSX 和静态图片；人工语义评分门槛固定 80。Evidence 变化触发 Outcome 重评，waiver 支持 grant/revoke/expiry。

## R8：GitHub Delivery 与 Merge Recovery

- 项目分支固定 `aiws/projects/{project_id}`，交付分支固定 `aiws/deliveries/{delivery_id}`。
- 执行 PR Intent、patch SHA、tests/diff check、commit/push、幂等 Draft PR、Ready、expected head SHA merge、branch cleanup 和 local baseline sync。
- 429/502/timeout、head race、merge conflict、重复 Webhook、合并后清理失败都进入可恢复状态；使用现有 GitHub App 在空 fixture repository 完成闭环。

## R9：前端闭合、V2.3 导入、运维与发布

- 逐域抽空 `pages.tsx` 业务逻辑，补齐 Loading/Empty/Offline/Blocked/Failed/Human Input/Retry。
- 离线 importer 支持 dry-run、ID mapping、checkpoint、resume 和 hash report。
- 提供 `up/down/logs/status/verify/backup/restore/reset` 和 `/api/v1/system/deployment`。
- 三视口 `1440x900`、`1024x768`、`390x844` 全流程通过；临时镜像、临时卷和动态端口完成发布与回滚。

## 每个提交单元的固定闸门

1. 提取 V2.3 输入、状态转换、错误、事件顺序、并发和恢复 golden。
2. 同一提交单元完成 Schema、Repository、Domain、API/Event、UI 和聚焦测试。
3. 执行治理命令、聚焦测试、影响测试、`pnpm verify`，再执行浏览器或 Runner/GitHub/Bridge 探针。
4. Evidence 包含 `manifest.json`、`change.patch`、`verification.json`、原始输出、截图/CAS hash、`rollback.ps1` 和 `rollback.json`。
5. 在临时 worktree 执行真实 revert commit；涉及 migration 时同时恢复旧镜像和迁移前快照。
6. 聚焦测试通过标记 `implemented`；集成、外部探针和 Evidence 通过标记 `verified`；临时卷发布及回滚通过标记 `released`。

## 最终发布条件

- Catalog 所有非排除项达到 `released`，审计缺口全部闭合，Runtime 扫描没有 V2.3 依赖。
- `pnpm verify`、recovery unit/integration/security/E2E/performance/release、真实 Runner、GitHub 和 Bridge 都产生可核验 Evidence。
- 候选版本先在复制数据、临时卷和动态端口运行；最终验收后才停止正式 `4317`、生成最终快照并切换。
- 失败时按 receipt 停止新镜像，恢复旧镜像与原始快照，并验证数据库 hash、健康探针和基线用户行为。
