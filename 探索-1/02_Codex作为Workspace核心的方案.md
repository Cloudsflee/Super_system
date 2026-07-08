# 02. Codex 作为 Workspace 核心的方案

> 生成时间：2026-07-07  
> 主题：是否可以把 Codex 这类工具直接作为每个 Workspace 的协作核心，同时保留未来切换到 Claude Code 或其他 CLI 的能力。

---

## 1. 先承认你的直觉是有价值的

把 Codex 这类工具作为 Workspace 核心有明显优势：

- 它天然适合长上下文协作；
- 它能处理代码、文件、命令、项目结构；
- 它已经有较成熟的任务推进能力；
- 它具备记忆压缩/上下文续接能力；
- 它能在本地环境中完成真实操作；
- 它比“普通 API 调 LLM”更接近一个协作伙伴。

所以，不应该把 Codex 只看成一个普通模型 API。

更准确地说：

> Codex 可以成为某个 Workspace 的 Active Agent / 驻留协作代理。

---

## 2. 但 Codex 不应成为系统唯一记忆中心

风险在于：

```text
如果 Workspace 的状态只存在 Codex 会话里，
那么换 Runner、恢复历史、跨空间通信、资产追溯都会出问题。
```

所以需要区分：

| 层级 | 归属 |
|---|---|
| Workspace 状态 | 系统 |
| 资产图谱 | 系统 |
| Digest | 系统生成/保存 |
| Context Pack | 系统生成/保存 |
| Trace | 系统记录 |
| Codex session memory | Codex Runner 内部 |

一句话：

> Codex 可以是 Workspace 的工作代理，但不能是 Workspace 的唯一事实来源。

---

## 3. 三种方案

### 方案 A：Codex 只是普通工具

```text
Workspace
  → 生成任务
  → 调用 Codex 一次
  → 收回结果
```

优点：

- 架构干净；
- 替换容易；
- 系统主权强。

缺点：

- 浪费 Codex 的长会话和自主推进能力；
- 每次都要重建上下文；
- 体验不像“协作核心”。

适合：

- 简单 AI 分析；
- 一次性代码任务；
- MVP 最保守版本。

---

### 方案 B：Codex 作为 Workspace 驻留 Agent

```text
Workspace
  ├── 系统侧 Workspace Memory
  ├── Workspace Digest
  ├── Context Pack
  └── Codex Session
```

Codex 在某个 Workspace 内持续协作，系统定期：

- 给 Codex 输入 Context Pack；
- 从 Codex 获取结果；
- 把结果归一化；
- 更新 Workspace Digest；
- 记录 Trace；
- 固化资产。

优点：

- 体验强；
- Codex 可以持续理解本 Workspace；
- 适合复杂节点工作空间；
- 更符合“AI 协作核心”。

缺点：

- 对 Codex CLI / 会话机制有依赖；
- 需要处理会话恢复；
- 需要防止 Codex 内部记忆和系统记忆不一致。

适合：

- 编码节点；
- 技术方案探索；
- 长时间工作空间；
- 需要持续上下文的任务。

---

### 方案 C：每个 Workspace 有可替换 Agent Slot

```text
Workspace
  ├── Agent Slot
  │     ├── Codex Runner
  │     ├── Claude Code Runner
  │     └── Other CLI Runner
  ├── Context Pack Builder
  ├── Result Normalizer
  ├── Trace Recorder
  └── Workspace Memory
```

这是最理想架构。

Workspace 不绑定 Codex，而是绑定一个 Agent Slot。

Agent Slot 可以装：

- Codex；
- Claude Code；
- OpenAI API Agent；
- 本地 LLM；
- 自定义 CLI；
- 甚至人工执行器。

优点：

- 保留 Codex 强体验；
- 架构上可替换；
- 可以按任务选 Runner；
- 更符合开源自托管系统。

缺点：

- 抽象设计更复杂；
- 不同 Runner 能力差异很大；
- 需要统一结果格式。

建议：

> MVP 可以实现方案 B 的体验，但代码结构按方案 C 设计。

---

## 4. Workspace 内的 Codex 应该如何工作？

推荐流程：

```text
打开 Workspace
  → 系统生成 Workspace Context Pack
  → 启动 / 恢复 Codex Session
  → Codex 读取上下文包
  → Codex 产出计划 / 问题 / 修改 / 结论
  → 系统捕获输出和文件变化
  → Result Normalizer 归一化结果
  → Trace Recorder 记录过程
  → Asset Extractor 提取资产候选
  → 用户确认关键资产 / 决策
  → Workspace Digest 更新
```

---

## 5. Codex Session 和 Workspace 的关系

一个 Workspace 可以有多个 Agent Session：

```text
Workspace: 实现 GitHub Issue 同步
  ├── codex_session_001：初版实现
  ├── codex_session_002：修复测试失败
  ├── claude_session_001：评审代码设计
  └── human_thread_001：人工确认 API 权限
```

所以不要把：

```text
Workspace = Codex Session
```

而应该是：

```text
Workspace 包含 Codex Session
```

---

## 6. Codex 的内部压缩结果如何进入系统？

如果 Codex 自己有压缩摘要，系统可以利用，但要转化为系统资产或 Digest 草稿。

流程：

```text
Codex session summary
  → 系统读取/请求 summary
  → 生成 Workspace Digest 草稿
  → 用户可确认关键结论
  → 保存 Digest vN
```

不要直接把 Codex summary 当最终事实。

原因：

- Codex 可能遗漏关键操作；
- Codex summary 不一定结构化；
- Codex 的内部记忆格式不可控；
- 换 Runner 后不可复用。

---

## 7. 不同 Workspace 的 Codex 如何交互？

不要让不同 Codex Session 直接互相共享全部上下文。

推荐：

```text
Workspace A 的 Codex
  → 产出 Workspace Digest / Asset / Decision
  → Workspace B 的 Context Pack Builder 选择性引用
  → Workspace B 的 Codex 读取 Context Pack
```

也就是：

```text
Codex A 不直接喂给 Codex B
系统负责中间整理
```

否则会出现：

- 上下文污染；
- 错误扩散；
- 无法追溯；
- 历史噪声过多；
- 责任边界不清。

---

## 8. Agent Slot 能力协商

Workspace 要选择 Runner，需要知道任务需要什么能力。

任务声明：

```yaml
required_capabilities:
  - code_edit
  - git_ops
  - shell_exec
  - long_context
```

Runner 声明：

```yaml
runner: codex
capabilities:
  - code_edit
  - git_ops
  - shell_exec
  - long_context
  - session_memory
```

如果能力不匹配：

```text
降级执行
换 Runner
请求用户手动执行
拆分任务
```

---

## 9. 结果归一化

不同 Runner 输出完全不同，所以需要 Result Normalizer。

Codex 可能输出：

```text
自然语言总结 + 文件 diff + 命令输出
```

Claude Code 可能输出另一种格式。

系统需要归一化为：

```yaml
run_result:
  status: succeeded | failed | blocked
  summary: string
  changed_files: []
  generated_assets: []
  decisions_suggested: []
  open_questions: []
  test_results: []
  trace_refs: []
```

这样 Workspace 不需要关心 Runner 具体是谁。

---

## 10. Codex 核心化的边界

### 可以交给 Codex

- 代码修改；
- 文件分析；
- 生成计划；
- 总结局部上下文；
- 发现问题；
- 调用本地工具；
- 生成候选方案。

### 不应该完全交给 Codex

- 项目最终事实；
- 资产图谱；
- 工作流结构；
- 跨 Workspace 上下文传播；
- 决策权；
- 权限管理；
- 长期记忆唯一来源。

---

## 11. MVP 建议

MVP 可以这样做：

```text
1. 每个 Node Workspace 可以启动一个 Codex Session
2. 系统为该 Session 生成 Snapshot Context Pack
3. Codex 执行任务
4. 系统记录命令、文件 diff、输出摘要
5. 用户确认关键产出
6. 系统生成 Workspace Digest
7. 父 Workspace 通过 Digest 获取进展
```

暂时不做：

- 多 Runner 自动调度；
- 复杂 Live Context Channel；
- 完整 Claude Code Adapter；
- 多 Agent 自主对话；
- 自动跨空间全量同步。

但代码结构预留：

```text
AgentRunner interface
CodexRunner implementation
ContextPackBuilder
ResultNormalizer
TraceRecorder
```

---

## 12. 一句话结论

> 可以把 Codex 作为每个 Workspace 的首选协作 Agent，但 Workspace 的记忆、资产、状态和跨空间通信必须由系统管理。这样既能利用 Codex 的强协作能力，又能避免未来无法替换。
