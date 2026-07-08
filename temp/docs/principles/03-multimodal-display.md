# 用户侧主旨 3：多模态展示

> "针对不同的业务需求与场景，系统能够**自适应切换**不同的展示形态。"

## 一、摘要

"多模态展示"在本系统中至少有三层含义：
1. **内容模态**：同一份信息可用文本、表格、图、思维导图、看板、代码块、对话流等不同形式呈现。
2. **交互模态**：CLI / GUI / TUI / 对话 / 快捷键等不同入口。
3. **载体模态**：桌面 / 移动 / Web / 命令行 / IDE 插件。

"自适应切换"意味着系统应当**根据上下文**（用户意图、当前任务、设备能力）选择最合适的模态，而不是把同一个渲染硬塞到所有场景。

## 二、已验证事实

| # | 事实 | 与本主旨的关联 |
|---|------|----------------|
| C4 | Logseq 是大纲优先、块结构（block-based outliner），每条 bullet 都是独立块。 | "块"是支持"多视图渲染同一内容"的关键抽象——一个块可以在大纲、卡片、表格、Graph 中分别呈现。 |
| C5 | Logseq 本地优先，数据为 Markdown / Org-mode。 | 文件格式中立 = 输出中立 = 易于做多模态适配。 |
| C10 | TriliumNext Notes 支持富文本、Markdown（含表格、图片、数学公式）、带语法高亮的代码笔记。 | 同一份笔记可在多种内容模态间无缝切换。 |
| C11 | TriliumNext Notes 跨平台（桌面端 + 服务端）+ 内置 Task Manager。 | 载体模态与内容模态解耦。 |

## 三、相关方法与工具（线索性记录）

- **Notion / AppFlowy / Anytype / Affine**：块结构 + 多种视图（表格、看板、列表、日历、图谱）。
- **Tldraw / Excalidraw / Heptabase**：以"白板/图谱"为骨架的自由模态组织。
- **Raycast / Linear / Reflect**："超级个体"工具的代表——把任务、笔记、AI 命令统一在命令面板/快捷键驱动下。
- **MCP（Model Context Protocol）**：Anthropic 提出的"模型 ↔ 工具"协议，本质上是一种"交互模态"层。

## 四、对毕设的启示

1. **以"块"为底层数据单元**——这是实现多模态展示的最务实的工程方案（参考 Logseq 的 C4 / Notion / AppFlowy）。
2. **视图是数据的函数**——`view = f(data, context)`；建议把"上下文"显式建模（设备类型、用户意图、当前任务阶段）。
3. **保留"原始数据 + 渲染层"边界**——C5 的启示：数据中立存储、渲染层多样化。避免"特色功能"被锁死在某个编辑器里。
4. **对话 UI 不应取代结构化 UI**——对话是"输入意图"的模态，但"输出/管理/查询"仍需结构化界面（表格、看板、Graph）。

## 五、参考来源

- Logseq（已验证 C4/C5）: https://logseq.com/
- TriliumNext Notes（已验证 C10/C11）: https://github.com/TriliumNext/Notes
- AppFlowy: https://appflowy.io/
- Heptabase: https://heptabase.com/
- Raycast: https://www.raycast.com/
- Model Context Protocol: https://modelcontextprotocol.io/

> ⚠️ 本文件中"第三节"内容为本工作流范围之外的线索性资料，未做对抗核验。
