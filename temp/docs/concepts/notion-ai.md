# 产品研究：Notion AI

> 对应搜索角度：**行业产品与商业案例** / **本地优先与 Agent 架构**

## 一、摘要

Notion AI 是 Notion 工作空间的 AI 集成层。它不是单独的 chatbot，而是把 AI 嵌入到文档、数据库、搜索、自动化等所有 Notion 操作中。2025 年的"Notion 3.0 Agents"标志着 Notion 从"AI 加成的工作空间"转向"AI 优先的工作空间"。

## 二、本轮核验事实

| # | 事实 | 证据 |
|---|------|------|
| N1 | 2023-11 Notion 2.35 推出 Q&A beta：自然语言跨工作空间搜索。 | Notion 官方 changelog。 |
| N2 | 2025 年扩展 Q&A：上传 PDF/PNG/JPEG 文件 → AI 分析 + 翻译。 | Notion 官方博客。 |
| N3 | Notion 3.0 Agents：可执行多步工作流 + 跨数据库查询。 | Notion 官方发布。 |
| N4 | 智能提示与自动化：页面内 AI 建议 + 自定义 AI block。 | Notion 文档。 |

## 三、为何与本毕设高度相关

- **主旨 1（透明化）**：Q&A 把"找信息"的过程从"翻文档树"变成"问 → 答案 + 引用源"，决策路径可见。
- **主旨 2（贡献量化）**：Notion 中的"创建/编辑/评论"事件流是天然的贡献日志。
- **主旨 3（多模态）**：Notion 块结构（C4 / Logseq 同源）支持文档、表格、看板、Database、时间线、PDF、白板。
- **主旨 8（生态集成）**：Notion API 是第三方集成的常见接入层。

## 四、对毕设的启示

1. **AI 嵌入到既有工作流，而非独立 chatbot**——这是 Notion AI 与 ChatGPT 的关键差异。毕设应当把 AI 嵌入到任务/笔记/文档流。
2. **Q&A 是杀手特性**——把"知识库搜索"做成"自然语言问答 + 引用源"，是新成员"快速学习"的工程方案（呼应**主旨 5**）。
3. **AI Agent 应能"执行多步"**——Notion 3.0 Agents 把"建议"升级为"执行"，这是 2025 年的设计基线。
4. **注意：Notion 是 SaaS + 闭源**——与毕设**主旨 4（去依赖）**方向相反，应作为"反例"参考：哪些 Notion 特性值得开源版借鉴，哪些不值得。

## 五、参考来源

- Notion AI 官网: https://www.notion.so/product/ai
- Notion 2.35 Q&A 介绍: https://www.notion.so/releases/2023-11-16
- Notion 定价 2025 综述: https://plaky.com/learn/plaky/notion-pricing/
- Notion AI 中文介绍: https://ai-bot.cn/sites/189.html

> ⚠️ 本文件为本轮补充核验资料，未做 3 票对抗式核验。
