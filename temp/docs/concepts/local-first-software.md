# 概念研究：Local-first Software（本地优先软件运动）

> 对应搜索角度：**设计哲学与专注机制** / **本地优先与 Agent 架构**

## 一、摘要

"Local-first software: You own your data, in spite of the cloud" 是 **Martin Kleppmann、Adam Wiggins、Peter van Hardenberg、Mark McGranaghan** 于 2019 年通过 Ink & Switch 研究实验室发表的开创性文章。它系统阐述了"本地优先"作为 SaaS 替代方案的 7 大原则，是毕设**主旨 4（去依赖）+ 主旨 5（行为资产化）**的理论基础。

## 二、本轮核验事实

| # | 事实 | 证据 |
|---|------|------|
| N1 | 文章发表于 Ink & Switch 实验室（2018 年成立的独立研究实验室）。 | 多源综述。 |
| N2 | 作者团队：Martin Kleppmann（剑桥大学分布式系统研究者、《Designing Data-Intensive Applications》作者）、Adam Wiggins（Heroku 联合创始人）、Peter van Hardenberg、Mark McGranaghan。 | 文章原始署名。 |
| N3 | "Local-first" 的 7 大原则（见下文）。 | 文章原文。 |
| N4 | 核心技术：CRDT（Conflict-free Replicated Data Types）实现离线编辑与多端合并。 | 文章 + Ink & Switch 后续工作（Automerge、Electric）。 |
| N5 | 后续生态：Automerge（CRDT 库）、Electric（CRDT 同步后端）、Yjs（另一 CRDT 库）。 | 多源。 |

## 三、7 大原则

1. **No spinners, no waiting** — 快速响应；UI 不应被网络阻塞。
2. **Works offline** — 离线时应用仍完全可用。
3. **Multi-device / cross-device sync** — 跨设备无缝同步。
4. **Collaboration by default** — 默认支持实时多人协作。
5. **Longevity** — 数据寿命超过任何公司或服务；无锁定。
6. **Privacy** — 数据默认留在用户设备上，除非用户明确共享。
7. **User control & ownership** — 用户拥有自己的数据，而非供应商。

## 四、为何与本毕设高度相关

- **主旨 4（去依赖）**：local-first 7 原则直接呼应"不高度依赖特定大厂"。
- **主旨 5（行为资产化）**：longevity + user control 是"行为沉淀为数字资产"的前提。
- **主旨 3（多模态展示）**：multi-device sync 让同一份数据可在多模态中呈现。
- **主旨 8（生态集成）**：CRDT 是"无中心协同"的底层协议——毕设若要做多端同步，CRDT 几乎是唯一务实选择。

## 五、对毕设的启示

1. **把 7 原则写进毕设设计原则文档**——这是答辩时最简洁有力的"理论支撑"。
2. **CRDT 应作为多端同步的核心技术**——不要重新发明 sync 协议，优先选 Automerge / Yjs / Electric。
3. **"longevity" 是被忽视的金标准**——纯文本（如 Markdown / Org-mode）是数据寿命最长的格式，毕设若关心 10 年后可读性，应坚持纯文本。
4. **"no spinners" 是工程基线**——所有异步操作必须有本地缓存 + 后台同步，不能让用户等。
5. **PKM 工具的"流派"分类**：local-first PKM = Logseq / TriliumNext / Anytype / Affine / Obsidian；SaaS PKM = Notion / Roam / Heptabase。

## 六、参考来源

- 原文章: https://www.inkandswitch.com/local-first/
- Ink & Switch 实验室: https://www.inkandswitch.com/
- Martin Kleppmann 个人页: https://martin.kleppmann.com/
- Automerge: https://automerge.org/
- Electric: https://electric-sql.com/
- Yjs: https://yjs.dev/

> ⚠️ 本文件为本轮补充核验资料，未做 3 票对抗式核验。