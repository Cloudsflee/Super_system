# 工具研究：LangGraph

> 对应搜索角度：**本地优先与 Agent 架构** / **主流开源工具与生态**

## 一、摘要

LangGraph 是 LangChain 团队推出的**有状态 Agent 编排框架**，以**有向图（StatefulGraph）**为核心范式，把 LLM 调用建模为 Node + Edge + State + Checkpointer。它解决了 LangChain"链式"范式无法表达循环、分支、人机协作的痛点，是 2025 年 Agent 工程的事实标准之一。

## 二、本轮核验事实

| # | 事实 | 证据 |
|---|------|------|
| N1 | 核心原语：State（共享数据，通常 `TypedDict` / `BaseModel`）、Node（执行单元）、Edge（条件或固定连接）、Checkpointer（持久化）。 | 中文技术博客与官方文档。 |
| N2 | 范式：State Machine + Directed Graph + Message Passing。 | 多源综述。 |
| N3 | 关键能力：循环、分支、并行、持久化、human-in-the-loop、time travel、可视化。 | 多源综述。 |
| N4 | 推荐用 `Annotated[list[AnyMessage], add_messages]` 实现消息自动合并。 | LangGraph 官方文档与多篇教程。 |

## 三、为何与本毕设高度相关

- **主旨 1（透明化）**：Graph 天然可视化——用户可像看流程图一样审阅 Agent 决策路径。
- **主旨 5（行为资产化）**：Graph 本身可被持久化为"工作流模板"，新成员可"运行既有 graph"而非"重新实现"。
- **主旨 7（去形式化 PM）**：把"任务流转"建模为 Graph = 用代码替代"流程图会议"。
- **主旨 8（生态集成）**：与 LangChain、LangSmith、LangFuse 深度集成。

## 四、对毕设的启示

1. **首选 LangGraph 而非纯 LangChain**——Graph 范式更适合表达真实工作流的循环与分支。
2. **Checkpointer 是"行为资产化"的实现机制**——把 Graph 状态持久化为数据库中的 record。
3. **Human-in-the-loop 是核心模式**——Agent 不应全自动，而应在关键决策点等用户确认（呼应**主旨 1**）。
4. **避免图变成"意大利面"**——Graph 复杂度有上限（>50 节点就该拆分）；毕设需给出"图复杂度上限"的设计原则。

## 五、参考来源

- LangGraph 官方文档: https://langchain-ai.github.io/langgraph/
- 中文综述: https://cloud.tencent.com/developer/article/2650620
- 入门教程: https://www.runoob.com/ai-agent/langgraph-quick-start.html

> ⚠️ 本文件为本轮补充核验资料，未做 3 票对抗式核验。