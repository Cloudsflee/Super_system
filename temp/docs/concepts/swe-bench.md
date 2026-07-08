# 工具 / 数据集研究：SWE-bench

> 对应搜索角度：**学术理论与综述** / **本地优先与 Agent 架构**

## 一、摘要

SWE-bench 是由 Princeton NLP 提出的代码改写能力基准数据集，包含来自真实 GitHub 仓库的 Issue + 单元测试。它要求 LLM 根据 Issue 描述生成 Patch，并让真实单元测试通过。SWE-bench Verified 是其人工核验版子集。

## 二、本轮核验事实（待进一步核验）

| # | 事实 | 证据 |
|---|------|------|
| N1 | 数据来源：12 个流行 Python GitHub 仓库的真实 Issue。 | swebench.org / 论文。 |
| N2 | 评估指标：通过的测试占比。 | swebench.org。 |
| N3 | SWE-bench Verified：500 个实例，由人类专家标注"确实可解"。 | 官方公告。 |
| N4 | 2024–2025 是 SWE-bench "刷榜年"——多个新模型在 Verified 子集上得分快速提升。 | 多篇综述。 |

> ⚠️ N1–N4 在本轮搜索中未直接复现详细数字，需进一步 WebFetch 核验。

## 三、为何与本毕设高度相关

- **主旨 6（重构成本定量化）**：SWE-bench 提供了一个**可直接复用的"等价改写"评估框架**——毕设可参考其设计"等价改写测试集"。
- **主旨 8（生态集成）**：SWE-bench 是评估 LLM 代码能力的"事实标准"——毕设若涉及代码改写，应以 SWE-bench 为外部基准。

## 四、对毕设的启示

1. **不要重新发明 SWE-bench**——毕设的"等价改写测试集"可参考其结构（Issue + Patch + 测试），但聚焦在毕设特定场景。
2. **测试集是研究的核心资产**——毕设若发布一个公开的"等价改写测试集 + 基准分数"，对开源社区是高价值贡献。
3. **人工核验子集是必要的**——SWE-bench Verified 表明：自动生成的测试集有噪声，需要人工核验子集作为"金标准"。

## 五、参考来源

- SWE-bench 官网: https://www.swebench.org/
- SWE-bench GitHub: https://github.com/SWE-bench/SWE-bench
- 原始论文：Jimenez et al., 2024, "SWE-bench: Can Language Models Resolve Real-World GitHub Issues?"
- SWE-bench Verified 公告: https://openai.com/index/introducing-swe-bench-verified/

> ⚠️ 本文件细节需 WebFetch 进一步核验。