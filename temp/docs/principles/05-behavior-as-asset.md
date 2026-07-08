# 用户侧主旨 5：行为资产化

> "沉淀老成员的工作行为并**抽象为数字资产**，用于团队复盘与新成员的快速学习。"

## 一、摘要

"行为资产化"把"老成员如何工作"从**隐性知识**（tacit knowledge）转化为**可检索、可重放、可教学**的显性资产。工程上它要求：
- 行为日志完整、可索引；
- 行为可抽象为"模式"（workflow / snippet / prompt / agent-graph）；
- 资产可被新成员低门槛消费（搜得到、学得会、跑得通）。

这是 Zettelkasten / PKM 思想在"团队级别"的延伸。

## 二、已验证事实

| # | 事实 | 与本主旨的关联 |
|---|------|----------------|
| C2 / C10 | TriliumNext Notes 用树形结构组织笔记，支持富文本/Markdown/代码/Math。 | 提供了"知识资产"的容器范式：版本化、跨模态、可搜索。 |
| C3 | TriliumNext Notes 支持 JavaScript 脚本扩展。 | 启示：行为可被"脚本化"为可重放的资产——一旦工作流稳定下来，就可被新成员"运行"而非"学习"。 |
| C6 / C7 | Zettelkasten 链接而非分类；永久笔记"脱离上下文可理解"。 | 资产化的关键特征：可独立单元、可被链接到新上下文。 |
| C11 | TriliumNext Notes 跨平台 + 内置 Task Manager。 | 资产既能"沉淀"（笔记）又能"触发"（任务），形成"知行合一"的工作环境。 |

## 三、相关方法与工具（线索性记录）

- **Zettelkasten / PKM 工具链**：Obsidian、Logseq、Roam、TriliumNext、Heptabase、Reflect、Notion。
- **Prompt / Workflow 资产化**：PromptLayer、LangSmith Hub、PromptFoo、OpenAI Cookbook、Anthropic Prompt Library。
- **过程录制 / 工作流回放**：Screenpipe、Rewind (Limitless)、Zed 协作录制、VS Code Live Share。
- **On-call 知识库**：incident.io、FireHydrant、Rootly ——把"故障处置过程"沉淀为可重放的剧本。
- **DACI / RACI → "剧本库"**：把"决策模式"结构化。

## 四、对毕设的启示

1. **行为资产的最小单元**——"可独立运行的工件"：一个命令、一段 prompt、一个 agent graph、一份 on-call runbook。C7 的启示：每个资产都要"脱离上下文可理解"，否则就是死链。
2. **"沉淀-链接-触发"三段式**——沉淀（versioned storage）+ 链接（cross-references）+ 触发（executable）。TriliumNext 的 Task Manager（C11）演示了"沉淀的知识"如何被"触发为任务"。
3. **新成员"快速学习"的工程方案**——
   - **可搜索**：全文 + 语义 + 标签三元索引。
   - **可预览**：每个资产有 README / 演示 / 截图。
   - **可运行**：资产 = 文档 + 可执行单元（脚本 / Agent / 命令）。
   - **可反馈**：新成员可对资产评分/评论，形成"资产代谢"。
4. **避免"知识腐烂"**——C9 提醒：资产库本身需要"行为记录"驱动维护（哪些资产被引用最多？哪些已 6 个月未被使用？）。

## 五、参考来源

- TriliumNext Notes（已验证 C2/C3/C10/C11）: https://github.com/TriliumNext/Notes
- takesmartnotes.com（已验证 C6/C7）: https://takesmartnotes.com/
- Obsidian: https://obsidian.md/
- PromptFoo: https://promptfoo.dev/
- LangSmith Hub: https://docs.smith.langchain.com/hub

> ⚠️ 本文件中"第三节"内容为本工作流范围之外的线索性资料，未做对抗核验。
