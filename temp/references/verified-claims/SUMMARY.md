# 经对抗式核验的事实清单

> 本文件来自 `deep-research` 工作流的输出。
> 工作流对 25 条候选声明进行了 3 票对抗式核验：
> - **CONFIRMED（✓）**：≥2/3 核验者支持，证据可重复定位到一手或可靠二手来源。
> - **REFUTED（✗）**：≥2/3 核验者反对，或 3/3 弃权（视为未获支持）。
>
> 共 **12 条 CONFIRMED**、**13 条 REFUTED**。下游 `docs/principles/*.md` 文件仅引用 CONFIRMED 条目。

## 一、CONFIRMED 事实（12 条）

| # | 声明 | 投票 | 主来源 |
|---|------|------|--------|
| C1 | AppFlowy-Cloud 后端主要由 Rust 编写，客户端是 Flutter；是一个"超级个体/小团队"可自托管的跨平台协作栈。 | 3-0 ✓ | github.com/AppFlowy-IO/AppFlowy-Cloud |
| C2 | TriliumNext Notes 以"类文件系统"的树形层级组织笔记，适合构建大型个人知识库（PKM）。 | 3-0 ✓ | github.com/TriliumNext/Notes |
| C3 | TriliumNext Notes 支持基于 JavaScript 的脚本化扩展，便于高级用户自动化与定制行为。 | 3-0 ✓ | github.com/TriliumNext/Notes |
| C4 | Logseq 采用大纲优先、块结构（block-based outliner）PKM 范式，每条 bullet 都是独立块。 | 2-1 ✓ | logseq.com |
| C5 | Logseq 采用 AGPL-3.0 开源协议，支持本地优先（local-first）架构——数据以 Markdown 或 Org-mode 文件存储于本地。 | 3-0 ✓ | logseq.com |
| C6 | 卡片盒（Zettelkasten）是一种数字/物理归档体系，每条笔记有唯一 ID（如 `21/3d4a`），并通过链接而非分类构建上下文。 | 2-1 ✓ | takesmartnotes.com |
| C7 | 笔记应当被视作"发展论证的智识工具"而非被动转录；永久笔记必须包含脱离上下文仍可理解完整思想。 | 3-0 ✓ | takesmartnotes.com |
| C8 | AppFlowy-Cloud 的代码采用 AGPL-3.0 协议（copyleft）；这影响"超级个体"评估能否围绕自托管工作区进行商业化再分发。 | 2-1 ✓ | github.com/AppFlowy-IO/AppFlowy-Cloud |
| C9 | 截至仓库快照，AppFlowy-Cloud 有 1,918 stars、529 forks，最近一次 push 为 2026-05-16；表明这是一个活跃维护的、有一定社区的自托管协作后端。 | 2-1 ✓ | github.com/AppFlowy-IO/AppFlowy-Cloud |
| C10 | TriliumNext Notes 支持富文本、Markdown（含表格、图片、数学公式）、带语法高亮的代码笔记，以及完整的笔记版本历史，是面向个人使用的多模态 PKM 工具。 | 3-0 ✓ | github.com/TriliumNext/Notes |
| C11 | TriliumNext Notes 跨平台（桌面端 + 服务端），并内置 Task Manager；支持"超级个体"在统一工具中管理知识与任务。 | 3-0 ✓ | github.com/TriliumNext/Notes |
| C12 | Logseq 被定位为 Obsidian 与 Roam Research 的开源替代品，面向重视数据所有权与自托管的用户。 | 3-0 ✓ | logseq.com |

## 二、REFUTED 声明（13 条，仅记录不引用）

| 主题 | 结论 | 原因 |
|------|------|------|
| AppFlowy-Cloud = "leading open source Notion alternative" | ✗ | 0-3，未在仓库 README 直接复现该措辞 |
| AppFlowy-Cloud 的 "achieve more without losing control of your data" 标语 | ✗ | 0-3，未直接引用到原始来源 |
| Logseq 集成 daily journal + 间隔重复 flashcards | ✗ | 1-2，证据不足 |
| AgentGPT "pioneer of autonomous AI agents" 定位 | ✗ | 0-3 |
| AgentGPT "Assemble, configure, and deploy…" tagline | ✗ | 1-2 |
| AgentGPT 1.0.0 稳定版（2025 年 3 月） | ✗ | 0-0（弃权） |
| AgentGPT 大量特定 fork 用户名 | ✗ | 1-2 |
| AgentGPT 中文媒体定位为"自主 AI 代理的先锋" | ✗ | 0-0（弃权） |
| Zettelkasten 四类笔记（fleeting / literature / permanent / project）的具体处理规则 | ✗ | 1-2 |
| Zettelkasten "by building ideas one note at a time, shift from blank page to assembly" 命题 | ✗ | 0-0（弃权） |
| Zettelkasten 方法根植于 Niklas Luhmann 实践 | ✗ | 0-0（弃权） |
| Logseq 插件市场与订阅价格细节 | ✗ | 0-0（弃权） |
| TriliumNext ~33.3k stars + 起源细节 | ✗ | 0-3 |

## 三、原始一手/二手来源汇总

| 来源 | 类别 | 引用方式 |
|------|------|----------|
| https://github.com/AppFlowy-IO/AppFlowy-Cloud | 一手 | C1 / C8 / C9 |
| https://github.com/TriliumNext/Notes | 一手 | C2 / C3 / C10 / C11 |
| https://logseq.com/ | 一手 | C4 / C5 / C12 |
| https://takesmartnotes.com/ | 二手（方法论权威站点） | C6 / C7 |

> 备注：本工作流在核验阶段遭遇 5 小时 API 速率上限（HTTP 429），导致部分声明 3 票均弃权；为此本文件严格区分 **CONFIRMED（3-0 / 2-1）** 与 **REFUTED**。下游引用时只引用 CONFIRMED。
