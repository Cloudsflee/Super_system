# 评估矩阵与对比表

> 本文件汇总毕设选型阶段需要的对比矩阵。
> 全部为线索性资料，引用前请 WebFetch 验证。

---

## 一、PKM / 笔记工具对比矩阵

| 维度 | TriliumNext [已验证 C2/C3/C10/C11] | Logseq [已验证 C4/C5/C12] | Obsidian | Roam | Notion | Heptabase [本轮 N] | Anytype | Affine | Standard Notes |
|------|------------------------------------|---------------------------|----------|------|--------|---------------------|---------|--------|---------------|
| **数据模型** | 树形层级 | 块结构（大纲） | 块 + 文件 | 块（首创） | 块 + 数据库 | 卡片 + 白板 | Object（同构） | 块 + 多视图 | 纯文本 |
| **本地优先** | ✅ 完全 | ✅ 完全 | ✅ 完全 | ❌ SaaS | ❌ SaaS | ⚠️ 部分 | ✅ 完全 P2P | ✅ 是 | ✅ 完全 E2EE |
| **端到端加密** | ❌ 否 | ❌ 否 | ❌ 否 | ❌ 否 | ❌ 否 | ✅ 是 | ✅ 是 | ⚠️ 部分 | ✅ 是 |
| **去中心化** | ❌ 否 | ❌ 否 | ❌ 否 | ❌ 否 | ❌ 否 | ❌ 否 | ✅ P2P | ❌ 否 | ❌ 否 |
| **离线可用** | ✅ 是 | ✅ 是 | ✅ 是 | ⚠️ 有限 | ❌ 否 | ⚠️ 有限 | ✅ 是 | ✅ 是 | ✅ 是 |
| **多视图** | ⚠️ 插件 | ✅ 列表/Graph/卡 | ⚠️ 插件 | ⚠️ 有限 | ✅ 完整 | ✅ 强 | ✅ 是 | ✅ 是 | ❌ 否 |
| **白板** | ❌ 否 | ⚠️ 插件 | ⚠️ 插件 | ❌ 否 | ✅ 是 | ✅ 核心 | ❌ 否 | ✅ 是 | ❌ 否 |
| **Graph 视图** | ⚠️ 插件 | ✅ 是 | ✅ 是 | ✅ 是 | ❌ 否 | ✅ 是 | ✅ 是 | ⚠️ 部分 | ❌ 否 |
| **任务管理** | ✅ 内置 | ✅ 是 | ⚠️ 插件 | ⚠️ 插件 | ✅ 是 | ✅ Kanban | ✅ 是 | ✅ 是 | ⚠️ 扩展 |
| **脚本扩展** | ✅ JS | ✅ Clojure | ✅ 插件 | ⚠️ 有限 | ✅ API | ⚠️ 有限 | ⚠️ 有限 | ⚠️ 有限 | ⚠️ 扩展 |
| **协议** | AGPL-3.0 | AGPL-3.0 | 闭源 | 闭源 | 闭源 | 闭源 | Apache-2.0 | MIT | AGPL-3.0 |
| **AI 集成** | ❌ 第三方 | ✅ Logseq AI | ✅ 插件 | ✅ 内置 | ✅ Notion AI | ✅ Heptabase AI | ⚠️ 第三方 | ⚠️ 第三方 | ⚠️ 扩展 |
| **与毕设主旨** | 1/3/4/5 | 3/4/5/7 | 5 | 5 | 3/5 | 3/4/5 | 4/5 | 3/4 | 4/5 |

### 选型建议
- **若重"知识图谱 + 本地"**：Logseq（块 + 链接 + Graph）。
- **若重"扩展 + 自定义"**：TriliumNext（JS 脚本 + 版本历史）。
- **若重"可视化 + 白板"**：Heptabase（白板 + 卡片 + 区域链接）。
- **若重"隐私 + 极端去中心化"**：Anytype（Object + P2P + E2EE）。

---

## 二、AI Agent 编排框架对比

| 维度 | LangGraph [本轮 N] | CrewAI | AutoGen | n8n | Flowise | Dify | Pydantic AI [本轮 N] |
|------|---------------------|--------|---------|-----|---------|------|---------------------|
| **范式** | 有向图 | 角色分工 | 对话 | 流程图 | 拖拽 | 应用平台 | 强类型 Agent |
| **状态管理** | ✅ Checkpointer | ⚠️ 任务级 | ⚠️ 对话级 | ⚠️ 流程级 | ⚠️ 节点级 | ✅ 是 | ✅ 强类型 |
| **HITL 支持** | ✅ 完整 | ⚠️ 有限 | ✅ 完整 | ✅ 节点 | ⚠️ 有限 | ⚠️ 有限 | ✅ 完整（强类型） |
| **持久化** | ✅ MemorySaver | ⚠️ 有限 | ⚠️ 有限 | ✅ 数据库 | ⚠️ 有限 | ✅ 是 | ✅ 是 |
| **多代理** | ✅ 是 | ✅ 强 | ✅ 强 | ✅ 是 | ⚠️ 有限 | ✅ 是 | ✅ 是 |
| **可视化** | ✅ 强 | ⚠️ 弱 | ⚠️ 弱 | ✅ 强 | ✅ 强 | ✅ 强 | ⚠️ 弱 |
| **学习曲线** | 中 | 低 | 中 | 低 | 低 | 低 | 中 |
| **生产就绪** | ✅ 强 | ✅ 中 | ✅ 中 | ✅ 强 | ⚠️ 中 | ✅ 强 | ⚠️ 中（较新） |
| **生态** | LangChain 生态 | 独立 | MS 背景 | 开源大 | 独立 | 开源大 | Pydantic 生态 |
| **开源** | ✅ MIT | ✅ MIT | ✅ CC-BY | ✅ 公平 | ✅ MIT | ✅ Apache-2.0 | ✅ MIT |
| **与毕设主旨** | 1/5/7/8 | 2/5 | 5 | 8 | 8 | 8 | 1/6/9 |

### 选型建议
- **若要"复杂工作流 + 可视化 + HITL"**：LangGraph。
- **若要"角色分工 + 易上手"**：CrewAI。
- **若要"研究型多代理"**：AutoGen。
- **若要"无代码 + 业务人员"**：n8n / Flowise / Dify。
- **若要"强类型 + Pydantic 生态"**：Pydantic AI。

---

## 三、LLM 可观测性工具对比

| 维度 | Langfuse [本轮 N] | OpenLLMetry | Phoenix | Helicone | LangSmith | Logfire [本轮 N] |
|------|-------------------|-------------|---------|----------|-----------|-----------------|
| **协议** | OpenTelemetry | OpenTelemetry | OpenInference | 自有 | 自有 | OpenTelemetry |
| **Trace** | ✅ 完整 | ✅ 完整 | ✅ 完整 | ✅ 完整 | ✅ 完整 | ✅ 完整 |
| **Token 计量** | ✅ 强 | ✅ 强 | ✅ 强 | ✅ 强 | ✅ 强 | ✅ 强 |
| **成本追踪** | ✅ 跨 Provider | ⚠️ 需配置 | ⚠️ 需配置 | ✅ 路由级 | ✅ 强 | ✅ 强 |
| **Prompt 版本** | ✅ 内置 | ❌ 需外部 | ❌ 需外部 | ⚠️ 缓存级 | ✅ Prompt Hub | ⚠️ 需配置 |
| **Eval** | ✅ 内置 | ❌ 需外部 | ✅ 内置 | ❌ 需外部 | ✅ Eval Dataset | ⚠️ 需配置 |
| **多语言 SDK** | Py/JS/TS | Py/JS/TS/.NET | Py | 多语言 | Py/JS | Py |
| **自托管** | ✅ 是 | ✅ 是 | ✅ 是 | ⚠️ 混合 | ❌ SaaS | ✅ 是 |
| **开源** | ✅ MIT | ✅ Apache-2.0 | ✅ Apache-2.0 | ⚠️ 混合 | ❌ 闭源 | ❌ 闭源 |
| **学习曲线** | 中 | 低 | 中 | 低 | 低 | 低 |
| **与毕设主旨** | 1/6 | 1/8 | 1 | 1/4 | 1/6 | 1/6/9/12 |

### 选型建议
- **若要"开源 + 自托管 + 一站式"**：Langfuse。
- **若要"OTel 标准 + 多语言"**：OpenLLMetry。
- **若要"Pydantic 生态 + Pythonic"**：Logfire。
- **若要"LangChain 官方深度集成"**：LangSmith。
- **若要"网关级 + 路由成本"**：Helicone。

---

## 四、模型运行时 / 网关对比

| 维度 | Ollama [本轮 N] | vLLM | llama.cpp | LM Studio | LiteLLM | OpenRouter | Portkey |
|------|-----------------|------|-----------|-----------|---------|------------|---------|
| **定位** | 本地 CLI | 高吞吐推理 | C++ 跨平台 | GUI | 网关 | 路由 | 网关 |
| **硬件** | CPU/GPU | GPU | CPU/GPU/嵌入式 | CPU/GPU | — | — | — |
| **模型** | 主流开源 | 主流开源 | GGUF | 主流开源 | 100+ Provider | 多 Provider | 50+ |
| **OpenAI 兼容** | ✅ 是 | ✅ 是 | ⚠️ 需 wrapper | ✅ 是 | ✅ 是 | ✅ 是 | ✅ 是 |
| **生产就绪** | ⚠️ 中 | ✅ 强 | ✅ 强 | ⚠️ 中 | ✅ 强 | ✅ 强 | ✅ 强 |
| **可观测** | ⚠️ 弱 | ✅ Metrics | ⚠️ 弱 | ⚠️ 弱 | ✅ 强 | ✅ 强 | ✅ 强 |
| **与毕设主旨** | 4 | 4 | 4 | 4 | 4/8 | 4/8 | 4/8 |

### 选型建议
- **若要"毕设演示 + 断网可用"**：Ollama。
- **若要"生产级高吞吐"**：vLLM。
- **若要"嵌入式 / 边缘"**：llama.cpp。
- **若要"统一多模型 + 路由"**：LiteLLM / OpenRouter / Portkey。

---

## 五、PM 工具对比

| 维度 | Linear [本轮 N] | Height | Shortcut | Plane | Leantime | Notion | Basecamp |
|------|-----------------|--------|----------|-------|----------|--------|----------|
| **理念** | Fast as feature | AI-first | Docs + workflow | Open Linear | ADHD 友好 | 块数据库 | Shape Up 配套 |
| **键盘优先** | ✅ 强 | ⚠️ 中 | ⚠️ 中 | ✅ 强 | ⚠️ 中 | ⚠️ 中 | ❌ 否 |
| **开源** | ❌ 闭源 | ❌ 闭源 | ❌ 闭源 | ✅ 是 | ✅ 是 | ❌ 闭源 | ❌ 闭源 |
| **自托管** | ❌ 否 | ❌ 否 | ❌ 否 | ✅ 是 | ✅ 是 | ❌ 否 | ❌ 否 |
| **GitHub 集成** | ✅ 强 | ⚠️ 中 | ⚠️ 中 | ✅ 强 | ⚠️ 中 | ⚠️ 中 | ⚠️ 中 |
| **AI 集成** | ⚠️ 实验 | ✅ 核心 | ⚠️ 中 | ⚠️ 中 | ⚠️ 弱 | ✅ Notion AI | ❌ 否 |
| **多视图** | ✅ 4 视图 | ✅ 强 | ✅ 强 | ✅ 强 | ✅ 强 | ✅ 强 | ✅ 强 |
| **与毕设主旨** | 3/7 | 7 | 7 | 7/8 | 7 | 3/7 | 7 |

### 选型建议
- **若重"速度 + 键盘"**：Linear。
- **若重"AI-first"**：Height。
- **若重"自托管 + 开源"**：Plane / Leantime。
- **若重"Shape Up 原生"**：Basecamp。

---

## 六、行业"超级个体工具"对比

| 工具 | 核心定位 | 商业模式 | 与本毕设对照 |
|------|----------|----------|--------------|
| **Heptabase** | 可视化 PKM | SaaS 订阅 | "Super Individual" 档直接呼应毕设标题 |
| **Raycast** | 启动器 + AI | 免费 + Pro $8/月 | 入口层范本 |
| **Linear** | PM | SaaS 订阅 | 去形式化 PM 范本 |
| **Notion AI** | 协作 + AI | SaaS 订阅 | AI 嵌入工作空间范本 |
| **Reflect** | 日记 + AI | SaaS 订阅 | 数据主权范本 |
| **GitHub Copilot** | 代码 AI | SaaS 订阅 | "派单即开发"愿景 |
| **Obsidian** | 闭源 PKM | 一次性 + 订阅 | 商业版"本地优先"反例 |

---

## 七、CRDT 实现对比

| 实现 | 语言 | 性能 | 协议 | 生态 |
|------|------|------|------|------|
| **Yjs** | JS | 高 | 自有 | ProseMirror / Tiptap / Monaco |
| **Automerge** | JS/Rust | 中 | 自有 | 独立 |
| **Loro** | Rust | 高 | 自有 | 较新 |
| **Diamond Types** | Rust | 高 | 自有 | 研究向 |
| **Anytype 自研** | — | — | 自有 | Anytype 内部 |
| **Electric SQL** | Postgres + CRDT | 高 | Postgres wire | SQL 生态 |

### 选型建议
- **若要"前端富文本协作"**：Yjs。
- **若要"通用 JSON 文档"**：Automerge。
- **若要"高性能 / 大文档"**：Loro / Diamond Types。
- **若要"SQL 数据库"**：Electric SQL。

---

## 八、PKM 方法论对比

| 方法 | 提出者 | 核心 | 优势 | 劣势 | 适用 |
|------|--------|------|------|------|------|
| **Zettelkasten** | Niklas Luhmann | 卡片 + 链接 | 思想涌现 | 学习曲线陡 | 学术 / 研究 |
| **BASB / CODE** | Tiago Forte | Capture / Organize / Distill / Express | 项目导向 | 易"资料囤积" | 创意 / 项目 |
| **PARA** | Tiago Forte | Projects / Areas / Resources / Archives | 极简分类 | 粒度粗 | 通用 |
| **GTD** | David Allen | 收集 / 处理 / 整理 / 回顾 / 行动 | 完整闭环 | 流程重 | 时间管理 |
| **LYC** | 《印象笔记》 | 收集 / 整理 / 复盘 | 工具友好 | 无强理论 | 入门 |

---

## 九、AI Agent 协议对比

| 协议 | 维护者 | 发布时间 | 定位 | 与本毕设对照 |
|------|--------|----------|------|--------------|
| **MCP** [本轮 N] | Anthropic | 2024-11 | AI ↔ 工具 / 数据源 | 主旨 1/4/8 |
| **OpenAI Function Calling** | OpenAI | 2023-06 | 工具调用事实标准 | 主旨 1 |
| **A2A** | Google | 2025-04 | Agent 互操作 | 主旨 8 |
| **OpenAPI** | Linux Foundation | 2015 | REST API 描述 | 主旨 8 |
| **gRPC** | CNCF | 2015 | 高性能 RPC | 主旨 8 |

---

## 十、毕设选型总图

> 假设毕设系统由以下组件构成，本表给出推荐选型与备选。

| 组件层 | 推荐 | 备选 1 | 备选 2 |
|--------|------|--------|--------|
| **数据模型** | 块结构（自定义） | Logseq 模型 | Notion 模型 |
| **本地存储** | SQLite + Markdown 文件 | LevelDB | DuckDB |
| **同步** | Yjs（CRDT） | Automerge | Electric SQL |
| **后端** | Rust + Axum | Python + FastAPI | Go + Gin |
| **前端** | Tauri + React | Electron + React | Flutter |
| **Agent 编排** | LangGraph | Pydantic AI | CrewAI |
| **可观测** | Langfuse | OpenLLMetry | Logfire |
| **模型网关** | LiteLLM | OpenRouter | Ollama（本地） |
| **本地模型** | Ollama + Qwen 2.5 7B | vLLM + Llama 3.3 | LM Studio |
| **外部协议** | MCP | OpenAI Functions | — |
| **协议选择** | Apache-2.0 | AGPL-3.0 | MIT |
| **PM 方法** | Shape Up（自研简化） | Linear 风格 | Trunk-Based |
| **PKM 方法** | 块 + Zettelkasten 链接 | BASB 兼容 | 通用 |
| **HITL 模式** | Static + Dynamic Interrupt | 工具级审批 | 置信度阈值 |
| **可视化** | Mermaid + 自研 Graph | D3.js | Cytoscape.js |

---

## 诚实声明

- 本文件中除已验证条目外的细节，**均为线索性资料**，引用前请 WebFetch 验证。
- 评分（如"性能 / 学习曲线"）为**主观判断**，仅供参考。
- 选型建议基于**2025–2026 主流共识**，不构成技术选型的硬性建议。
- 毕设最终选型应**结合具体需求 + 团队能力 + 时间预算**综合决策。