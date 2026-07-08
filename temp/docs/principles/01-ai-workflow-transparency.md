# 用户侧主旨 1：AI 工作流透明化

> "AI 辅助工作时，其核心步骤与决策路径必须**可观测、可介入**，拒绝黑盒操作。"

## 一、摘要

AI 工作流透明化要求系统把模型调用、工具调用、决策路径以**结构化、可追溯**的形式暴露给用户，让用户能在执行前审视、过程中介入、执行后回溯。本主旨的关键挑战在于：现代 LLM 应用的执行链路由"模型决策 → 工具调用 → 子代理 → 中间产物"组成，**任一环节的黑盒化都会让系统整体失去可解释性**。

## 二、已验证事实

本次研究中直接命中的 verified claim **未覆盖** LLM/Agent 可观测性工具的实证核验（脚本核验阶段遭遇 API 限流）。但围绕"透明化"主旨，本次工作流确认的事实可作为**间接证据**：

- **C2 / C10 / C11（TriliumNext Notes）**：支持完整的笔记版本历史、JS 脚本化扩展、跨平台。**启示**：透明化的最低要求是"操作可回滚"与"行为可编程"，与一般软件工程中的"审计日志 + 扩展点"原则一致。
- **C6 / C7（Zettelkasten 方法论）**：笔记"链接而非分类"，且每条永久笔记需含脱离上下文可理解的思想。**启示**：透明化的副产品是"知识可外化、可审查"，这与 AI 工作流透明化要求"决策可外化、可审查"在结构上同构。

## 三、相关工具与产品（仅做线索性记录，未做对抗核验）

以下工具在公开资料中被广泛列为 LLM/Agent 可观测性代表项目，**供读者自行验证后引用**：


| 工具            | 定位                       | 关键能力                               |
| ------------- | ------------------------ | ---------------------------------- |
| Langfuse      | 开源 LLM 可观测性平台            | Trace、Token/成本计量、Prompt 版本化、用户反馈回路 |
| OpenLLMetry   | OpenTelemetry 标准的 LLM 扩展 | OTLP 原生支持、与现有 APM 集成               |
| Arize Phoenix | 开源可观测 + 评估               | Span 级追踪、漂移检测、嵌入可视化                |
| LangSmith     | LangChain 官方平台           | Trace 回放、Eval Dataset、Prompt Hub   |
| Helicone      | LLM 网关 + 可观测             | 请求/响应缓存、审计日志、成本路由                  |


## 四、对毕设的启示

1. **可观测性的最低集合**——任何一次 AI 调用至少应记录：输入、输出、所用模型、Token 消耗、耗时、工具调用链。建议采用 **OpenTelemetry 语义约定（GenAI SIG）** 作为统一数据模型，避免后期被厂商锁定。
2. **可介入性的实现路径**——在 Agent 工具调用之前插入"确认/编辑"节点；不要等执行完再让用户回滚。
3. **决策路径外化**——把 Agent 的"思考-工具调用-观察"循环以 step-card 的形式渲染，让用户能像查阅 Git diff 一样审阅。
4. **避免"半透明化"陷阱**——仅展示最终答案 ≠ 透明化；中间失败的 tool call、未选用的候选方案都是用户决策所需的信息。

## 五、参考来源

- Langfuse: [https://langfuse.com/](https://langfuse.com/)
- OpenLLMetry: [https://github.com/traceloop/openllmetry](https://github.com/traceloop/openllmetry)
- Arize Phoenix: [https://phoenix.arize.com/](https://phoenix.arize.com/)
- OpenTelemetry GenAI SIG: [https://opentelemetry.io/blog/2024/gen-ai-semantic-conventions/](https://opentelemetry.io/blog/2024/gen-ai-semantic-conventions/)
- TriliumNext Notes（已验证）：[https://github.com/TriliumNext/Notes](https://github.com/TriliumNext/Notes)
- takesmartnotes.com（已验证）：[https://takesmartnotes.com/](https://takesmartnotes.com/)

> ⚠️ 本文件中"第三节"内容为本工作流范围之外的线索性资料，未做对抗核验，仅作为后续阅读的入口。

