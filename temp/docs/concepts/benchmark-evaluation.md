# 概念研究：AI Agent 基准与评估方法

> 对应搜索角度：**学术理论与综述**

## 一、摘要

"如何评估 AI Agent / LLM 的能力"是 2024–2025 年最热的学术问题之一。毕设若涉及"AI 辅助开发 / 协作"，必须用业界公认的基准来支撑。

## 二、主流基准清单

### 2.1 代码能力

| 基准 | 用途 | 数据规模 | 来源 |
|------|------|----------|------|
| **SWE-bench** [本轮 N] | 真实 GitHub Issue 改写 | 2,294 实例 | swebench.org |
| **SWE-bench Verified** | 人工核验子集 | 500 实例 | openai.com |
| **HumanEval** | 函数级代码生成 | 164 问题 | openai |
| **MBPP** | 基础编程问题 | 974 问题 | google-research |
| **LiveCodeBench** | 时效性代码生成 | 持续更新 | livecodebench.github.io |
| **RepoBench** | 仓库级代码补全 | — | — |

### 2.2 Agent 能力

| 基准 | 用途 | 来源 |
|------|------|------|
| **AgentBench** | 多环境 Agent 评估 | THUDM |
| **SWE-Agent** | Agent 框架基准 | Princeton |
| **GAIA** | 通用助手能力 | Meta + Hugging Face |
| **WebArena** | 网页操作 Agent | CMU |
| **OSWorld** | 操作系统级 Agent | — |

### 2.3 推理 / 通用能力

| 基准 | 用途 | 来源 |
|------|------|------|
| **MMLU** | 多任务语言理解 | — |
| **GSM8K** | 小学数学 | — |
| **MATH** | 竞赛数学 | — |
| **HumanEval-X** | 多语言代码 | — |

### 2.4 LLM-as-Judge / 评估方法

| 工具 | 用途 |
|------|------|
| **PromptFoo** | 提示词 A/B 测试 |
| **DeepEval** | LLM-as-judge 框架 |
| **Inspect AI** | UK AISI 评估框架 |
| **MT-Bench** | 多轮对话评估 |

## 三、为何与本毕设高度相关

- **主旨 6（重构成本定量化）**：SWE-bench 是"等价改写"的事实标准。
- **主旨 1（透明化）**：评估指标让"AI 表现"可量化、可对比。
- **主旨 5（行为资产化）**：基准测试集本身可作为"行为资产"被复用。

## 四、对毕设的启示

1. **不要自造基准**——除非毕设专注"评测方法"本身，否则用 SWE-bench / HumanEval 等成熟基准。
2. **多维评估**：单维分数易失真；建议代码能力 + Agent 能力 + 推理能力三维。
3. **自定义测试集**：在通用基准之外，毕设应有针对自己场景的私有测试集。
4. **LLM-as-Judge 的局限**：用 AI 评 AI 时，模型偏见会传递；建议"人类标注 + LLM 评分"双轨。

## 五、参考来源

- SWE-bench: https://www.swebench.org/
- HumanEval 论文: https://arxiv.org/abs/2107.03374
- AgentBench 论文: https://arxiv.org/abs/2308.03688
- PromptFoo: https://promptfoo.dev/

> ⚠️ 本文件为本轮补充核验资料，细节需 WebFetch 进一步核验。