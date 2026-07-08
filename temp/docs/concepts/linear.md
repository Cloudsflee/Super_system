# 产品研究：Linear

> 对应搜索角度：**行业产品与商业案例** / **设计哲学与专注机制**

## 一、摘要

Linear 是面向工程团队的现代项目管理工具，以"键盘优先、极致速度、零冗余"为设计哲学。它的产品宣言是"Issue tracking you'll enjoy using"——把传统 PM 工具（Jira）的形式主义全部剔除。

## 二、本轮核验事实

| # | 事实 | 证据 |
|---|------|------|
| N1 | 核心理念："fast as a feature"。Linear 设计师 Catherine Jue 撰文： "Rarely in software does anyone ask for 'fast.'" | catherinejue.com/fast。 |
| N2 | 键盘优先 + Command-K / 命令面板驱动的所有操作。 | 官网功能页与文档。 |
| N3 | 精简的视图层级（Issue / Project / Cycle / Roadmap），没有 Jira 式的史诗/故事/任务三级嵌套。 | 官网 docs。 |
| N4 | 支持 Triage、Cycles（sprint）、Projects、Roadmap、Initiatives。 | 官网产品页。 |
| N5 | 同步引擎是"速度感"的关键——本地优先缓存 + 后台同步，操作延迟感知 < 50ms。 | 多篇工程博客（Linear 官方 changelog）。 |

## 三、为何与本毕设高度相关

- **主旨 2（扁平化与贡献量化）**：Linear 把"贡献"定义为"创建/解决/评论 Issue"等可枚举原子事件，量化天然成立。
- **主旨 7（去形式化设计管理）**：Linear 是"去形式化 PM"的代表——它把 Jira 的"史诗 → 故事 → 任务 → 子任务"层级砍掉，让 PM 流程扁平化。
- **主旨 3（多模态展示）**：同一组 Issue 可在 List / Board / Timeline / Roadmap 视图间切换——多模态的范本。

## 四、对毕设的启示

1. **"速度是特性"**——毕设答辩演示时若每次交互 < 100ms，比任何 PPT 都更有说服力。
2. **砍掉冗余层级**——PM 工具的形式主义很大程度源于"层级过深"。建议毕设的任务模型只有 2 层（项目 + 任务），无中间层。
3. **键盘优先 = 命令面板一等公民**——所有功能应有快捷键；这是"超级个体"的肌肉记忆诉求。
4. **同步延迟感 < 50ms**——技术上的"乐观更新 + 后台同步"模式可参考 Linear 的实现。

## 五、参考来源

- Linear 官网: https://linear.app/
- Catherine Jue "Fast": https://www.catherinejue.com/fast
- Linear 文档: https://linear.app/docs

> ⚠️ 本文件为本轮补充核验资料，未做 3 票对抗式核验。
