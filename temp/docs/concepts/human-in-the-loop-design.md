# 概念研究：Human-in-the-Loop（HITL，人在回路）

> 对应搜索角度：**设计哲学与专注机制** / **本地优先与 Agent 架构**

## 一、摘要

HITL（Human-in-the-Loop）是一种**混合智能系统架构**，将人类判断与 AI 系统结合，形成闭环反馈。在 Agent 时代，HITL 是"AI 执行速度指数增长 + 人类审核速度线性增长"这一结构性矛盾的核心解法——也是外部报告 `gemini-research-report.md` 的**候选主旨 9**。

## 二、本轮核验事实

| # | 事实 | 证据 |
|---|------|------|
| N1 | HITL 的核心是"流程可中断 + 人类可决策 + 系统可继续"。 | 多篇 2025 中文综述。 |
| N2 | HITL **主要解决"责任归属"问题，而非自动解决"工程安全"**——人类 checkpoint 必须设计成能真正捕获失败模式。 | cnblogs.com/yuer2025/p/19433709 综述。 |
| N3 | LangGraph 的 HITL 实现机制：Dynamic interrupts（节点内暂停）+ Static interrupts（`interrupt_before` / `interrupt_after`）+ 持久化（MemorySaver / checkpointing）。 | 多篇 LangGraph 教程。 |
| N4 | Spring AI Alibaba 的企业级 HITL 设计：把"批准"钩子挂在"工具"上（如文件删除、shell 执行需要审批）；决策分 approve / reject / modify 三种。 | cnblogs.com / CSDN 多篇。 |
| N5 | 决策层级：**置信度阈值 → 重试边界 → 执行权限**。 | aimagician 综述。 |

## 三、HITL 的四大设计模式

| 模式 | 描述 | 适用场景 |
|------|------|----------|
| **Static Interrupt** | 在图执行前预设 `interrupt_before` / `interrupt_after` 节点 | 工具调用前必须审批（如删除文件） |
| **Dynamic Interrupt** | 在节点内部根据当前状态决定是否暂停 | 置信度低于阈值时触发人类介入 |
| **Tool-level Approval** | 把批准钩子挂在具体工具上 | 高危操作（write / delete / exec） |
| **State-based Resume** | 持久化状态后，用户决策后 resume | 长流程跨会话 |

## 四、为何与本毕设高度相关

- **主旨 1（AI 工作流透明化）**：HITL 是"透明化"的最具体落地——人类**实际**介入决策。
- **候选主旨 9**（外部报告）：HITL 的"决断空间"是 AI 系统的最高壁垒。
- **主旨 5（行为资产化）**：HITL 决策本身可被记录为"行为资产"——其他成员可学习"何时该介入"。
- **主旨 8（生态集成）**：HITL 是 LangGraph / Spring AI / CrewAI 等框架的内建能力。

## 五、对毕设的启示

1. **HITL 不是可选项，而是企业级 Agent 的入场券**——纯自动化在生产环境极脆弱。
2. **"人在哪里介入"是设计问题，不是工程问题**——必须在 PRD 阶段就明确：哪些工具需要 HITL？置信度阈值是多少？
3. **HITL 决策要可重放**——每一次 approve/reject/modify 都应留痕，构成可审计的事件流。
4. **避免"虚假 HITL"**——只展示结果让用户点"OK"不叫 HITL；用户必须能**修改** AI 的中间产物。

## 六、参考来源

- LangGraph HITL 教程: https://langchain-ai.github.io/langgraph/how-tos/human_in_the_loop/
- 综述（中文）: https://www.cnblogs.com/aimagician/p/19899247
- Spring AI HITL: https://java2ai.com/docs/1.0.0-M6.2/tutorials/agent/human-in-the-loop/
- 综述（HITL 的工程真相）: https://www.cnblogs.com/yuer2025/p/19433709
- Agentic Design Patterns（Pattern #13）: https://www.cnblogs.com/rengang66/p/161235196

> ⚠️ 本文件为本轮补充核验资料，未做 3 票对抗式核验。