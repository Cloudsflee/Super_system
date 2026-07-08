# 开发侧主旨 3：生态集成

> "能够深度**集成各类开源工具**，充分利用现有轮子，降低开发与维护成本。"

## 一、摘要

"生态集成"是"去依赖"在工程实施层的具体表现。它要求系统：
- **不重新发明轮子**——能复用 OSS 就复用；
- **明确边界**——内部核心逻辑 与 外部 OSS 适配层 分开；
- **遵循开放协议**——MCP / OpenTelemetry / SQL / HTTP，让"集成"是双向的、可移植的。

## 二、已验证事实

| # | 事实 | 与本主旨的关联 |
|---|------|----------------|
| C1 | AppFlowy-Cloud 后端用 Rust，客户端用 Flutter。 | 范例：单一后端 + 多端客户端，复用社区原生 UI 框架（Flutter）而非自研渲染层。 |
| C3 | TriliumNext Notes 支持 JavaScript 脚本扩展。 | 启示：暴露"扩展点 API"就是生态集成的最直接形式——让社区写集成。 |
| C8 | AppFlowy-Cloud 采用 AGPL-3.0 协议。 | 协议选择是"生态战略"——AGPL 防止云厂商白嫖，激励生态贡献回流。 |
| C9 | AppFlowy-Cloud 活跃维护、529 forks。 | 社区可贡献 = 生态可持续 = 长期可集成。 |
| C11 | TriliumNext Notes 跨平台 + 内置 Task Manager。 | 提示"集成"应当"内聚但不锁死"——Task Manager 是内置的，但代码 / 数据均可导出。 |

## 三、相关方法与工具（线索性记录）

### 3.1 Agent / LLM 编排
- LangChain / LlamaIndex / **LangGraph**（图编排） / **CrewAI / AutoGen**（多代理）。
- **Anthropic MCP**（Model Context Protocol）——让 Agent 接入任意"工具 / 数据源"的开放协议。
- **n8n / Flowise / Dify** —— 可视化工作流编排。
- **Open WebUI** —— 开源自托管 LLM 对话前端。

### 3.2 可观测性 / 评估
- Langfuse / **OpenLLMetry**（OTel） / Phoenix / Helicone。
- PromptFoo / DeepEval / Inspect AI —— 提示词/Agent 评估框架。

### 3.3 存储 / 搜索
- Postgres / SQLite / DuckDB；Meilisearch / Typesense / Qdrant（向量）。

### 3.4 知识管理 / 任务管理
- Logseq / TriliumNext / Obsidian；Linear / Plane / Leantime。

## 四、对毕设的启示

1. **优先复用"事实标准"**——OTel（追踪）、SQL（数据）、HTTP/REST（接口）、MCP（Agent 工具）、Git（版本）。这五条协议 = 五种"被任何生态兼容"的入场券。
2. **集成层与核心层分离**——核心逻辑不应直接 import 某个 OSS 库的内部 API；应通过"适配器模式"包装，以便替换。
3. **协议 > 框架**——选一个"标准协议"（如 OTel、MCP）比选一个"流行框架"（如 LangChain）更稳——协议多年不变，框架每两年换一代。
4. **避免"半集成"**——若声称"支持 MCP"，就必须实现完整的 MCP 协议；只实现 60% 会被生态孤立。
5. **回报生态**——若使用 AGPL-3.0（C8），意味着你也要把改进开源回流，这是生态能持续运转的契约。

## 五、参考来源

- AppFlowy-Cloud（已验证 C1/C8/C9）: https://github.com/AppFlowy-IO/AppFlowy-Cloud
- TriliumNext Notes（已验证 C3/C11）: https://github.com/TriliumNext/Notes
- Model Context Protocol: https://modelcontextprotocol.io/
- LangGraph: https://langchain-ai.github.io/langgraph/
- OpenLLMetry: https://github.com/traceloop/openllmetry
- Open WebUI: https://github.com/open-webui/open-webui

> ⚠️ 本文件中"第三节"内容为本工作流范围之外的线索性资料，未做对抗核验。
