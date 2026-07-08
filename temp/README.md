# 面向「超级个体」的高效协作系统 — 研究资料库

> **毕设选题研究**：本目录汇总与毕设选题相关的学术、开源、行业与设计资料，按 8 条核心主旨有序组织。
>
> 选题原文：`./temp.md`

---

## 一、目录结构

```
00_desktop/temp/
├── README.md                         ← 本文件（入口）
├── temp.md                            ← 选题原文（8 条核心主旨）
├── docs/
│   ├── principles/                   ← 8 条主旨的逐条研究（核心交付物）
│   │   ├── 01-ai-workflow-transparency.md
│   │   ├── 02-flat-organization-contribution.md
│   │   ├── 03-multimodal-display.md
│   │   ├── 04-lightweight-vendor-independence.md
│   │   ├── 05-behavior-as-asset.md
│   │   ├── 06-refactor-cost-quantification.md
│   │   ├── 07-de-formalize-pm.md
│   │   └── 08-ecosystem-integration.md
│   └── concepts/                     ← 单点概念 / 工具研究（26 个文件）
│       ├── zettelkasten.md
│       ├── appflowy-cloud.md
│       ├── triliumnext-notes.md
│       ├── logseq.md
│       ├── agent-protocols-and-frameworks.md
│       ├── heptabase.md
│       ├── raycast.md
│       ├── linear.md
│       ├── github-copilot-coding-agent.md
│       ├── notion-ai.md
│       ├── reflect-app.md
│       ├── langfuse.md
│       ├── mcp-model-context-protocol.md
│       ├── langgraph.md
│       ├── ollama-open-source-models.md
│       ├── shape-up.md
│       ├── swe-bench.md
│       ├── local-first-software.md    ← 新增：local-first 7 原则
│       ├── human-in-the-loop-design.md ← 新增：HITL 工程模式
│       ├── building-a-second-brain.md ← 新增：BASB / CODE 方法
│       ├── anytype-affine-privacy-pkm.md ← 新增：E2EE PKM 三剑客
│       ├── crdt-collaborative-editing.md ← 新增：CRDT 协同编辑
│       ├── pydantic-ai-logfire.md    ← 新增：强类型 AI 工具栈
│       ├── edge-ai-inference.md      ← 新增：边缘 AI / 端侧推理
│       ├── rag-vector-databases.md   ← 新增：RAG 与向量数据库
│       └── benchmark-evaluation.md   ← 新增：基准与评估方法
├── research/                         ← 搜索角度与研究方法记录
│   └── search-angles.md
├── references/                       ← 引用与核验记录
│   ├── verified-claims/
│   │   ├── SUMMARY.md                ← 首轮工作流 12 CONFIRMED + 13 REFUTED
│   │   └── SUMMARY-v2.md             ← 补充核验（Logseq 插件 / AgentGPT / Luhmann 等）
│   ├── academic-references.md        ← 新增：学术参考文献清单（论文、书、规范）
│   ├── comparison-matrices.md        ← 新增：评估矩阵与对比表（10 类）
│   └── related-research/
│       ├── INTEGRATION-NOTE.md       ← 外部研究报告对照表
│       └── gemini-research-report.md ← 外部报告：超级个体公司视角 + 4 条候选主旨
└── tools/                            ← 工具与产品速查
    └── INDEX.md
```

---

## 二、按 8 条核心主旨速查

### 用户侧（5 条）

| # | 主旨 | 研究文件 | 关键启示 |
|---|------|----------|----------|
| 1 | **AI 工作流透明化** | [01-ai-workflow-transparency.md](./docs/principles/01-ai-workflow-transparency.md) | OTel GenAI SIG + OpenLLMetry；Step-card 渲染决策路径 |
| 2 | **扁平化与贡献量化** | [02-flat-organization-contribution.md](./docs/principles/02-flat-organization-contribution.md) | SPACE / DORA；事件驱动量化 |
| 3 | **多模态展示** | [03-multimodal-display.md](./docs/principles/03-multimodal-display.md) | 块结构数据模型；`view = f(data, context)` |
| 4 | **轻量化与去依赖** | [04-lightweight-vendor-independence.md](./docs/principles/04-lightweight-vendor-independence.md) | Rust + Flutter（C1）；AGPL-3.0（C8） |
| 5 | **行为资产化** | [05-behavior-as-asset.md](./docs/principles/05-behavior-as-asset.md) | Zettelkasten 范式（C6/C7）；沉淀-链接-触发 |

### 开发侧（3 条）

| # | 主旨 | 研究文件 | 关键启示 |
|---|------|----------|----------|
| 6 | **重构成本定量化** | [06-refactor-cost-quantification.md](./docs/principles/06-refactor-cost-quantification.md) | SWE-bench；Token 成本函数 |
| 7 | **去形式化设计管理** | [07-de-formalize-pm.md](./docs/principles/07-de-formalize-pm.md) | Shape Up；可观测替代周报 |
| 8 | **生态集成** | [08-ecosystem-integration.md](./docs/principles/08-ecosystem-integration.md) | MCP + OTel + Git；协议 > 框架 |

---

## 三、按概念 / 工具速查

### 3.1 方法论 / 开源 PKM / 协作后端（首轮已验证）

| 概念 | 文件 | 命中的已验证事实 |
|------|------|-----------------|
| Zettelkasten（卡片盒） | [zettelkasten.md](./docs/concepts/zettelkasten.md) | C6 / C7 + N（90,000 卡、Luhmann、Ahrens） |
| AppFlowy-Cloud | [appflowy-cloud.md](./docs/concepts/appflowy-cloud.md) | C1 / C8 / C9 |
| TriliumNext Notes | [triliumnext-notes.md](./docs/concepts/triliumnext-notes.md) | C2 / C3 / C10 / C11 + N（社区 fork、33.3k stars） |
| Logseq | [logseq.md](./docs/concepts/logseq.md) | C4 / C5 / C12 + N（插件市场、Pro 定价） |
| Agent 协议与编排框架 | [agent-protocols-and-frameworks.md](./docs/concepts/agent-protocols-and-frameworks.md) | （线索性） |

### 3.2 行业产品案例（本轮补充）

| 概念 | 文件 | 关键启示 |
|------|------|----------|
| Heptabase | [heptabase.md](./docs/concepts/heptabase.md) | "Super Individual" 商业档；白板+卡片+图谱 |
| Raycast | [raycast.md](./docs/concepts/raycast.md) | 启动器作为统一入口；AI Commands / Presets |
| Linear | [linear.md](./docs/concepts/linear.md) | "fast as a feature"；键盘优先 |
| GitHub Copilot / Coding Agent | [github-copilot-coding-agent.md](./docs/concepts/github-copilot-coding-agent.md) | 5 种 Agent 模式；Issue → PR 全流程 |
| Notion AI | [notion-ai.md](./docs/concepts/notion-ai.md) | Q&A 跨工作空间；Notion 3.0 Agents |
| Reflect | [reflect-app.md](./docs/concepts/reflect-app.md) | 日记 + 双向链接 + AI 集成 |

### 3.3 核心工具深度研究（本轮补充）

| 概念 | 文件 | 关键启示 |
|------|------|----------|
| Langfuse | [langfuse.md](./docs/concepts/langfuse.md) | 开源 LLM 可观测；Token/成本追踪 |
| MCP | [mcp-model-context-protocol.md](./docs/concepts/mcp-model-context-protocol.md) | Anthropic 2024-11；AI 的 USB-C |
| LangGraph | [langgraph.md](./docs/concepts/langgraph.md) | 有向图 + State + Checkpointer |
| Ollama + 开源模型 | [ollama-open-source-models.md](./docs/concepts/ollama-open-source-models.md) | 本地 LLM；Llama/Qwen/DeepSeek |
| Shape Up | [shape-up.md](./docs/concepts/shape-up.md) | Fixed time + Variable scope |
| SWE-bench | [swe-bench.md](./docs/concepts/swe-bench.md) | 等价改写测试集范本 |

### 3.4 理论根基与并发协同（本轮新增）

| 概念 | 文件 | 关键启示 |
|------|------|----------|
| Local-First Software | [local-first-software.md](./docs/concepts/local-first-software.md) | Kleppmann 等 2019；7 大原则 |
| Human-in-the-Loop | [human-in-the-loop-design.md](./docs/concepts/human-in-the-loop-design.md) | HITL 4 大模式；候选主旨 9 工程化 |
| Building a Second Brain | [building-a-second-brain.md](./docs/concepts/building-a-second-brain.md) | Tiago Forte；CODE + PARA |
| Anytype / Affine / Standard Notes | [anytype-affine-privacy-pkm.md](./docs/concepts/anytype-affine-privacy-pkm.md) | E2EE PKM 三剑客对比 |
| CRDT | [crdt-collaborative-editing.md](./docs/concepts/crdt-collaborative-editing.md) | Yjs / Automerge / Loro |
| Pydantic AI / Logfire | [pydantic-ai-logfire.md](./docs/concepts/pydantic-ai-logfire.md) | 强类型 AI；候选主旨 9/12 工具栈 |
| Edge AI / 端侧推理 | [edge-ai-inference.md](./docs/concepts/edge-ai-inference.md) | 量化；端侧 3B-8B 模型 |
| RAG 与向量数据库 | [rag-vector-databases.md](./docs/concepts/rag-vector-databases.md) | 候选主旨 11 基础设施 |
| AI 基准与评估 | [benchmark-evaluation.md](./docs/concepts/benchmark-evaluation.md) | SWE-bench / HumanEval / AgentBench |

### 3.5 选型与参考文献（本轮新增）

- 评估矩阵与对比表：[references/comparison-matrices.md](./references/comparison-matrices.md)（10 类对比：PKM / Agent 框架 / 可观测 / 模型运行时 / PM 工具 / 行业产品 / CRDT / PKM 方法 / Agent 协议 / 选型总图）
- 学术参考文献清单：[references/academic-references.md](./references/academic-references.md)（论文 / 书 / 规范，GB/T 7714 + APA 7 双格式）

工具速查表：[tools/INDEX.md](./tools/INDEX.md)

---

## 四、研究方法说明

1. **搜索角度**：本次研究采用 5 个并行搜索角度：
   - 学术理论与综述
   - 主流开源工具与生态
   - 行业产品与商业案例
   - 本地优先与 Agent 架构
   - 设计哲学与专注机制

   详见 [research/search-angles.md](./research/search-angles.md)。

2. **事实核验**（两轮）：
   - **首轮**：`deep-research` 工作流对 25 条候选声明进行 3 票对抗式核验：
     - **CONFIRMED：12 条**（3-0 或 2-1 通过）
     - **REFUTED：13 条**（0-3 / 1-2 / 0-0 弃权）
     - 记录：[references/verified-claims/SUMMARY.md](./references/verified-claims/SUMMARY.md)
   - **第二轮（本轮）**：因首轮核验遭遇 API 429 速率上限导致部分声明 3 票弃权，本轮用 WebSearch 重新核验关键声明：
     - Logseq 插件市场与 Pro 定价
     - AgentGPT 项目状态
     - Zettelkasten 与 Luhmann 的历史联系
     - TriliumNext 起源
     - 同时补充了 12 个新工具/产品的研究
     - 记录：[references/verified-claims/SUMMARY-v2.md](./references/verified-claims/SUMMARY-v2.md)

3. **诚实声明**：
   - 首轮工作流的"3 票对抗式核验"强度高于第二轮 WebSearch 核验。
   - `docs/principles/*.md` 的"第三节（相关方法与工具）"是**线索性资料**，未做对抗核验，仅作阅读入口。
   - `docs/concepts/*.md` 中标注"已验证"的事实来自 SUMMARY.md / SUMMARY-v2.md；标注"⚠️"的事实需进一步核验。
   - 引用任何事实前，建议再次通过一手来源确认。

---

## 五、阅读路径建议

- **快速了解毕设主旨**：从 [`temp.md`](./temp.md) 开始，按本文档"第二节"链接阅读 8 个 principle 文件。
- **想找具体工具 / 产品**：直接看 [`tools/INDEX.md`](./tools/INDEX.md) 或 `docs/concepts/` 下 17 个概念文件。
- **想用"事实"支撑毕设论文 / 答辩**：先看 [`references/verified-claims/SUMMARY.md`](./references/verified-claims/SUMMARY.md) 的 12 条 CONFIRMED（首轮对抗式核验），再看 [`SUMMARY-v2.md`](./references/verified-claims/SUMMARY-v2.md) 的本轮补充事实。
- **想了解核验方法 / 信任度**：看 [`references/verified-claims/`](./references/verified-claims/) 两个文件的第二、三节。
- **想了解"超级个体公司"视角的扩展主旨**：看 [`references/related-research/`](./references/related-research/)（外部研究报告及其与本研究的对照表，新增 4 条候选主旨）。

---

## 六、元信息

- 选题：**面向「超级个体」的高效协作系统**
- 研究日期：2026-06-27
- 研究方式：
  - **首轮**：`deep-research` 工作流 + 手工合成（核验阶段遭遇速率上限后由人工接管合成）。
  - **第二轮**：直接 WebSearch 重新核验关键声明 + 补充 11 个行业产品 / 工具深度研究。
  - **第三轮（本轮）**：发散补充 9 个理论根基 / 协同 / 评估概念 + 10 类对比矩阵 + 学术参考文献清单。
- 撰写语言：中文（与选题原文保持一致）
- 当前规模：33 个 Markdown 文件 → **42 个 Markdown 文件**（本轮 +9 个概念 + 2 个参考文献）