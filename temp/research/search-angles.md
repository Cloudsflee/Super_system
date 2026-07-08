# 研究方法：5 个搜索角度

> 本次研究采用 5 个并行搜索角度（来自 `deep-research` 工作流的 scope 阶段）。

## 一、5 个搜索角度

### 角度 1：学术理论与综述
- 关注：HCI / CSCW / 人机协作 / AI Agent 可解释性 / PKM（个人知识管理）等方向的论文与综述。
- 预期产出：Zettelkasten、Computer-Supported Cooperative Work、Explainable AI 等领域的核心理论。
- 本次命中：**Zettelkasten 卡片盒方法论**（C6 / C7，来自 takesmartnotes.com）。

### 角度 2：主流开源工具与生态
- 关注：自托管、协作、AI Agent 编排、知识管理领域的活跃开源项目。
- 预期产出：AppFlowy、TriliumNext、Logseq、Langfuse、LangGraph、CrewAI、AutoGen 等。
- 本次命中：**AppFlowy-Cloud**（C1 / C8 / C9）、**TriliumNext Notes**（C2 / C3 / C10 / C11）、**Logseq**（C4 / C5 / C12）。

### 角度 3：行业产品与商业案例
- 关注：面向"超级个体"的商业产品（GitHub Copilot Workspace、Notion AI、Linear、Raycast、Reflect、Heptabase 等）。
- 预期产出：商业产品形态、设计哲学、定价策略。
- 本次命中：（核验阶段 API 限流，未完成独立结论）。

### 角度 4：本地优先与 Agent 架构
- 关注：local-first software、agent orchestration、self-hostable AI stack。
- 预期产出：Ollama、vLLM、MCP、LangGraph 等。
- 本次命中：作为"线索性资料"汇总在 [`docs/concepts/agent-protocols-and-frameworks.md`](../docs/concepts/agent-protocols-and-frameworks.md)。

### 角度 5：设计哲学与专注机制
- 关注：flow / deep work / attention management / PKM 哲学。
- 预期产出：Zettelkasten、GTD、Building a Second Brain、Shape Up 等。
- 本次命中：**Zettelkasten 方法论**（C6 / C7）；TriliumNext / Logseq 的"个人知识库"哲学。

## 二、工作流时间线

| 阶段 | 内容 | 结果 |
|------|------|------|
| Scope | 分解为 5 个搜索角度 | ✓ |
| Search | 5 个并行 WebSearch agent | 每角度 6 条结果，共 30 条 |
| Filter | 去重后保留 novel | 5+6+4+2+3 = 20 条 |
| Fetch | 21 个来源抓取 | 25 条候选声明 |
| Verify | 3 票对抗式核验 | 12 CONFIRMED / 13 REFUTED |
| Synthesize | 合成报告 | ❌ API 429 速率上限，由人工接管 |

## 三、诚实声明

- 工作流在核验阶段遭遇 5 小时 API 速率上限，部分声明 3 票均弃权。
- "synthesize" 步骤失败后，由本会话基于 12 条 CONFIRMED 与日志中的搜索结果，手工合成 `docs/principles/*.md` 与 `docs/concepts/*.md`。
- 因此 `docs/principles/*.md` 的"第三节（线索性资料）"内容**不在工作流核验范围内**，仅作为下游阅读入口，引用前应自行验证。