# 工具与产品速查

> 本文件汇总毕设研究范围内涉及的代表性工具与产品。
> 标记 **[已验证]** 的条目引用了 `references/verified-claims/SUMMARY.md` 中的 CONFIRMED 事实（首轮工作流 3 票对抗式核验）。
> 标记 **[本轮补充]** 的条目引用了 `SUMMARY-v2.md` 的本轮 WebSearch 核验结果。
> 其他条目为线索性资料，未做对抗核验。
>
> **本轮新增**：Heptabase、Raycast、Linear、GitHub Copilot Coding Agent、Notion AI、Reflect、Langfuse、MCP、LangGraph、Ollama + 开源模型生态、Shape Up、SWE-bench。

## 一、知识管理 / PKM


| 工具                                        | 类别          | 关键特性                                                                          | 与毕设主旨         |
| ----------------------------------------- | ----------- | ----------------------------------------------------------------------------- | ------------- |
| **TriliumNext Notes** [已验证 C2/C3/C10/C11] | 自托管 PKM     | 树形 + JS 脚本 + 版本历史 + Task Manager；社区 fork 自 zadam/trilium；~33.3k stars         | 1 / 3 / 5     |
| **Logseq** [已验证 C4/C5/C12 + 本轮 N]         | 开源 PKM      | 块结构 + 本地优先 + AGPL-3.0 + 插件市场（github.com/logseq/marketplace）+ Pro 订阅（$5–$10/月） | 3 / 4 / 5 / 7 |
| **Heptabase** [本轮 N]                      | 商业 PKM      | 视觉卡片 + 白板 + 知识图谱 + 区域链接（独家）+ Heptabase AI；Super Individual $20/月              | 3 / 4 / 5     |
| Obsidian                                  | 闭源 PKM      | 双向链接 + 插件生态 + 本地优先                                                            | 5             |
| Roam Research                             | 闭源 SaaS PKM | 大纲 + 块 + Graph（首创"块"范式）                                                       | 5             |
| Notion [本轮 N]                             | SaaS 协作     | 块 + 数据库 + 多视图 + Notion AI（Q&A 跨工作空间）+ 3.0 Agents                              | 3 / 5         |
| **Reflect** [本轮 N]                        | 商业 PKM      | 日记 + 双向链接 + AI 集成（端到端加密细节待核验）                                                 | 3 / 5         |
| AppFlowy [已验证 C1/C8/C9]                   | 开源自托管协作     | Notion 替代 + AI 集成                                                             | 3 / 4 / 8     |
| Anytype                                   | 本地优先 PKM    | 去中心化 + 端到端加密                                                                  | 4 / 5         |


## 二、项目管理 / 任务管理


| 工具                | 类别    | 关键特性                                                            | 与毕设主旨 |
| ----------------- | ----- | --------------------------------------------------------------- | ----- |
| **Linear** [本轮 N] | 商业 PM | 键盘优先 + 极致速度（"fast as a feature"）；List/Board/Timeline/Roadmap 视图 | 3 / 7 |
| Height            | 商业 PM | AI-first + 自动分类                                                 | 7     |
| Shortcut          | 商业 PM | 文档 + 工作流一体化                                                     | 7     |
| Plane             | 开源 PM | 自托管 + Linear 替代                                                 | 7 / 8 |
| Leantime          | 开源 PM | 自托管 + 多视图 + ADHD 友好                                             | 7     |


## 三、AI Agent 编排


| 工具                                     | 类别        | 关键特性                                                                            | 与毕设主旨         |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------- | ------------- |
| **LangGraph** [本轮 N]                   | 编排框架      | StatefulGraph（State + Node + Edge + Checkpointer）；human-in-the-loop；time travel | 1 / 5 / 7 / 8 |
| **CrewAI**                             | 编排框架      | 角色分工式多代理                                                                        | 2 / 5         |
| **AutoGen**                            | 编排框架      | 对话式多代理                                                                          | 5             |
| **GitHub Copilot Coding Agent** [本轮 N] | AI 开发代理   | 5 种 Agent 模式（local/background/cloud/Claude/Codex）；Issue → PR 全流程                | 1 / 5 / 7 / 8 |
| **n8n**                                | 可视化编排     | 开源 + 自托管 + 大量集成                                                                 | 8             |
| **Flowise**                            | 可视化编排     | 拖拽式 LLM 应用构建                                                                    | 8             |
| **Dify**                               | 开源 LLM 平台 | 应用编排 + RAG + 评估                                                                 | 8             |


## 四、模型网关与本地运行时


| 工具                | 类别       | 关键特性                                                                       | 与毕设主旨 |
| ----------------- | -------- | -------------------------------------------------------------------------- | ----- |
| **Ollama** [本轮 N] | 本地运行     | 一键运行 Llama 3.3 / Qwen 2.5/3 / DeepSeek-V3/R1 / Mistral / Phi / Gemma 等开源模型 | 4     |
| **vLLM**          | 高性能推理    | PagedAttention + 高吞吐                                                       | 4     |
| **llama.cpp**     | 跨平台推理    | CPU / GPU / 嵌入式                                                            | 4     |
| **LM Studio**     | 本地运行 GUI | 桌面 App + 模型市场                                                              | 4     |
| **LiteLLM**       | 统一网关     | 100+ LLM Provider 统一接口                                                     | 4 / 8 |
| **OpenRouter**    | 路由网关     | 多模型路由 + 统一账单                                                               | 4 / 8 |
| **Portkey**       | AI 网关    | Prompt 管理 + 缓存 + 审计                                                        | 4 / 8 |


## 五、可观测与评估


| 工具                  | 类别       | 关键特性                                                                 | 与毕设主旨 |
| ------------------- | -------- | -------------------------------------------------------------------- | ----- |
| **Langfuse** [本轮 N] | 可观测      | Trace / Token 计量 / 成本追踪 / Prompt 版本化 / Eval / Playground；当前 v3.142.0 | 1 / 6 |
| **OpenLLMetry**     | 可观测      | OTel 标准的 LLM 扩展（gen_ai.* 属性）                                         | 1 / 8 |
| **Arize Phoenix**   | 可观测 + 评估 | Span 追踪 + 漂移检测                                                       | 1     |
| **Helicone**        | 网关 + 可观测 | 请求缓存 + 审计日志                                                          | 1 / 4 |
| **PromptFoo**       | 评估       | 提示词 / Agent 单元测试                                                     | 1 / 6 |
| **DeepEval**        | 评估       | LLM-as-judge + 多维度评分                                                 | 1 / 6 |
| **LangSmith**       | 可观测      | LangChain 官方 + Eval Dataset                                          | 1 / 6 |
| **Inspect AI**      | 评估       | UK AISI 出品 + Agent 行为评估                                              | 1     |


## 六、AI 协议


| 协议                                     | 维护者                    | 关键能力                                                     | 与毕设主旨     |
| -------------------------------------- | ---------------------- | -------------------------------------------------------- | --------- |
| **MCP（Model Context Protocol）** [本轮 N] | Anthropic（2024-11）+ 社区 | 基于 JSON-RPC 2.0；Tools / Resources / Prompts；"AI 的 USB-C" | 1 / 4 / 8 |
| **OpenAI Function Calling**            | OpenAI                 | 工具调用（事实标准）                                               | 1         |
| **A2A（Agent-to-Agent）**                | Google                 | Agent 互操作                                                | 8         |
| **OTel GenAI SIG**                     | CNCF                   | 追踪 + Trace 标准（gen_ai.* 语义约定）                             | 1 / 8     |


## 七、协议与法律


| 协议             | 类型          | 关键考量                                                        |
| -------------- | ----------- | ----------------------------------------------------------- |
| **AGPL-3.0**   | Copyleft 开源 | 防止云厂商白嫖（[已验证 C8]）；AppFlowy-Cloud / Logseq / TriliumNext 均采用 |
| **Apache-2.0** | 宽松开源        | 允许商用闭源衍生                                                    |
| **MIT**        | 最宽松         | 极简、几乎无限制                                                    |


## 八、基准与数据集


| 名称                          | 用途                                  | 与毕设主旨 |
| --------------------------- | ----------------------------------- | ----- |
| **SWE-bench** [本轮 N（细节待核验）] | 真实 GitHub Issue + 单元测试对 LLM 改写能力做基准 | 6     |
| **SWE-bench Verified**      | 人工核验版的 SWE-bench 子集                 | 6     |
| HumanEval                   | 代码生成基准                              | 6     |
| LiveCodeBench               | 时效性更强的代码基准                          | 6     |


## 九、统一入口 / 启动器


| 工具                 | 类别      | 关键特性                                                                               | 与毕设主旨         |
| ------------------ | ------- | ---------------------------------------------------------------------------------- | ------------- |
| **Raycast** [本轮 N] | 启动器     | 键盘优先 + AI Commands + Presets + Quicklinks + 集成 GitHub/Linear/Notion/Slack；Pro $8/月 | 1 / 3 / 5 / 8 |
| Alfred             | 启动器（闭源） | macOS 老牌启动器                                                                        | 3             |


## 十、方法论 / 思想框架


| 名称                                  | 提出者                                  | 核心思想                                                                          | 与毕设主旨 |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- | ----- |
| **Zettelkasten** [已验证 C6/C7 + 本轮 N] | Niklas Luhmann（实践）+ Sönke Ahrens（推广） | 卡片 + 链接 + 自包含；Luhmann 9 万张卡片产出 70+ 本书 / 400+ 文章                               | 5     |
| **Shape Up** [本轮 N]                 | Basecamp / Ryan Singer               | Fixed time（6 周）+ Variable scope；Appetite ≠ Estimate；Betting Table；Hill Charts | 7     |
| SPACE 框架                            | Microsoft Research                   | 个人 / 团队工程贡献量化                                                                 | 2     |
| DORA 指标                             | Google / DORA                        | 交付性能度量                                                                        | 2 / 7 |
| Building a Second Brain             | Tiago Forte                          | CODE（Capture / Organize / Distill / Express）                                  | 5     |
| GTD                                 | David Allen                          | 收集 → 处理 → 整理 → 回顾 → 行动                                                        | 5 / 7 |


---

## 速记：8 个"必装"工具（按毕设主旨，本轮更新）

1. **Ollama** — 主旨 4（去依赖；本地运行开源模型）
2. **LiteLLM** — 主旨 4 / 8（多模型统一网关）
3. **LangGraph** — 主旨 1 / 5 / 7 / 8（Agent 有向图编排）
4. **Langfuse** — 主旨 1 / 6（LLM 可观测 + 成本追踪）
5. **OpenLLMetry** — 主旨 1 / 8（OpenTelemetry 标准 LLM 扩展）
6. **MCP** — 主旨 1 / 4 / 8（AI 工具统一协议）
7. **Zettelkasten 思想 + Logseq / TriliumNext** — 主旨 3 / 5（数据模型）
8. **Shape Up** — 主旨 7（去形式化 PM 的方法论基线）

## 速记：6 个"必看"行业产品（按毕设主旨）

1. **Heptabase** — 主旨 3 / 5（可视化 PKM；"Super Individual" 商业产品级对应物）
2. **Linear** — 主旨 7（去形式化 PM 的产品范本）
3. **Raycast** — 主旨 1 / 5 / 8（统一入口 + AI Presets）
4. **GitHub Copilot Coding Agent** — 主旨 1 / 5 / 7（"派单即开发"愿景）
5. **Notion AI** — 主旨 3 / 5（AI 嵌入工作空间的范本；闭源的反例）
6. **Reflect** — 主旨 3 / 5（日记 + AI；端到端加密卖点）

