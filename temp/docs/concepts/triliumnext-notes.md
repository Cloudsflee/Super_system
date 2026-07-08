# 工具研究：TriliumNext Notes

> 对应搜索角度：**主流开源工具与生态** / **设计哲学与专注机制**

## 一、摘要

TriliumNext Notes 是 Trilium Notes 的社区维护分支，是一个面向"个人 / 小团队"的可自托管笔记与知识管理工具。其设计哲学强调"树形层级 + 脚本扩展 + 完整版本历史"——它不仅是笔记软件，更是一个可编程的个人数据库。

## 二、已验证事实（来自 `references/verified-claims/SUMMARY.md`）

| # | 事实 | 投票 |
|---|------|------|
| C2 | 用树形层级组织笔记，适合构建大型个人知识库（PKM）。 | 3-0 ✓ |
| C3 | 支持基于 JavaScript 的脚本化扩展，便于高级用户自动化与定制行为。 | 3-0 ✓ |
| C10 | 支持富文本、Markdown（含表格、图片、数学公式）、带语法高亮的代码笔记、完整版本历史。 | 3-0 ✓ |
| C11 | 跨平台（桌面 + 服务端），并内置 Task Manager。 | 3-0 ✓ |

## 三、关键能力矩阵

| 能力 | 说明 |
|------|------|
| 数据结构 | 树形（hierarchy），每条笔记可有子笔记 |
| 内容模态 | 富文本 / Markdown / 代码 / Math（KaTeX）/ 图片 |
| 扩展能力 | JavaScript 脚本（前端 + 后端 API）、自定义 widgets |
| 任务管理 | 内置 Task Manager，每条任务 = 一条笔记 |
| 跨平台 | 桌面（Electron）+ 服务端（Node.js）+ 移动端（touch-optimized） |
| 版本历史 | 每条笔记自动保留完整 revision history |
| 协议 | AGPL-3.0 |

## 四、为何与本毕设高度相关

TriliumNext 是**几乎所有主旨都能命中**的全能型 PKM：
- **主旨 3（多模态）**：文本 / 代码 / 表格 / 图片 / Math 在同一笔记中（C10）。
- **主旨 4（去依赖）**：本地优先 + AGPL-3.0 + 自托管。
- **主旨 5（行为资产化）**：版本历史（C10）+ Task Manager（C11）把"行为"沉淀为可回溯资产。
- **主旨 1（透明化）**：JS 脚本扩展（C3）让行为可编程、可审阅。
- **主旨 8（生态集成）**：开放的 JS API 让社区扩展成为可能。

## 五、对毕设的启示

1. **"树 + 块 + 链接"是 PKM 数据结构的三个备选**——TriliumNext 选"树"作为骨架，Zettelkasten 选"链接"。毕设可考虑"块"作为主骨架（更接近 Logseq / Notion）。
2. **"脚本化扩展"是严肃 PKM 的入场券**——纯 GUI 不够，必须给"超级个体"提供可编程的扩展点（C3）。
3. **任务 = 笔记**是优雅的抽象——避免再开一个"任务模块"，而是复用笔记原语（C11）。
4. **版本历史是默认项，不是高级项**——C10 印证：版本历史应作为数据模型的一部分，而非"高级功能"。

## 六、参考来源

- TriliumNext Notes（已验证 C2/C3/C10/C11）: https://github.com/TriliumNext/Notes
- 官方 Wiki / Task Manager: https://github.com/TriliumNext/Notes/wiki/Task-manager
- 原 Trilium 项目: https://github.com/zadam/trilium
- 移动端文档: https://github.com/TriliumNext/Notes/wiki/Mobile-frontend
