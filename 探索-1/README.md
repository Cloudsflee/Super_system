# 探索-1：Workspace 记忆机制、Context Pack 与 Codex 核心化头脑风暴

> 生成时间：2026-07-07  
> 目的：围绕“每个 Workspace 是否可以直接以 Codex 这类工具作为协作核心、Context Pack 如何产生、不同 Workspace 如何通过上下文包交互、记忆机制如何设计”进行头脑风暴。  
> 定位：探索性材料，不等同于已确认方案。后续应把稳定结论同步到 `doc/核心想法.MD`，把疑问同步到 `doc/问题.md`。

---

## 文件说明

| 文件 | 内容 |
|---|---|
| `01_记忆机制与上下文包头脑风暴.md` | 讨论系统记忆、Workspace 记忆、Context Pack 生成、压缩、交互与生命周期。 |
| `02_Codex作为Workspace核心的方案.md` | 讨论“每个 Workspace 内置 Codex/Claude Code 等 Agent”的架构、优势、风险和折中方案。 |
| `03_可落地模型草案.md` | 给出一套可落地的数据结构、交互流程、MVP 切法和验证方式。 |
| `04_开放问题.md` | 记录还没有想清楚、需要继续研究或实验验证的问题。 |
| `05_互联网权威资料调研.md` | 第一版互联网权威资料调研，重点验证 Workspace 记忆、Context Pack、Codex/Claude Runner 可替换性。 |
| `06_权威资料补充调研_工作空间记忆开放节点资产追溯.md` | 扩展调研，补充 MCP、开放节点、插件生态、工作流引擎、资产追溯、多模态展示、本地优先等资料。 |
| `资料索引_自动验证.csv` | 已联网验证的一批资料链接索引，包含来源类别、标题、URL 和访问状态。 |

---

## 当前核心问题

你现在真正关心的不是简单“上下文压缩”，而是：

```text
每个 Workspace 如何拥有自己的协作记忆？
不同 Workspace 如何交换足够有效但不过载的上下文？
Codex 这类工具能否直接成为 Workspace 内部协作核心？
如果未来替换成 Claude Code 或其他 CLI，系统如何保留自己的记忆和工作空间结构？
Context Pack 到底由谁生成、什么时候生成、包含什么、如何更新？
```

---

## 当前初步判断

可以考虑把系统设计成：

```text
Workspace = 一个拥有目标、状态、资产、Trace、Digest、Context Pack、Agent Session 的协作容器
```

其中：

- **Codex / Claude Code / 其他 CLI** 可以作为某个 Workspace 的活跃协作 Agent；
- **Workspace Memory** 由系统管理，而不是完全交给 Codex；
- **Context Pack** 是 Workspace 对 Agent 或其他 Workspace 输出的“可消费上下文包”；
- **Workspace Digest** 是 Workspace 对上级/同级空间暴露的摘要；
- **Trace** 保存完整过程；
- **Asset Graph** 保存稳定结论和证据。

核心矛盾：

> 既想利用 Codex 的强上下文和压缩能力，又不能让系统上下文主权完全依赖 Codex。
