# 工具研究：Anytype / Affine / Standard Notes（隐私优先 PKM 三剑客）

> 对应搜索角度：**主流开源工具与生态** / **本地优先与 Agent 架构**

## 一、摘要

Logseq / TriliumNext 是"开源 + 本地优先" PKM 的代表，但还有一类更彻底的"local-first + E2EE + 去中心化" PKM 工具——Anytype、Affine、Standard Notes。它们代表了"数据主权"的极端立场。

## 二、本轮核验事实

### Anytype（已核验）

| # | 事实 | 证据 |
|---|------|------|
| N1 | 三大基石：**local-first + P2P + 端到端加密（E2EE）**。 | anytype.io 官网。 |
| N2 | 协议栈基于 libp2p（peer discovery / NAT traversal / 加密 P2P / DHT）。 | anytype 协议文档。 |
| N3 | 数据模型：所有内容都是"Object"（笔记、页面、Collection、Set、文件、Tag、Relation）——同构对象图。 | anytype 文档。 |
| N4 | 网络拓扑：两层网络——Home Network（自有设备直连）+ Backup Network（加密分片备份）。 | 协议文档。 |
| N5 | 加密：Ed25519 签名 + Curve25519 密钥协商；每个 Space 有独立密钥。 | 协议文档。 |
| N6 | 开源：客户端 Apache-2.0；协调节点基础设施仍部分专有（截至 2024）。 | GitHub 仓库。 |

### Affine（待核验）

| # | 事实 | 证据 |
|---|------|------|
| N1 | local-first + 块结构（Notion-like） + 多视图（文档 / 白板 / 数据库）。 | affine.to 官网。 |
| N2 | 使用 CRDT 实现多端同步。 | 官网技术页。 |
| N3 | 同步：使用中心化服务器（不像 Anytype 完全 P2P）。 | 多源对比。 |

### Standard Notes（待核验）

| # | 事实 | 证据 |
|---|------|------|
| N1 | 端到端加密 + 极简 Markdown / 富文本编辑器。 | standardnotes.org 官网。 |
| N2 | 开源（AGPL-3.0）；可选付费扩展（编辑器、文件夹、超级笔记）。 | standardnotes.org。 |
| N3 | 与 Logseq / Anytype 的差异：纯文本 / Markdown 为主，无块结构 / 关系图。 | 多源对比。 |

## 三、对比矩阵

| 维度 | Anytype | Affine | Standard Notes | Logseq | Obsidian | Notion |
|------|---------|--------|----------------|--------|----------|--------|
| **本地优先** | ✅ 完全 | ✅ 是 | ✅ 完全 | ✅ 完全 | ✅ 完全 | ❌ SaaS |
| **端到端加密** | ✅ 是 | ⚠️ 部分 | ✅ 是 | ❌ 否 | ❌ 否 | ❌ 否 |
| **去中心化 P2P** | ✅ 是 | ❌ 否 | ❌ 否 | ❌ 否 | ❌ 否 | ❌ 否 |
| **块结构** | ✅ Object | ✅ 块 | ❌ 纯文本 | ✅ 块 | ✅ 部分 | ✅ 块 |
| **Graph / 关系视图** | ✅ 是 | ⚠️ 部分 | ❌ 否 | ✅ 是 | ✅ 是 | ❌ 否 |
| **白板** | ❌ 否 | ✅ 是 | ❌ 否 | ⚠️ 插件 | ⚠️ 插件 | ✅ 是 |
| **开源** | ✅ Apache-2.0 | ✅ MIT | ✅ AGPL-3.0 | ✅ AGPL-3.0 | ❌ 闭源 | ❌ 闭源 |

## 四、为何与本毕设高度相关

- **主旨 4（去依赖）**：Anytype 把"无中心 + 端到端加密"作为产品哲学，是"去依赖"的极端版本。
- **主旨 5（行为资产化）**：数据所有权 = 资产所有权；E2EE 是"资产所有权"的工程保障。
- **主旨 3（多模态）**：Anytype 的 Object / Affine 的多视图是 PKM 工具的现代形态。

## 五、对毕设的启示

1. **"本地优先"有 4 个层级**：
   - L1：纯本地（Obsidian）
   - L2：本地 + 云同步（Logseq Pro、Standard Notes 付费）
   - L3：本地 + 中心化加密同步（Affine）
   - L4：本地 + P2P + E2EE（Anytype）
   毕设应明确选哪一层，并在文档中说明。
2. **CRDT 是 L2/L3/L4 的共同底层技术**——选 Automerge / Yjs / Electric。
3. **E2EE 是合规卖点**——在欧洲 GDPR / 中国《数据安全法》下，E2EE 是商业产品的高价值特性。
4. **"Object 同构"是 Notion 之后的新方向**——Anytype 把"所有内容都是 Object"作为哲学，毕设可考虑类似抽象。

## 六、参考来源

- Anytype 官网: https://anytype.io/
- Anytype 协议文档: https://tech.anytype.io/
- Affine 官网: https://affine.pro/
- Standard Notes 官网: https://standardnotes.org/
- Logseq（已验证 C4/C5/C12）: https://logseq.com/

> ⚠️ 本文件为本轮补充核验资料；Affine / Standard Notes 细节需进一步核验。