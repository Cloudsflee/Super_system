# 用户侧主旨 2：扁平化与贡献量化

> "团队成员生态位趋于平等，建立一套逻辑**自动统计并量化**各成员的实际贡献。"

## 一、摘要

"扁平化"否认层级化项目管理中的指挥链；"贡献量化"要求系统用可验证的输入与输出来度量每个成员的实际价值。本质上这是 **"以可观测行为替代主观评估"** 的工程化方案——只要行为被透明记录，贡献可以被算法还原。

## 二、已验证事实

| # | 事实 | 与本主旨的关联 |
|---|------|----------------|
| C6 | 卡片盒以"链接而非分类"组织；通过唯一 ID + 链式标注（如 `21/3d4a`）让贡献自然累积。 | 提供了"贡献自然涌现"的范式：不是先定义岗位再收集贡献，而是先记录思想再发现权威节点。 |
| C7 | 永久笔记须含"脱离上下文可理解"的思想。 | 启示贡献量化应基于"可独立交付的成果单元"，而不是"在工单系统里完成的步骤"。 |
| C9 | AppFlowy-Cloud 活跃维护（1,918 stars / 529 forks / 2026-05-16 push）。 | 自托管协作栈的活跃度说明"去中心化"协作有真实市场。 |

## 三、相关方法与工具（线索性记录）

- **DORA / SPACE 指标**：DORA 关注交付性能；SPACE（Satisfaction, Performance, Activity, Communication, Efficiency）更适合度量个人与团队的"工程贡献"而非仅流水线速度。
- **Open Source 贡献量化范式**：`git log --shortstat`、`git-of-theseus`、`gitinspector`、`OSS-Compass` 等。
- **行为日志 → 贡献图**：GitHub contribution graph、Sourcegraph 团队分析、OpenSauced。
- **AppFlowy / Notion 类工具**：贡献以"创建/编辑/评论"等原子行为被记录，但目前缺乏标准化的事件 schema。

## 四、对毕设的启示

1. **贡献的事件模型**——定义最小事件集（`created`、`edited`、`commented`、`reviewed`、`merged`、`released`），并为每类事件赋权重。建议参考 [Conventional Commits](https://www.conventionalcommits.org/) 与 [OpenSSF Scorecard](https://scorecard.dev/) 的事件分类思路。
2. **避免"工时=贡献"的陷阱**——行为计数 ≠ 价值。SPACE 框架建议同时纳入"满意度"与"通信/协作"维度。
3. **扁平化 ≠ 无结构**——Zettelkasten 的经验显示，扁平化的前提是**显式链接**而非"平铺"。在贡献图中，应鼓励"评论/Review"成为与"提交"同等重要的贡献类型。
4. **可解释的量化**——任何量化结果都必须可回溯到原始事件，否则会退化为"排行榜政治"。

## 五、参考来源

- DORA 指标: https://dora.dev/
- SPACE 框架（Microsoft Research）: https://dl.acm.org/doi/10.1145/3550356.3559083
- OpenSSF Scorecard: https://scorecard.dev/
- takesmartnotes.com（已验证 C6/C7）: https://takesmartnotes.com/
- AppFlowy-Cloud（已验证 C9）: https://github.com/AppFlowy-IO/AppFlowy-Cloud

> ⚠️ 本文件中"第三节"内容为本工作流范围之外的线索性资料，未做对抗核验。
