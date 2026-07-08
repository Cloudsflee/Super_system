# 概念研究：Edge AI / On-device Inference（边缘 AI 与端侧推理）

> 对应搜索角度：**本地优先与 Agent 架构** / **设计哲学与专注机制**

## 一、摘要

Edge AI 是指**在终端设备（手机、笔记本、嵌入式）本地运行 AI 模型**的范式。它是"local-first"在 AI 层的延伸——毕设若要"断网仍可用"+"数据不出本机"，Edge AI 是核心技术。本概念与 Ollama / llama.cpp / Core ML / TensorFlow Lite 等实现紧密相关。

## 二、本轮核验事实（待进一步核验）

| # | 事实 | 证据 |
|---|------|------|
| N1 | Edge AI 与 Cloud AI 的对比：Edge 延迟低、隐私好、离线可用；Cloud 模型大但需联网。 | 多源综述。 |
| N2 | 关键使能技术：模型量化（INT8 / INT4 / GGUF）、蒸馏、剪枝。 | 多源综述。 |
| N3 | 典型运行时：Apple Core ML、Google TensorFlow Lite、Qualcomm AI Engine、NVIDIA Jetson、ONNX Runtime。 | 各自官网。 |
| N4 | 2025 年趋势：3B–8B 模型在端侧达到"可用"水平；MoE 模型激活参数小，适合端侧。 | 多源。 |

> ⚠️ N1–N4 在本轮搜索中未直接复现细节，建议 WebFetch 进一步核验。

## 三、为何与本毕设高度相关

- **主旨 4（去依赖）**：Edge AI 是"模型层去依赖"的终极形态。
- **主旨 1（透明化）**：本地推理 = 用户的请求不被发送到远端 = 透明的"数据流"。
- **主旨 7（去形式化 PM）**：Edge AI 让"AI 辅助写作 / 编程"无延迟打断，符合 deep work。

## 四、对毕设的启示

1. **3B–8B 模型已"可用"**——Qwen 2.5 7B、Llama 3.1 8B、Phi-4 14B 在端侧都能跑。
2. **量化是关键**——Q4_K_M 量化让 7B 模型只需 ~4GB 显存。
3. **混合策略**：本地模型 + 云端 API 双轨；小任务本地、大任务云端。
4. **不要忽视 CPU 推理**——llama.cpp + Apple Silicon M1/M2/M3 = 无需 GPU 也能跑。

## 五、参考来源

- Apple Core ML: https://developer.apple.com/machine-learning/core-ml/
- Google TensorFlow Lite: https://www.tensorflow.org/lite
- ONNX Runtime: https://onnxruntime.ai/
- Qualcomm AI Hub: https://aihub.qualcomm.com/

> ⚠️ 本文件为本轮补充核验资料，细节需 WebFetch 进一步核验。