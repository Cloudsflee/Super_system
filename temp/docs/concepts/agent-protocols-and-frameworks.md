# 概念研究：Agent 协议与编排框架

> 对应搜索角度：**本地优先与 Agent 架构** / **主流开源工具与生态**

## 一、摘要

"Agent"在本系统中不是单一概念，而是**一个协议族 + 一个编排栈**的组合：
- **协议层**：MCP（Model Context Protocol）、A2A（Agent-to-Agent）、OpenAI Function Calling。
- **编排层**：LangGraph（图编排）、CrewAI（角色分工）、AutoGen（对话式多代理）。
- **运行时**：本地（Ollama / LM Studio）+ 云（Anthropic / OpenAI / Google Vertex）。
- **可观测**：Langfuse / OpenLLMetry / Phoenix / Helicone。

毕设的"主旨 1（透明化）+ 主旨 4（去依赖）+ 主旨 8（生态集成）"都在这一层落地。

## 二、关键协议 / 框架速查表

| 名称 | 类型 | 核心定位 | 与本毕设主旨对应 |
|------|------|----------|------------------|
| **MCP（Model Context Protocol）** | 协议 | 模型 ↔ 工具 / 数据源 | 主旨 1 / 8 |
| **LangGraph** | 编排框架 | 有状态 Agent 图 | 主旨 1 / 5 / 8 |
| **CrewAI** | 编排框架 | 角色分工式多代理 | 主旨 2 / 5 |
| **AutoGen** | 编排框架 | 对话式多代理 | 主旨 5 |
| **Langfuse** | 可观测 | Trace / Token / 评估 | 主旨 1 / 6 |
| **OpenLLMetry** | 可观测 | OpenTelemetry 标准的 LLM 扩展 | 主旨 1 / 8 |
| **Arize Phoenix** | 可观测 + 评估 | Span 级追踪 + 漂移检测 | 主旨 1 |
| **PromptFoo** | 评估 | 提示词 / Agent 单元测试 | 主旨 1 / 6 |
| **Ollama / vLLM / llama.cpp** | 运行时 | 本地运行开源模型 | 主旨 4 |
| **LiteLLM / OpenRouter / Portkey** | 网关 | 统一多家模型 API + fallback | 主旨 4 / 8 |
| **n8n / Flowise / Dify** | 可视化编排 | 低代码 Agent 工作流 | 主旨 8 |

## 三、为何与本毕设高度相关

这是毕设"开发侧"的**核心工具箱**：
- **主旨 1（透明化）**：OpenLLMetry / Langfuse 是 LLM 时代的"日志库 + Trace"。
- **主旨 4（去依赖）**：Ollama + LiteLLM 是"不绑定 OpenAI"的工程底座。
- **主旨 5（行为资产化）**：LangGraph + CrewAI 让"工作流"可沉淀为可重放的图。
- **主旨 6（重构成本定量化）**：Langfuse 的 Token 计量是"成本函数"的数据源。
- **主旨 8（生态集成）**：MCP 是"集成任意工具"的统一接口。

## 四、对毕设的启示

1. **优先选择"协议 + 适配器"组合，而非单一框架**——MCP + LiteLLM + OpenLLMetry 三件套让你在 Agent / 模型 / 追踪三个层面都有退路。
2. **可观测必须内建，不可后置**——任何一个 Agent 调用若没有 trace，就是"黑盒"。建议在第一个 demo 之前就接入 OpenLLMetry。
3. **编排框架选图而非链**——LangGraph 的"图"范式比 LangChain 的"链"更能表达真实的"超级个体"工作流（分支、回退、并行）。
4. **本地模型不只是"省成本"**——它是"主旨 4（去依赖）"的硬保障，毕设答辩时演示"断网仍可用"是加分项。

## 五、参考来源

- Model Context Protocol: https://modelcontextprotocol.io/
- LangGraph: https://langchain-ai.github.io/langgraph/
- CrewAI: https://www.crewai.com/
- AutoGen: https://github.com/microsoft/autogen
- Langfuse: https://langfuse.com/
- OpenLLMetry: https://github.com/traceloop/openllmetry
- Arize Phoenix: https://phoenix.arize.com/
- Ollama: https://ollama.com/
- LiteLLM: https://github.com/BerriAI/litellm
- n8n: https://n8n.io/

> ⚠️ 本文件为线索性资料汇总，未做对抗核验。读者引用前请自行验证。
