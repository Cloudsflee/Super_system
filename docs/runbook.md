# 运行与演示脚本

1. `pnpm dev` 启动本地服务。
2. 打开首页，确认 health 与 Local Owner。
3. 在 Project Wizard 创建项目。
4. 进入 Workflow Canvas，推荐并确认 5 节点工作流。
5. 进入 Node Workspace，编辑节点目标、验收标准和 allowed_tools，并用字段级 Assist 生成/应用草稿。
6. 生成 Context Pack Preview，查看质量自检、充分性 Gate、Memory Manifest 的 included/excluded/warnings。
7. 在 Runner 页面选择 MockRunner 或 CodexRunner；Codex live 可得到 succeeded/partial 并保留 raw trace，必要时可取消 queued/running Run。
8. 在 Asset/Digest 页面确认资产并生成 Digest。
9. 在 Git/PR 页面绑定 repo、创建 branch、捕获 diff、生成 commit 或 PR 草稿。
10. 打开复盘页查看证据链。

也可点击侧边栏“生成演示链路”快速生成样例数据；该链路包含 Decision、NodeRun、Confirmed Asset、Digest、CodeChange/PR 草稿，可直接打开复盘页展示证据链。
