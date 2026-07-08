# 工具研究：Logseq

> 对应搜索角度：**主流开源工具与生态** / **本地优先与 Agent 架构** / **设计哲学与专注机制**

## 一、摘要

Logseq 是一个"隐私优先、本地优先"的开源知识管理与协作平台，采用"块结构大纲"（block-based outliner）作为底层数据模型。数据以纯文本 Markdown 或 Org-mode 文件存储于本地，用户完全拥有自己的数据。它被广泛认为是 Obsidian 与 Roam Research 的开源替代品。

## 二、已验证事实（来自 `references/verified-claims/SUMMARY.md`）

| # | 事实 | 投票 |
|---|------|------|
| C4 | 大纲优先、块结构 PKM，每条 bullet 都是独立块。 | 2-1 ✓ |
| C5 | AGPL-3.0 开源协议 + 本地优先，数据为 Markdown / Org-mode 纯文本。 | 3-0 ✓ |
| C12 | 被定位为 Obsidian / Roam Research 的开源替代品。 | 3-0 ✓ |

## 三、关键能力矩阵

| 能力 | 说明 |
|------|------|
| 数据结构 | 块（block），每条 bullet 是一个独立单元 |
| 存储格式 | 本地纯文本文件（`.md` 或 `.org`） |
| 协议 | AGPL-3.0（开源核心） |
| 视图 | 大纲 / 全文搜索 / 关系图（Graph）/ 闪卡 / 日记流 |
| 插件 | 插件市场（开放 API） |
| 同步 | 自托管（HTTP 同步服务器）+ 官方云（订阅） |
| 跨平台 | 桌面 + 移动端 + Web |

## 四、为何与本毕设高度相关

Logseq 同时命中**几乎所有主旨**：
- **主旨 3（多模态展示）**：块结构让同一数据可在大纲 / Graph / 表格 / Flashcards 中自由呈现（C4）。
- **主旨 4（去依赖 / 轻量化）**：纯文本存储 + AGPL-3.0（C5）= 终极可移植 + 不被锁定。
- **主旨 5（行为资产化）**：日记流 + 闪卡 + 关系图 = 个人行为的完整沉淀。
- **主旨 7（去形式化 PM）**：任务 = 块，状态 = 链接，与 Linear / Heptabase 哲学相通。
- **主旨 12（开源替代）**：C12 直接呼应。

## 五、对毕设的启示

1. **"块"是数据模型的"超级抽象"**——比"树"更灵活，比"图"更简单。C4 印证：几乎所有现代 PKM（Notion / AppFlowy / Heptabase / Logseq）都最终收敛到"块"。
2. **纯文本是"终极数据格式"**——Markdown / Org-mode 是"几十年可读"的格式（C5）。毕设若想 10 年后仍可用，请用纯文本。
3. **本地优先 ≠ 不联网**——Logseq 同时提供自托管和云订阅——这是"去依赖"的正确姿态：默认本地，可选云。
4. **开源是"反 SaaS 锁定"的最强叙事**——C12 直接对应此点。

## 六、参考来源

- Logseq 官网（已验证 C4/C5/C12）: https://logseq.com/
- GitHub 仓库: https://github.com/logseq/logseq
- 协议说明: https://github.com/logseq/logseq/blob/master/LICENSE
- 插件市场: https://github.com/logseq/logseq-plugins
- 对比评测: https://logseq.com/blog/compare-logseq/
