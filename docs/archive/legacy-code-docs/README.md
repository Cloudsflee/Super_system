# 失效代码文档归档

本目录保存与 V3-Clean 决策冲突、但仍有历史审计价值的代码文档。归档
表示它们不再是当前实现、接口、数据模型或发布流程的依据；原文保留，不能
重新挂回活动文档入口。

归档基线：`8edefc7d110dca80958e3ef0fe9115dd62a8751a`
归档日期：2026-08-19
当前规范入口：[`docs/document-index.md`](../../document-index.md)

## 文件映射

| 归档文件 | 失效原因 | 当前替代文档 |
| --- | --- | --- |
| [`api-v1.md`](api-v1.md) | 固定 `/api/v1`，没有 clean-break envelope、API v2 和统一 MCP 映射 | [`api-v2-contract.md`](../../architecture/api-v2-contract.md) |
| [`architecture-pre-clean.md`](architecture-pre-clean.md) | 描述旧 V3 单用户运行时、旧路由和旧迁移启动链 | [`v3-clean-break.md`](../../architecture/v3-clean-break.md) |
| [`data-model-pre-clean.md`](data-model-pre-clean.md) | 包含 `assist_operations`、旧表指针和 V1-V6 运行时迁移假设 | [`clean-schema.md`](../../architecture/clean-schema.md) |
| [`开发计划-v3-recovery-pre-clean.md`](开发计划-v3-recovery-pre-clean.md) | 使用 `/api/v1`，把音视频/PPTX/压缩包列为排除项，阶段边界早于 clean baseline 决策 | [`v3-clean-development-plan.md`](../../architecture/v3-clean-development-plan.md) |
| [`测试计划-v3-recovery-pre-clean.md`](测试计划-v3-recovery-pre-clean.md) | 验收对象是旧 V3 运行时，parser 范围和 release/cutover 规则已过时 | [`v3-clean-development-plan.md`](../../architecture/v3-clean-development-plan.md) |
| [`runbook-pre-clean.md`](runbook-pre-clean.md) | 面向旧 `aiws-data-v3` 卷和旧 V2.2 清理流程，未定义离线 importer | [`docs/runbook.md`](../../runbook.md) |
| [`V3功能恢复与架构治理判断-pre-clean.md`](V3功能恢复与架构治理判断-pre-clean.md) | 早期审计判断已被 clean-break 决策、能力矩阵和决策日志取代 | [`v3-clean-break.md`](../../architecture/v3-clean-break.md)、[`v23-capability-matrix.md`](../../architecture/v23-capability-matrix.md) |

## 使用规则

1. 归档文件只用于理解历史行为、迁移来源和决策背景，不得作为新代码的
   API、schema、状态机或发布依据。
2. 需要恢复历史行为时，先在能力矩阵中建立对应行，再引用归档文件和
   V2.3 fixture；不得直接复制旧 runtime 分支。
3. 若归档内容仍有可复用的安全控制或测试阈值，应复制为新的、明确标注
   V3-Clean 目标的文档，并在决策日志中记录来源。
