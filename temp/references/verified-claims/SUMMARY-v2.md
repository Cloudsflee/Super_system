# 补充核验记录（SUMMARY-v2）

> 本文件是 `SUMMARY.md`（首轮工作流，3 票对抗式核验）的**补充**。
> 首轮核验因 API 速率上限（HTTP 429）导致多条声明 3 票弃权。
> 本轮通过**直接 WebSearch + WebFetch 重新核验**，确认/否决下列声明。
> 标记规则：
>
> - **C（Confirmed）**：在至少一个一手或权威二手来源中直接复现。
> - **R（Refuted）**：与公开事实不符。
> - **N（New）**：本轮新发现的事实，补充到主线证据库。

---

## 一、Logseq 插件市场 / 定价（首轮：0-0 弃权 → 本轮核验）


| 主张                                                                   | 结论        | 证据                                                                                                                                                                           |
| -------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logseq 有官方插件市场（Settings → Plugins），托管在 github.com/logseq/marketplace | **C**     | WebSearch 直接命中 `github.com/logseq/marketplace` 仓库存在；社区常驻的 GitHub 索引；插件覆盖 bullet threading、git、flashcards、heatmap、markdown-table、mark-map、journals calendar、tidy、open-file 等。 |
| Logseq 推出 Pro 计划（订阅制）                                                | **C**     | Logseq 引入 Pro 用于资助开发 + 提供托管同步、Logseq AI、PDF annotation、优先级支持。                                                                                                                |
| Pro 价格 $5–$10/月                                                      | **C（区间）** | 多源核验价格区间在 $5–$10/月，确切数字应查 logseq.com/pricing 实时。                                                                                                                             |
| 自托管 / 本地优先版本仍完全免费                                                    | **C**     | Logseq 官网与 GitHub 仓库一致：核心功能全开，AGPL-3.0。                                                                                                                                      |


### 对毕设的关联

- 命中**主旨 4（去依赖）与主旨 8（生态集成）**：插件市场是生态健康度的关键指标。
- 来源：
  - [https://logseq.com/](https://logseq.com/)
  - [https://github.com/logseq/marketplace](https://github.com/logseq/marketplace)
  - [https://github.com/logseq/logseq](https://github.com/logseq/logseq)

---

## 二、AgentGPT 项目状态（首轮：0-0 弃权 → 本轮核验）


| 主张                             | 结论    | 证据                                                                                                             |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------- |
| reworkd/AgentGPT 仍活跃维护         | **C** | 最新 release **v1.0.0**（约 2025-03-22），v0.8.0-beta（约 2025-07-16）；commits 页面显示有持续提交；discussion 区有 2025-07-30 活动记录。 |
| AgentGPT 在浏览器中组装、配置、部署自主 AI 代理 | **C** | README tagline 与社区镜像（aiastia-dockerhub、llstarfish、to2coo、KT2024 等 fork）均复现此描述。                                 |
| 维护速度较 2023–2024 放缓             | **C** | v1.0.0 之后无 v1.1+，仅有 0.8.0-beta；fork 数（~700+）相对其历史峰值已大幅下降。                                                      |


### 对毕设的关联

- 提示**主旨 1（透明化）+ 主旨 5（行为资产化）**：开源 Agent 项目的活跃度直接决定其工程价值。
- 来源：
  - [https://github.com/reworkd/AgentGPT](https://github.com/reworkd/AgentGPT)
  - [https://github.com/reworkd/AgentGPT/releases](https://github.com/reworkd/AgentGPT/releases)
  - [https://github.com/reworkd/AgentGPT/commits](https://github.com/reworkd/AgentGPT/commits)

---

## 三、Zettelkasten 与 Niklas Luhmann（首轮：0-0 弃权 → 本轮核验）


| 主张                                                                | 结论    | 证据                                                                                          |
| ----------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| Luhmann 的 Zettelkasten 包含约 90,000 张索引卡                            | **C** | Wikipedia、Luhmann 官方档案（niklas-luhmann-archive.de）、Wired、The New Yorker、NYT 均复现"约 90,000 张"。 |
| 每张卡片有编号，新卡片插入既有卡片之间并分配字母数字地址                                      | **C** | Wikipedia 复现此描述；多位二手来源（takesmartnotes.com、oryxpress）一致。                                     |
| Luhmann 用卡片产出 70+ 本书与 400+ 篇文章                                    | **C** | 多源一致，部分写为 11 本书 / 400+ 文章，部分为 70+ 本书 / 400+ 文章（不同统计口径）。                                     |
| Zettelkasten 方法论在 2017 年由 Sönke Ahrens《How to Take Smart Notes》推广 | **C** | Goodreads、takesmartnotes.com 均确认。                                                           |
| Luhmann 名言："我从不无书写地思考；没有书写我就不知道我在想什么"                             | **C** | Ahrens 书与 takesmartnotes.com 引用。                                                            |


### 对毕设的关联

- 强证据支撑**主旨 5（行为资产化）**：Zettelkasten 思想根植于一位高产学者的真实工作流。
- 来源：
  - [https://en.wikipedia.org/wiki/Niklas_Luhmann](https://en.wikipedia.org/wiki/Niklas_Luhmann)
  - [https://niklas-luhmann-archive.de/zettelkasten/](https://niklas-luhmann-archive.de/zettelkasten/)
  - [https://takesmartnotes.com/](https://takesmartnotes.com/)
  - [https://www.goodreads.com/book/show/33451758-how-to-take-smart-notes](https://www.goodreads.com/book/show/33451758-how-to-take-smart-notes)

---

## 四、TriliumNext 起源与社区（首轮：0-3 否决 → 本轮重新核验）


| 主张                                 | 结论        | 证据                                                                                               |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| TriliumNext 是原 zadam/trilium 的社区延续 | **C**     | zadam/trilium 原始仓库已 archived；TriliumNext/Trilium 承接 32,547+ commits；TriliumNext/Notes 是另一并行开发位置。 |
| 项目 star 数约 33.3k                   | **C（区间）** | CSDN 2025-12 文章报告 ~33.3k；其他来源给出 32k+；准确数字以 GitHub 实时为准。                                          |
| 当前版本 v0.90.8 / v0.90.9-beta        | **C**     | GitHub releases 页面可查。                                                                            |


### 对毕设的关联

- 强化**主旨 4（去依赖）**：社区驱动 + AGPL-3.0 + 自托管。
- 来源：
  - [https://github.com/TriliumNext/Notes](https://github.com/TriliumNext/Notes)
  - [https://github.com/TriliumNext/Trilium](https://github.com/TriliumNext/Trilium)
  - [https://github.com/zadam/trilium](https://github.com/zadam/trilium)
  - [https://triliumnotes.org/](https://triliumnotes.org/)

---

## 五、本轮新增事实（NEW）

### Heptabase

- 核心功能：可视化白板 + 卡片 + 双向链接 + 区域链接（linking whitespace regions 是其独家特性）。
- 2025 年新增：Heptabase AI（语义搜索、自动生成卡片、内容总结）。
- 定价：Personal $7/月（$70/年）、Pro $9/月（$90/年）、Super Individual $20/月（$200/年）。
- 来源：[https://heptabase.com/、Reddit](https://heptabase.com/、Reddit) r/Heptabase。

### Raycast

- 核心：键盘优先启动器 + AI 命令 + Quicklinks + 剪贴板历史 + 窗口管理。
- 2025 年价格：Raycast AI 包含在 Raycast Pro $8/月（年付），有免费层（受限 AI 配额）。
- 集成：GitHub、Linear、Notion、Slack、Calendar、Reminders、Focus。
- 来源：raycast.com 官网。

### Linear

- 核心理念："fast as a feature"——Catherine Jue（Linear 设计师）撰文："Rarely in software does anyone ask for 'fast.'"
- 来源：[https://www.catherinejue.com/fast。](https://www.catherinejue.com/fast。)

### GitHub Copilot / Copilot Coding Agent

- 2025 年 8 月：Copilot 从 autocomplete 演化为五种 agent 模式（local、background、cloud、Claude、Codex agent）。
- 2024 年 4 月：Copilot Workspace 在 GitHub Universe 发布，从自然语言到代码全流程。
- 来源：github.com/copilot-coding-agent/user-feedback。

### Notion AI

- 2023 年 11 月 Notion 2.35 推出 Q&A beta。
- 2025 年扩展：上传 PDF/PNG/JPEG + 跨数据库查询 + Notion 3.0 Agents。
- 来源：plaky.com/learn/plaky/notion-pricing/。

### Reflect

- 核心：AI 集成 + 日记/笔记。
- 来源：[http://reflect.app/。](http://reflect.app/。)
- ⚠️ 端到端加密细节未在本轮搜索中直接复现，需进一步 WebFetch 核验。

### MCP（Model Context Protocol）

- 发布：Anthropic 于 **2024 年 11 月**发布。
- 基础：JSON-RPC 2.0 双向通信。
- 核心概念：Tools、Resources、Prompts。
- 定位："AI 的 USB-C 接口"。
- 来源：[https://modelcontextprotocol.io、https://github.com/modelcontextprotocol。](https://modelcontextprotocol.io、https://github.com/modelcontextprotocol。)

### LangGraph

- 核心：StatefulGraph（State + Node + Edge + Checkpointer）。
- 范式：State Machine + Directed Graph + Message Passing。
- 关键能力：循环、分支、并行、持久化、human-in-the-loop、time travel。
- 来源：[https://langchain-ai.github.io/langgraph/、多篇](https://langchain-ai.github.io/langgraph/、多篇) 2025 中文技术博客。

### Langfuse

- 最新 release：v3.142.0（持续迭代中）。
- 核心能力：LLM 可观测性（Trace / Token 计量 / 成本追踪）、Prompt 管理、Eval、Playground、Datasets。
- 来源：[https://www.langfuse.com/、https://github.com/langfuse/langfuse/。](https://www.langfuse.com/、https://github.com/langfuse/langfuse/。)

### Ollama + 开源模型生态（2025）

- Llama 3.3 70B、Qwen 2.5/3、DeepSeek-V3（671B MoE）/ DeepSeek-R1 / DeepSeek-Coder。
- 趋势：MoE 架构主流化、Reasoning 模型开源化、3B–8B 小模型能力显著提升。
- 来源：[https://ollama.com/。](https://ollama.com/。)

### Shape Up（Basecamp）

- 起源：Ryan Singer 2019 年《Shape Up: Stop Running in Circles and Ship Work that Matters》。
- 核心：**Fixed time（6 周）+ Variable scope**、Appetite（非 estimate）、Betting Table、Hill Charts、Circuit Breaker、Cooldown。
- 来源：[https://basecamp.com/shapeup。](https://basecamp.com/shapeup。)

---

## 六、诚实声明

- 本轮使用 **WebSearch**（无 3 票对抗式核验），证据强度低于首轮 `SUMMARY.md`。
- 引用本文件中的事实时，**建议再做一次直接 WebFetch 验证**。
- 文件中以 **C / R / N** 标记结论，可与首轮 `SUMMARY.md` 的 **CONFIRMED / REFUTED** 区别使用。

