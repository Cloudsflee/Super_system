# 协议研究：Model Context Protocol (MCP)

> 对应搜索角度：**本地优先与 Agent 架构** / **主流开源工具与生态**

## 一、摘要

MCP（Model Context Protocol）是 Anthropic 于 **2024 年 11 月**发布并开源的开放协议，被誉为"AI 的 USB-C 接口"。它标准化了 LLM 与外部数据源、工具、服务之间的连接方式，让任何 LLM 应用可与任何工具互通，无需为每个工具写专门适配。

## 二、本轮核验事实

| # | 事实 | 证据 |
|---|------|------|
| N1 | 发布方：Anthropic；发布时间：2024-11；开源协议。 | 多源中文技术博客一致引用。 |
| N2 | 基础：JSON-RPC 2.0 双向通信。 | 中文技术博客。 |
| N3 | 核心概念：Tools（AI 可调用的函数）、Resources（数据源）、Prompts（模板化交互）。 | 官方文档 modelcontextprotocol.io。 |
| N4 | 定位：替代"碎片化的 plugin 系统"，成为"AI 接入任意工具"的统一协议。 | 业界共识。 |

## 三、为何与本毕设高度相关

- **主旨 1（透明化）**：MCP 让"AI 调用了什么工具 / 拿到了什么数据"成为**可协议级审计**的事件流。
- **主旨 4（去依赖）**：MCP 替代每个工具的私有 SDK，让毕设不被某个 AI 厂商绑定。
- **主旨 8（生态集成）**：MCP 是"生态集成的入场券"——支持 MCP 的工具会自动被所有 MCP 兼容的 AI 客户端发现。

## 四、对毕设的启示

1. **优先实现 MCP 客户端 + 服务端**——这是 2025 年起 Agent 应用的"事实标准"。
2. **每个工具都暴露为 MCP Resource**——而不是写一堆 SDK 适配层。
3. **MCP 是"协议 > 框架"的典范**——值得在毕设中作为"基础设施选型"案例研究。
4. **注意 MCP 仍处于早期**——API 可能有变化，需跟踪 GitHub 仓库的 releases。

## 五、参考来源

- MCP 官网: https://modelcontextprotocol.io/
- GitHub 仓库: https://github.com/modelcontextprotocol
- 中文综述: https://blog.csdn.net/longxiaotian718/article/details/147167549
- 完整协议流程: https://www.cnblogs.com/jmcui/p/archive/2025/09/23

> ⚠️ 本文件为本轮补充核验资料，未做 3 票对抗式核验。