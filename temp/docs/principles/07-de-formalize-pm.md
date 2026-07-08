# 开发侧主旨 2：去形式化设计管理

> "吸收项目管理核心思想，让系统在确保团队产出的同时，最大限度**摒弃流程上的形式主义**。"

## 一、摘要

"形式主义"是 PM 文化中的反模式：Daily Stand-up 变成"汇报"、Sprint Review 变成"演示 PPT"、Story Point 变成"政治"。**去形式化**不等于"无流程"，而是把"流程自动化"——让系统的可观测数据替代手填的进度报告。

## 二、已验证事实

| # | 事实 | 与本主旨的关联 |
|---|------|----------------|
| C4 | Logseq 块结构（block-based outliner），每条 bullet 是独立块。 | 启示：把"任务"也实现为"块"，意味着任务可被任意引用、改写、合并——这与"形式化任务卡"截然相反。 |
| C5 | Logseq 本地优先，Markdown / Org-mode 纯文本。 | "数据可见" = "去形式化"——团队成员可看到彼此的原始笔记，而非被 PM 工具抽象后的状态。 |
| C6 | Zettelkasten 链接而非分类。 | 启示：任务的状态用"链接"描述（"被谁 link 到"、"被谁 link 自"），而不用"标签/状态字段"硬分类。 |
| C7 | 永久笔记"脱离上下文可理解"。 | 启示：每个任务卡 / Issue 都应"自包含"——单看一张卡就能知道要做什么、为什么做、做到什么程度算完成。 |
| C9 | AppFlowy-Cloud 活跃维护。 | 自托管 + 活跃社区 = 项目管理工具可被团队自行改造，不会被大厂 PM 工具的形式主义裹挟。 |

## 三、相关方法与工具（线索性记录）

- **Shape Up（Basecamp）**：固定时长 cycle + "no estimation" 的项目管理法。
- **Trunk-Based Development / Continuous Trunk**：以主干合入频率代替"分支策略评审"。
- **Linear / Height / Shortcut**：以"键盘优先 + 速度极快"著称的现代 PM 工具，目标就是"去形式化"。
- **DORA / SPACE**（见 principle 02）：用真实指标替代主观评估。
- **"Walking Skeleton" / "Tracer Bullet"**：用最小可运行全栈演示代替冗长设计文档。
- **Anti-patterns**: "Velocity theater"（用 velocity 报表装样子）、"ticket ping-pong"、Hofstadter 法则。

## 四、对毕设的启示

1. **用"系统可观测"替代"周报"**——团队产出的真实信号是：commit 频率、PR cycle time、Issue close rate、回滚次数。把这些作为"会议取消"的硬指标。
2. **Issue / 任务应当"自包含"**——C7 的启示：每个任务卡包含（1）目的（2）验收标准（3）阻塞条件。不需要再写"设计文档"——卡就是设计文档。
3. **固定时长的"Shape Up"循环**——固定 6 周一个 cycle，betting table 上决定"做/不做"，比"无限 backlog 排序"更省事。
4. **反对"velocity theater"**——系统应当不展示"花哨的看板"，而展示"距上一次主干合入 / 距上一次事故"的客观数字。

## 五、参考来源

- Shape Up（Basecamp）: https://basecamp.com/shapeup
- Linear: https://linear.app/
- Trunk-Based Development: https://trunkbaseddevelopment.com/
- takesmartnotes.com（已验证 C6/C7）: https://takesmartnotes.com/
- AppFlowy-Cloud（已验证 C9）: https://github.com/AppFlowy-IO/AppFlowy-Cloud
- Logseq（已验证 C4/C5）: https://logseq.com/

> ⚠️ 本文件中"第三节"内容为本工作流范围之外的线索性资料，未做对抗核验。
