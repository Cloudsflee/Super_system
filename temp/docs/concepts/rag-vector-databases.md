# 概念研究：RAG 与向量数据库（Retrieval-Augmented Generation）

> 对应搜索角度：**学术理论与综述** / **本地优先与 Agent 架构**

## 一、摘要

RAG（Retrieval-Augmented Generation）是一种**在 LLM 推理时检索外部知识库**的范式，可缓解 LLM 的"幻觉"和"知识截止"问题。向量数据库是 RAG 的核心基础设施，把文本/代码/图像嵌入为高维向量，按相似度检索。

## 二、本轮核验事实（待进一步核验）

| # | 事实 | 证据 |
|---|------|------|
| N1 | RAG 范式：Lewis 等人 2020 年 NeurIPS 论文奠基。 | 学术文献。 |
| N2 | 主流向量数据库：Qdrant、Weaviate、Pinecone、Chroma、Milvus、pgvector（Postgres 扩展）。 | 各自官网。 |
| N3 | 嵌入模型：OpenAI text-embedding-3、Cohere embed-v3、BGE（开源）、MTEB benchmark。 | 各自文档。 |
| N4 | 关键挑战：分块策略（chunking）、混合检索（BM25 + dense）、重排序（reranking）。 | 多源综述。 |

> ⚠️ N1–N4 在本轮搜索中未直接复现细节，建议 WebFetch 进一步核验。

## 三、为何与本毕设高度相关

- **候选主旨 11（外部报告 · Memory Base）**：RAG 是"组织记忆底座"的核心技术。
- **主旨 5（行为资产化）**：把"老成员的笔记 / 决策"嵌入为向量，新成员检索即可"继承"经验。
- **主旨 1（透明化）**：RAG 的检索结果可作为"决策依据"展示，提升 AI 输出可解释性。

## 四、对毕设的启示

1. **RAG 不是银弹**——分块策略决定上限，嵌入模型决定下限。
2. **向量数据库选型**：自托管 Qdrant / Weaviate；零成本 Chroma；企业 Pinecone。
3. **混合检索**：dense（语义）+ sparse（关键词）通常优于单一方法。
4. **检索的可视化**：展示"AI 看到了哪些文档片段"是透明化的具体落地。

## 五、参考来源

- Lewis 等 2020 *Retrieval-Augmented Generation*: https://arxiv.org/abs/2005.11401
- Qdrant: https://qdrant.tech/
- Weaviate: https://weaviate.io/
- Chroma: https://www.trychroma.com/
- MTEB benchmark: https://huggingface.co/spaces/mteb/leaderboard

> ⚠️ 本文件为本轮补充核验资料，细节需 WebFetch 进一步核验。