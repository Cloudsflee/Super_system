# 用户侧主旨 4：轻量化与去依赖

> "追求'小而美'的架构，**不高度依赖**特定大厂模型（如 OpenAI），强调系统自身的逻辑设计。"

## 一、摘要

"去依赖"在本系统中既包括**模型层去依赖**（不绑定 OpenAI / Anthropic / 单一闭源模型），也包括**组件层去依赖**（数据库、中间件、UI 框架都应可替换）。这与"自我托管"（self-hostable）密切相关：能自托管的系统几乎必然是去依赖的；反之未必。

## 二、已验证事实

| # | 事实 | 与本主旨的关联 |
|---|------|----------------|
| C1 | AppFlowy-Cloud 后端用 Rust，客户端用 Flutter；可自托管的跨平台协作栈。 | "小而美 + 可自托管"的典型工程范式：单一二进制后端 + 跨平台原生客户端。 |
| C5 | Logseq 本地优先，数据为 Markdown / Org-mode 纯文本文件。 | 模型/数据库去依赖：用户数据用最朴素的格式存储，工具随时可换。 |
| C8 | AppFlowy-Cloud 代码采用 AGPL-3.0 协议。 | copyleft 协议本身是"去依赖"的法律保障——确保下游无法闭源化形成新的单一依赖。 |
| C9 | AppFlowy-Cloud 活跃维护（1,918 stars / 529 forks / 2026-05-16 push）。 | 社区活跃 = 去依赖后有人维护 = 不被单点风险击穿。 |
| C12 | Logseq 被定位为 Obsidian / Roam Research 的开源替代品。 | "反 SaaS 锁定"是用户侧去依赖的核心叙事。 |

## 三、相关方法与工具（线索性记录）

- **Ollama / LM Studio / vLLM / llama.cpp**：本地运行开源模型的工具链，让"不依赖 OpenAI"在工程上可行。
- **OpenRouter / LiteLLM / Portkey**：统一多家模型 API 入口，提供 fallback 与路由——这是"模型层去依赖"的关键中间层。
- **Postgres / SQLite / DuckDB / Meilisearch**：数据库与搜索引擎的开源可替代方案。
- **Tip：避免"伪去依赖"**——使用 AGPL 但实则依赖某个闭源 LLM API，依然是单点失败；真正的去依赖是**模型可换、数据库可换、前端可换**。

## 四、对毕设的启示

1. **模型层：定义"模型接口"，不绑定 SDK**——所有模型调用走一个 `Provider` 抽象（输入消息 → 输出消息 + Token 元数据），Ollama / OpenAI / Anthropic 都是该接口的实现。
2. **存储层：本地优先 + 显式同步**——参考 Logseq 的 C5：纯文本文件是终极可移植格式；需要结构化时再用 SQLite/JSON。
3. **法律层：选择合适的协议**——若希望社区可自由 fork，AGPL-3.0 是"防止云厂商白嫖"的常见选择（C8）。若希望最大限度降低使用门槛，Apache-2.0 / MIT 更合适。
4. **避免"小而美"沦为"小而糙"**——Rust 后端 + Flutter 客户端（C1）的组合显示：轻量 ≠ 简陋，关键在于"边界清晰、依赖最少"。

## 五、参考来源

- AppFlowy-Cloud（已验证 C1/C8/C9）: https://github.com/AppFlowy-IO/AppFlowy-Cloud
- Logseq（已验证 C5/C12）: https://logseq.com/
- Ollama: https://ollama.com/
- LiteLLM: https://github.com/BerriAI/litellm
- AGPL-3.0 协议说明: https://www.gnu.org/licenses/agpl-3.0.html

> ⚠️ 本文件中"第三节"内容为本工作流范围之外的线索性资料，未做对抗核验。
