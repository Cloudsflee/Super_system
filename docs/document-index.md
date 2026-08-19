# 代码文档索引

状态：V3-Clean 文档整理后的活动入口。
基线：`8edefc7`。
范围：本索引只管理产品代码、运行时、测试、发布、数据和架构文档；毕设
任务书、调研材料和头脑风暴不在本轮归档范围内。

## 1. 规范层级

文档优先级从高到低如下：

1. `docs/architecture/`：V3-Clean 的规范契约。冲突时以
   `v3-clean-break.md`、`clean-schema.md`、`api-v2-contract.md`、
   `import-contract.md`、`v23-capability-matrix.md` 和 `decision-log.md`
   为准。
2. [`v3-clean-development-plan.md`](architecture/v3-clean-development-plan.md)：
   把规范拆为可验收的实施阶段，不改变规范本身。
3. 本页列出的运行、测试、威胁和需求文档：解释执行方式，不能新增与规范
   冲突的 API、表或状态。
4. `docs/evidence/`：不可变验证材料，只能证明已经发生的行为，不能替代
   规范或提升 Catalog 状态。
5. [`archive/legacy-code-docs/`](archive/legacy-code-docs/)：历史参考，禁止
   作为活动代码文档引用。

## 2. 活动文档

| 文档 | 责任 | 用途 | 状态 |
| --- | --- | --- | --- |
| [`architecture/v3-clean-break.md`](architecture/v3-clean-break.md) | 平台架构 | 总体目标、非目标、模块所有权和禁止模式 | 规范 |
| [`architecture/clean-schema.md`](architecture/clean-schema.md) | 数据平台 | clean baseline、实体、revision/CAS、状态机和事务 | 规范 |
| [`architecture/api-v2-contract.md`](architecture/api-v2-contract.md) | API 平台 | `/api/v2`、envelope、operation、SSE/JSON replay、MCP 映射 | 规范 |
| [`architecture/import-contract.md`](architecture/import-contract.md) | Importer | inspect/dry-run/run/resume/verify/cutover、ID mapping 和 rollback | 规范 |
| [`architecture/v23-capability-matrix.md`](architecture/v23-capability-matrix.md) | 产品架构 | V2.3 L0-L7、Catalog、API/Command/Event/Table/UI/Test/Evidence 对照 | 规范 |
| [`architecture/decision-log.md`](architecture/decision-log.md) | 架构委员会 | 决策、拒绝模式和变更流程 | 规范 |
| [`architecture/v3-clean-development-plan.md`](architecture/v3-clean-development-plan.md) | 工程负责人 | 分阶段任务、依赖、门禁、交付物和完成条件 | 实施计划 |
| [`testing.md`](testing.md) | 质量工程 | 测试层级、性能、安全和 release gate | 支撑 |
| [`threat-model.md`](threat-model.md) | 安全负责人 | 资产、信任边界、控制和残余风险 | 支撑 |
| [`runbook.md`](runbook.md) | 运维负责人 | clean 部署、离线导入、cutover、备份和部署级回滚 | 支撑 |
| [`requirements-traceability.md`](requirements-traceability.md) | 产品/毕设负责人 | 毕设需求到能力矩阵和证据的追踪 | 支撑 |
| [`v2-retrospective.md`](v2-retrospective.md) | 架构历史 | V2 经验和已撤销 receipt 的背景 | 历史参考 |

## 3. 代码与文档的对应规则

每个实现阶段必须同时更新以下五类记录：

- 能力矩阵行：API、Command、Event、Table、状态机、UI、外部依赖、测试和
  Evidence；
- clean schema/API diff；
- 行为、集成、安全和 UI 测试 receipt；
- 修改 artifact、patch、验证记录和 rollback receipt；
- Catalog 状态（只能由 receipt 推导）。

活动文档不得出现 `/api/v1`、`assist_operations`、`native_v5`、
`native_v6`、旧 runtime import、双写或共享旧/新写卷等活动实现指引。

## 4. 非代码资料

以下资料仍保留原位置，不冒充代码契约：

| 位置 | 性质 |
| --- | --- |
| `doc/` | 产品想法、问题追踪和愿景草稿 |
| `探索/`、`探索-1/` | 调研、资料索引和开放问题 |
| `当前项目毕业设计任务书/`、`任务书/` | 学校任务书及其核验材料 |
| `docs/evidence/` | 历史实现的验证、截图、快照和回滚材料 |

## 5. 维护和检查

新增代码文档前，先在本索引登记责任人、规范层级和对应能力行。提交前
执行：

```powershell
rg -n "V3-Clean|v3-clean|/api/v2|V23-L[0-7]|REC-D" docs/architecture docs/document-index.md AGENTS.md
git diff --check
git status --short --branch
```

失效文档只移动到归档目录，不删除、不覆盖；归档动作必须在归档 README
中写明原因和替代入口。
