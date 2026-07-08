# 概念研究：CRDT（Conflict-free Replicated Data Types）

> 对应搜索角度：**学术理论与综述** / **本地优先与 Agent 架构**

## 一、摘要

CRDT（Conflict-free Replicated Data Types）是一种**保证多副本最终一致**的数据结构，无需中心协调即可让多个客户端并发修改、合并结果。它是 local-first 软件、协同编辑、去中心化笔记工具的共同底层技术。

## 二、本轮核验事实（待进一步核验）

| # | 事实 | 证据 |
|---|------|------|
| N1 | 起源：1980–2010 年代分布式系统研究；Marc Shapiro 等人 2011 年论文"Inria"奠定基础。 | 学术综述。 |
| N2 | 两大类：**Operation-based CRDTs**（CmRDT）与 **State-based CRDTs**（CvRDT / Convergent）。 | 多源综述。 |
| N3 | 典型实现：Yjs、Automerge、Diamond Types、Loro。 | 各项目官网。 |
| N4 | 关键属性：交换性（commutativity）、结合性（associativity）、幂等性（idempotency）。 | 学术定义。 |

> ⚠️ N1–N4 在本轮搜索中未直接复现细节，建议 WebFetch 进一步核验。

## 三、为何与本毕设高度相关

- **主旨 4（去依赖）**：CRDT 是"去中心化同步"的核心技术——毕设若要做"无服务器多端同步"，CRDT 是唯一务实选择。
- **主旨 8（生态集成）**：Yjs / Automerge 已与 ProseMirror / Tiptap / Monaco 等编辑器深度集成。
- **主旨 2（扁平化与贡献量化）**：CRDT 让多人协作时"无锁合并"——所有贡献自然累积。

## 四、CRDT 在 PKM / Agent 系统中的实际应用

| 应用 | CRDT 实现 | 用途 |
|------|-----------|------|
| Yjs | Yjs | 富文本协作（Etherpad / Notion-like） |
| Automerge | Automerge | JSON 文档协作 |
| Loro | Loro | 高性能富文本 |
| Electric SQL | CRDT + Postgres | 数据库同步 |
| PowerSync | CRDT | 移动端数据库同步 |
| Anytype | 自研 CRDT | 去中心化 PKM |
| Affine | CRDT | 块结构 PKM |
| Linear | 内部实现 | 实时 Issue 状态同步 |

## 五、对毕设的启示

1. **不要自己写 sync 协议**——选 Yjs（富文本）或 Automerge（JSON）。
2. **CRDT 不是万能药**——对"语义冲突"（如"删除 vs 重命名"）无能为力，需要应用层解决。
3. **评估 CRDT 实现**的三个维度：性能（大型文档的内存占用）、协议可移植性、生态完整度。
4. **与 P2P 协议结合**——CRDT + libp2p = 完全去中心化（如 Anytype）。

## 六、参考来源

- Yjs: https://yjs.dev/
- Automerge: https://automerge.org/
- Loro: https://loro.dev/
- Electric SQL: https://electric-sql.com/
- PowerSync: https://www.powersync.co/
- Marc Shapiro 2011 综述: https://www.researchgate.net/publication/220467745

> ⚠️ 本文件为本轮补充核验资料；CRDT 学术细节需进一步核验。