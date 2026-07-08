# 工具研究：Ollama 与 2025 开源模型生态

> 对应搜索角度：**本地优先与 Agent 架构** / **主流开源工具与生态**

## 一、摘要

Ollama 是 macOS / Linux / Windows 上运行开源 LLM 的最便捷工具。它把模型管理、下载、服务封装成一个简单的 CLI + REST API，让"本地运行 Llama / Qwen / DeepSeek"只需 `ollama run llama3.3`。

## 二、本轮核验事实

| # | 事实 | 证据 |
|---|------|------|
| N1 | Ollama 跨平台：macOS、Linux、Windows；提供 CLI + REST API。 | ollama.com 官网。 |
| N2 | 2025 年主流开源模型家族：Llama 3.3 70B、Qwen 2.5/3 系列、DeepSeek-V3（671B MoE）/ DeepSeek-R1 / DeepSeek-Coder、Mistral / Mixtral、Phi-3/4、Gemma 2/3。 | ollama 模型库 + 官方公告。 |
| N3 | 关键趋势：MoE（混合专家）架构成为顶级性能模型主流；Reasoning 模型（DeepSeek-R1）开源化；3B–8B 小模型能力显著提升。 | 多源综述。 |
| N4 | 一键运行示例：`ollama run llama3.3` / `ollama run qwen2.5` / `ollama run deepseek-r1`。 | ollama.com 文档。 |

## 三、为何与本毕设高度相关

- **主旨 4（去依赖）**：本地运行开源模型 = 毕设不被任何 AI 厂商绑定。答辩时演示"断网仍可用"是强加分。
- **主旨 6（重构成本定量化）**：本地模型 + Token 计量 = 重构成本函数的"可控变量"。
- **主旨 8（生态集成）**：Ollama 提供 OpenAI 兼容 API，可直接接入 LiteLLM / LangChain / LangGraph。
- **主旨 7（去形式化 PM）**：本地模型意味着数据不出本机，团队成员之间不必担心数据合规。

## 四、对毕设的启示

1. **默认使用 Ollama 作为本地运行时**——保证毕设演示在无网络环境下也能跑。
2. **用 LiteLLM 抽象"模型来源"**——Ollama / OpenAI / Anthropic 在毕设代码中应是同一接口。
3. **优选小模型 + 推理优化**——3B–8B 模型在 2025 年已经能完成多数 Agent 任务；不应盲目追求 70B。
4. **MoE 架构的工程影响**——推理时显存占用取决于激活参数（不是总参数），这对硬件选型影响巨大。

## 五、参考来源

- Ollama 官网: https://ollama.com/
- Ollama GitHub: https://github.com/ollama/ollama
- Ollama 模型库: https://ollama.com/library

> ⚠️ 本文件为本轮补充核验资料，未做 3 票对抗式核验。