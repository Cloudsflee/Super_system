# 开发侧主旨 1：重构成本定量化

> "积累完备的测试数据集，将系统重构（如更换语言）的成本，直接**量化为 AI 调用的 Token / 算力成本**。"

## 一、摘要

传统"重构成本"难以量化：人月、缺陷率、回归测试通过率都是滞后指标。本主旨提出一个新度量：**让一次完整的"等价改写"在受控测试集上跑一遍，把所有改动所需的 AI 推理资源（Token、GPU-秒、电费）作为可比指标**。

这把"工程经验"问题转化为"算力预算"问题——可以让毕设答辩时的成本估算具有可重复性。

## 二、已验证事实

| # | 事实 | 与本主旨的关联 |
|---|------|----------------|
| C1 | AppFlowy-Cloud 后端用 Rust，客户端用 Flutter。 | 一个真实的"Rust + Flutter 跨语言"工程样本，可作为"重构前 ↔ 重构后"对照的对象。 |
| C9 | AppFlowy-Cloud 活跃维护、1,918 stars / 529 forks。 | 样本需有"完整代码 + 完整测试 + 活跃 Issue"，才适合做等价改写对照。 |

## 三、相关方法与工具（线索性记录）

- **SWE-bench / SWE-bench Lite / SWE-bench Verified**：用真实 GitHub Issue + 单元测试对 LLM 改写能力做基准测试，是"等价改写成本"领域最权威的数据集。
- **HumanEval / MBPP / LiveCodeBench**：代码生成基准。
- **Token / 算力成本计量**：
  - OpenAI / Anthropic / Google Vertex 官方 Pricing API。
  - **OpenRouter / LiteLLM** 统一账单。
  - **Langfuse / Helicone / OpenLLMetry** 记录每次调用的 Token 与耗时。
- **GPU-小时度量**：`nvidia-smi --query-gpu=power.draw`、`vLLM` 的 `metrics` 端点。
- **"等价改写"的判定标准**：行为对齐（输入/输出一致）、性能（latency 退化 < N%）、测试通过率 ≥ 99%。

## 四、对毕设的启示

1. **建立"等价改写测试集"**——
   - 抽取 N 个典型用户故事（user story）。
   - 每个故事配 1) 旧实现的输入/输出样本 2) 单元测试 3) 性能基准。
   - 重构后跑同一批测试，以"通过率"作为"语义保持"的硬指标。
2. **构建 Token 成本函数**——
   - `cost(rewrite) = Σ token_in(prompt_i) × p_in + Σ token_out(response_i) × p_out + GPU_seconds × p_gpu`
   - 把这条函数**作为项目 README 的一部分**——答辩时这是最直观的"可量化的重构成本"。
3. **对比实验设计**——
   - "Java → Rust" / "Python → Go" / "Vue → Svelte" 三个对照。
   - 用同一测试集、同样的 LLM、同样的人工介入次数。
4. **公开账本**——把每次重构实验的 Token/算力账本以 CSV/Markdown 形式公开，作为开源数据点（参考"Green Software Foundation" 的软件碳强度方法学）。

## 五、参考来源

- SWE-bench: https://www.swebench.org/
- AppFlowy-Cloud（已验证 C1/C9）: https://github.com/AppFlowy-IO/AppFlowy-Cloud
- LiteLLM Pricing: https://github.com/BerriAI/litellm
- OpenLLMetry: https://github.com/traceloop/openllmetry
- Green Software Foundation SCI 规范: https://greensoftware.foundation/

> ⚠️ 本文件中"第三节"内容为本工作流范围之外的线索性资料，未做对抗核验。
