# DesignSignal V5 基于 AIWS V2 重开发复盘与问题归档

> 文档状态：已归档，待按路线项关闭遗留问题
>
> 归档日期：2026-07-30（Asia/Shanghai）
>
> 覆盖区间：2026-07-28 至 2026-07-30
>
> AIWS 基线：`2.0.0` / state schema `20` / `286c4c26a2e72d87e0d3f910b314d848d3557a9f`
>
> DesignSignal 基线：`5.0.0` / `5833494e6fdc16201cc10ec8776578892e8d85b4`
>
> Workflow：`wex_43db2703497e4018aa`

## 1. 文档目的与审计口径

本文归档 DesignSignal V5 使用 AIWS V2 Workflow、Runner、可信验证器、Delivery 和 System Context 机制重新开发及验收时暴露的问题。本文不是发布说明，也不以 Workflow 最终显示绿色作为问题已关闭的依据。

文中的判断分为四类：

- **已验证事实**：可由不可变 SHA、Workflow execution、AcceptanceAsset、attestation、API 响应、CAS 记录或测试结果复核。
- **根因判断**：根据失败链、修复 diff 和复测结果形成的工程判断；若仍缺乏直接证据，会明确标记。
- **审计评价**：对系统价值、效率和完成语义的评价，不伪装成实验结论。
- **未知项**：没有对照实验、连续性能剖析或外部服务成功证据的事项，不作正向推断。

严重级别定义：

| 级别 | 定义                                                         |
| ---- | ------------------------------------------------------------ |
| `P0` | 造成数据或凭据泄漏、不可恢复损坏，或完全无法交付且无绕行方案 |
| `P1` | 阻断关键路径、导致错误完成结论，或要求修改平台后才能继续     |
| `P2` | 明显增加重试、人工介入或审计成本，但存在可控绕行方案         |
| `P3` | 局部体验、信息表达或非关键性能问题                           |

状态定义：`已修复` 表示修复已进入当前 AIWS SHA 并通过门禁；`已缓解` 表示本次交付可继续但机制缺口仍在；`未解决` 表示当前版本仍可复现或尚无验收证据；`产品缺口` 表示问题属于 DesignSignal 当前交付而不是 AIWS 平台实现。

## 2. 执行摘要

本次交付最终可运行、可复核且固定到了同一个 Git SHA。DesignSignal 的六个 HTTP 接口均返回 `200`，Dashboard 和 Scheduler 正常，安全头、静态资源、六视口截图、CAS 文件和可信 attestation 均形成了证据。Delivery 第一次拒绝全部 claims，第二次在明确记录限制后批准，说明 AIWS 确实阻止了未经证据支持的全量成功声明。

但本次也证明 AIWS V2 在真实重开发场景下尚未达到稳定生产工具的标准：

1. 核心 Runtime 任务经历 `8` 次 attempt 才完成，其中代理透传、Runner 输出结构、Compose 来源格式、静态资源类型和验证器异常均属于平台问题，而不是 DesignSignal 业务失败。
2. Workflow 共生成 `24` 条 execution，`13` 条被 supersede，占 `54.2%`。Goal 线程消耗 `10,453,420` tokens 和 `53,594` 秒，不能称为高效开发。
3. Workflow 完成后仍残留 `47` 个 Context projection job，索引状态为 `empty`。只有手工 Owner rebuild 后，项目地图和中文检索才真正可用。
4. Workflow 最终状态为 `completed`，但报告只选出 `5/6` 条信号、来源仅 `12/15` healthy、Outbox 仍有 `1` 条 pending。当前完成模型混淆了“必要结果已满足”和“缺口已被记录”。
5. 平台在项目执行期间追加了六个修复提交。本轮实质上不是单纯“用成熟 AIWS 开发 DesignSignal”，而是“边开发 DesignSignal，边把 AIWS 修到能够完成该场景”。

尖锐结论如下：

> AIWS 本轮对**可追溯性、证据约束和拒绝虚假 claim**有明显帮助；对**开发速度、首次成功率和上下文检索效率**没有形成正向证据，且实际表现偏负。最终绿灯证明的是修复后的系统能够完成审计闭环，不证明原始 V2 机制已经高效，也不证明 DesignSignal 的全部产品目标已经完成。

## 3. 最终状态与不可变标识

### 3.1 仓库与运行态

| 对象                    | 最终状态                                                          |
| ----------------------- | ----------------------------------------------------------------- |
| AIWS repository         | `https://github.com/Cloudsflee/Super_system`                      |
| AIWS commit             | `286c4c26a2e72d87e0d3f910b314d848d3557a9f`                        |
| AIWS Docker             | `aiws-app:2.0.0`，`http://127.0.0.1:4317`                         |
| AIWS health             | version `2.0.0`，schema `20`                                      |
| DesignSignal repository | `https://github.com/Cloudsflee/designsignal-v5-replay`            |
| DesignSignal commit     | `5833494e6fdc16201cc10ec8776578892e8d85b4`                        |
| DesignSignal Docker     | `http://127.0.0.1:3385`                                           |
| DesignSignal health     | version `5.0.0`，mode `live`，storage writable，Scheduler running |
| Workflow                | `wex_43db2703497e4018aa`，`completed`                             |
| Workflow 完成时间       | `2026-07-29T20:59:35.929Z`，即上海时间 `2026-07-30 04:59:35`      |

### 3.2 运行验收事实

以下接口在最终验收时均为 `200`：

- `GET /healthz`
- `GET /api/reports/latest`
- `GET /api/reports/2026-07-29`
- `GET /api/syllabus`
- `GET /api/sources/health`
- `GET /api/outbox`

最终 `/healthz` 记录：

| 字段               | 值                                                 |
| ------------------ | -------------------------------------------------- |
| `version`          | `5.0.0`                                            |
| `mode`             | `live`                                             |
| `storageWritable`  | `true`                                             |
| `latestReportDate` | `2026-07-29`                                       |
| `nextRunAt`        | `2026-07-30T15:50:00Z`，对应 Asia/Shanghai `23:50` |
| `timeZone`         | `Asia/Shanghai`                                    |

最终验证确认六类安全头存在：`Content-Security-Policy`、`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy` 和 `Cross-Origin-Opener-Policy`。

固定 SHA 中 `assets/styles.css` 与 `3385` 实际响应字节一致，SHA-256 为：

```text
1d4ca9efb2652908ce4c577f3c54d30b08da0cddb449d941d0035a12f390239c
```

### 3.3 可信证据与审批链

| 阶段               | 标识                          | 结果                                      |
| ------------------ | ----------------------------- | ----------------------------------------- |
| Runtime attempt 8  | `tex_87d973642ba5402c9e`      | 完成，固定 DesignSignal SHA               |
| Delivery attempt 1 | `tex_08714091bb604a52b0`      | `human_changes_requested`                 |
| 首次资产版本       | `av_091d22e470274b12bc`       | 被拒绝                                    |
| 首次 attestation   | `aat_a4fcac100dfb4ba687`      | decision `rejected`，accepted claims 为空 |
| Delivery attempt 2 | `tex_549ccd2b85fc432c9c`      | 完成                                      |
| 最终资产版本       | `av_6a94a1dbfe9b4d24b2`       | 批准                                      |
| 最终 attestation   | `aat_526b3a16a13d467ab0`      | decision `accepted`                       |
| 最终 effect claim  | `ec_fd77806f6e0929885aeeef05` | 已记录                                    |

可信 verifier 生成 `1` 份报告和 `6` 张视口截图，共 `7` 个文件，并完成 CAS 与 attestation。截图原件位于未跟踪临时审查目录，不纳入 AIWS 仓库；不可变报告、manifest、哈希和 attestation 作为审计依据。

## 4. 项目时间线

Workflow execution 原始时间使用 UTC，以下统一换算为 Asia/Shanghai：

| 时间                                 | 事件                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| 2026-07-28 13:40                     | Workflow 和 11 个逻辑任务创建                                                     |
| 2026-07-28 13:41 至 13:49            | Authority、Architecture、Baseline Review 完成                                     |
| 2026-07-28 15:42 至 16:46            | Collection 连续因 dependency、approval 和 forbidden diff 进入重试，attempt 4 完成 |
| 2026-07-29 12:57                     | Analysis attempt 1 因 `repository_secret_scan_failed` 结束，attempt 2 随即完成    |
| 2026-07-29 13:55                     | DesignSignal 固定候选 SHA `5833494...` 形成                                       |
| 2026-07-29 14:11 至 14:34            | Verification attempt 1 失败，attempt 2 完成                                       |
| 2026-07-29 16:47                     | AIWS 修复 deploy task executor                                                    |
| 2026-07-29 17:13                     | AIWS 修复只读 runtime verification                                                |
| 2026-07-29 17:30                     | Web 测试改为串行，降低相互干扰                                                    |
| 2026-07-29 19:29                     | Docker Runner 获得浏览器验证能力                                                  |
| 2026-07-29 21:40                     | AIWS 加入可信部署证据 verifier 与 attestation                                     |
| 2026-07-29 16:56 至 2026-07-30 04:34 | Runtime attempts 1 至 7 依次失败或被 supersede                                    |
| 2026-07-30 04:34 至 04:40            | Runtime attempt 8 完成                                                            |
| 2026-07-30 04:41 至 04:49            | Delivery attempt 1 被人审拒绝                                                     |
| 2026-07-30 04:51 至 04:59            | Delivery attempt 2 在明确限制后完成，Workflow 变为 `completed`                    |
| 2026-07-30 05:10                     | AIWS 提交代理、验证器协议和构建缓存的最终加固修复 `286c4c2`                       |
| Workflow 完成后                      | 发现 Context 仍有 47 个 pending job 且索引为空；手工 rebuild 后恢复               |

从 Workflow 创建到完成的墙钟时间约为 `39 小时 18 分 39 秒`。这段时间包含等待、审批、开发、平台修复和重试，不能等同于纯编码工时。

## 5. Workflow 尝试与失败统计

### 5.1 按任务汇总

| 逻辑任务        | 尝试数 | 最终状态  | 先前失败或阻断                                                                                                                                          |
| --------------- | -----: | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analysis        |      2 | completed | `repository_secret_scan_failed`                                                                                                                         |
| Architecture    |      1 | completed | 无                                                                                                                                                      |
| Authority       |      1 | completed | 无                                                                                                                                                      |
| Baseline Review |      1 | completed | 无                                                                                                                                                      |
| Candidate       |      1 | completed | 无                                                                                                                                                      |
| Collection      |      4 | completed | `task_dependency_blocked`、`delivery_policy_approval_required`、`repository_verify_diff_forbidden`                                                      |
| Dashboard       |      1 | completed | 无                                                                                                                                                      |
| Delivery        |      2 | completed | `human_changes_requested`                                                                                                                               |
| Operations      |      1 | completed | 无                                                                                                                                                      |
| Runtime         |      8 | completed | `pull_request_intent_no_changes`、3 次 `task_runner_result_unsuccessful`、`trusted_verifier_required`、`runner_upstream_unavailable`、`node_run_failed` |
| Verification    |      2 | completed | `repository_verify_failed`                                                                                                                              |

### 5.2 定量结果

| 指标                 |          结果 | 审计解释                                     |
| -------------------- | ------------: | -------------------------------------------- |
| 逻辑任务             |            11 | 最终均到达 completed                         |
| execution 总数       |            24 | 包含历史 attempt                             |
| completed execution  |            11 | 每个逻辑任务的最终 attempt                   |
| superseded execution |            13 | 占全部 execution `54.2%`                     |
| Runtime 首次成功率   |         `1/8` | 最关键交付任务仅 attempt 8 成功              |
| Goal tokens          |  `10,453,420` | 极高；无同项目对照组，不能计算 AIWS 的净节省 |
| Goal 时间            |   `53,594` 秒 | 约 `14 小时 53 分 14 秒` 的线程活动时间      |
| 完整 `pnpm verify`   | 约 `543.9` 秒 | 一次完整运行                                 |
| pre-push gates       | 约 `481.5` 秒 | 紧接着再次执行大量重叠门禁                   |

`completed execution / execution 总数` 不是产出效率的严格定义，但 `45.8%` 的 attempt 留存率足以说明重试成本不可忽略。尤其 Runtime 的失败大部分发生在平台与验证边界，不能全部归咎于产品代码。

## 6. 问题总表

| ID        | 级别 | 状态     | 问题                                                                 |
| --------- | ---- | -------- | -------------------------------------------------------------------- |
| `SYS-01`  | P1   | 已修复   | Runner 未继承本地代理变量，网络行为与宿主机不一致                    |
| `SYS-02`  | P1   | 已修复   | Runner 端点结果结构漂移，verifier 对布尔值执行迭代并抛裸 `TypeError` |
| `SYS-03`  | P1   | 已修复   | Compose 证据来源存在多种结构，verifier 只接受单一路径                |
| `SYS-04`  | P1   | 已修复   | 静态资产无强类型，CSS/JS 被当作图像解码                              |
| `SYS-05`  | P1   | 未解决   | verifier 失败后不能只重放验证，必须重跑完整 Runtime attempt          |
| `SYS-06`  | P1   | 已修复   | 浏览器验证与可信 attestation 能力在项目中途才补齐                    |
| `SYS-07`  | P2   | 未解决   | Runner 匿名 GitHub clone 与宿主机行为不一致                          |
| `SYS-08`  | P2   | 未解决   | 通用错误码掩盖实际失败阶段和原始原因                                 |
| `CTX-01`  | P1   | 已缓解   | Workflow 完成后投影任务未自动收敛，索引仍为 `empty`                  |
| `CTX-02`  | P2   | 未解决   | Context 对开发效率的收益不可证，低成本地图未形成闭环指标             |
| `GOV-01`  | P1   | 未解决   | `completed` 未区分成果完整与“缺口已记录”                             |
| `GOV-02`  | P1   | 未解决   | rejected/limited claim 可以通过文字披露后进入总体绿色完成态          |
| `GOV-03`  | P2   | 未解决   | 审批和仓库门禁发现过晚，以重跑代替前置裁决                           |
| `OPS-01`  | P1   | 未解决   | 高负载时 API 与执行任务竞争资源并出现查询超时                        |
| `OPS-02`  | P2   | 未解决   | verify 与 pre-push 重复执行重叠门禁                                  |
| `OPS-03`  | P2   | 未解决   | 缺少按阶段的耗时、缓存命中、重试原因和资源观测                       |
| `PROD-01` | P1   | 产品缺口 | live report 只达到 `5/6`，缺少 1 条 UI 信号                          |
| `PROD-02` | P2   | 产品缺口 | 15 个来源中 3 个 degraded                                            |
| `PROD-03` | P1   | 产品缺口 | Outbox 有 1 条 pending，外部投递未完成                               |
| `PROD-04` | P2   | 产品缺口 | 新版证据正文和研究深度仍弱于旧版                                     |
| `PROD-05` | P2   | 产品缺口 | 只有延迟观测值，没有可验收的性能 SLO                                 |
| `PROD-06` | P2   | 证据不足 | 匿名 public clone 未验证成功                                         |

## 7. 系统可靠性问题

### SYS-01：Runner 代理环境未透传

- **发现阶段**：Runtime attempt 5。
- **可复现表现**：execution `tex_fe4446c8751748f5b5` 以 `runner_upstream_unavailable` 结束；同一宿主机在本地代理下可以访问远端，Runner 内部却无法稳定访问。
- **根因**：容器启动配置没有完整透传大小写代理变量，宿主和 Runner 的网络前提不一致；任务启动前也没有网络预检。
- **影响**：单次 attempt 从上海时间 `00:04:36` 运行到 `03:59:10` 后失败，浪费约 3 小时 55 分的墙钟时间；错误被错误地呈现为上游不可用，而不是执行环境配置缺失。
- **已采取修复**：`286c4c2` 在 Compose 和 Runner 配置中透传代理环境，并覆盖大小写形式。
- **遗留风险**：变量存在不代表代理实际可达；`NO_PROXY`、DNS、Git、Node fetch 和浏览器可能仍采用不同代理逻辑。
- **必须补充的测试**：启动 Runner 前分别执行 DNS、HTTPS、Git `ls-remote` 和浏览器请求预检；结果应记录使用的代理模式但不得记录代理凭据或完整 URL。

### SYS-02：部署证据协议漂移导致 verifier 裸异常

- **发现阶段**：Runtime attempt 7 的 Runner 已成功，随后 verifier 失败。
- **可复现表现**：verifier 把 `candidate.api.passed` 的 boolean 当作 iterable，抛出未经领域化包装的 `TypeError`。实际 Runner 证据还出现 `api.GET`、`api.get` 和 `api.checks` 三种结构。
- **根因**：Runner 与 verifier 之间没有固定版本的 JSON Schema；生产代码依赖某个测试样例的隐式结构，兼容解析和错误归一化不足。
- **影响**：一个本可定位为“证据协议不兼容”的错误被升级成整个 NodeRun 失败；已有成功部署证据不能复用。
- **已采取修复**：`286c4c2` 增加端点结构兼容、security header object map 兼容和真实 Runner shape 回归测试。
- **遗留风险**：兼容分支只能追赶已见过的形状，不能替代生产者与消费者共同验证的 versioned schema。
- **必须补充的测试**：为 deployment evidence 定义 `schema_version`；生产者写入前和 verifier 读取前分别校验；非法结构返回 `deployment_evidence_schema_invalid` 及 JSON Pointer，禁止再次出现裸 `TypeError`。

### SYS-03：Compose 来源结构漂移

- **发现阶段**：部署证据验证。
- **可复现表现**：证据既可能直接提供 `compose.file`，也可能通过 `compose.derived_from` 指向容器内 `/workspace/compose.yml`。
- **根因**：不同执行器对同一来源事实使用不同字段和路径表示，verifier 把表现形式误当作唯一协议。
- **影响**：合法部署被拒绝；路径处理如果只做字符串拼接，还可能引入目录穿越风险。
- **已采取修复**：`286c4c2` 支持两类来源，并加入安全归一化和目录穿越拒绝。
- **遗留风险**：路径仍是环境相关表达，长期应以 CAS digest、repository-relative path 和 source attestation 表达来源。
- **必须补充的测试**：覆盖 Windows/Linux 分隔符、绝对容器路径、相对路径、符号链接、`..`、不存在文件和 digest 不匹配。

### SYS-04：静态资产类型不可信

- **发现阶段**：部署图片验证。
- **可复现表现**：`images.static_assets` 同时包含 CSS、JavaScript 和 PNG；verifier 对所有项目调用图像解码器。
- **根因**：字段名称承担了类型保证，但生产者没有强制 MIME/role，消费者也没有进行双重 sniff。
- **影响**：正常 CSS/JS 资产导致图像验证失败，制造与页面真实质量无关的假阴性。
- **已采取修复**：`286c4c2` 只对确认的图像类型执行解码，并增加回归测试。
- **遗留风险**：仅依赖扩展名或声明 MIME 仍可能被伪造。
- **必须补充的测试**：资产记录应包含 `role`、`declared_mime`、`sniffed_mime`、`sha256`；图像验证仅接受声明、内容 sniff 和解码三者一致。

### SYS-05：缺少 verification-only replay

- **发现阶段**：Runtime attempts 7 至 8。
- **可复现表现**：attempt 7 的 Runner 工作已经成功，失败发生在后置 verifier；系统只能创建 attempt 8 并重复完整运行。
- **根因**：执行、证据采集、可信验证和 promotion 被绑定为一个不可分的 attempt；没有可验证输入哈希对应的阶段 checkpoint。
- **影响**：浪费算力和时间，增加网络波动、外部数据变化和非确定性风险；重跑结果理论上可能不再等同于首次成功结果。
- **当前状态**：未解决。attempt 8 完成交付只是绕行，不是机制修复。
- **建议设计**：将 `execute -> collect -> verify -> attest -> promote` 建模为独立、幂等阶段；当 input SHA、image digest、policy snapshot 和 evidence hash 未变化时，允许只重放失败阶段。
- **退出标准**：注入 verifier 故障后，Runner 仅运行一次；恢复 verifier 后复用同一 evidence digest 完成 attestation，且审计链明确记录 replay。

### SYS-06：关键验证能力在项目中途补齐

- **发现阶段**：Runtime attempts 2 至 4。
- **可复现表现**：先后出现 `task_runner_result_unsuccessful` 和 `trusted_verifier_required`；AIWS 在项目运行期间才加入浏览器验证、部署证据 verifier 和 attestation。
- **根因**：V2 发布门禁覆盖了 Context 功能，但没有用真实 Docker 产品交付验证 Runner 能力矩阵是否完整。
- **影响**：业务项目被迫承担平台集成测试职责；交付时间线和成本无法再单纯归属于 DesignSignal。
- **已采取修复**：`e323afa` 增加 Docker Runner 浏览器能力，`1ea8f95` 增加可信 verifier 和 attestation，后续由 `286c4c2` 加固。
- **遗留风险**：未来新工具仍可能只在 Host 测试存在，Runner 镜像、scope、MCP registry 或只读模式中缺失。
- **必须补充的测试**：发布前运行 capability matrix journey，至少覆盖 Host、app container、managed Runner、read-only Runner 和 Assist executor 五种环境。

### SYS-07：匿名 GitHub clone 行为不一致

- **发现阶段**：最终空克隆验收。
- **可复现表现**：Runner 内执行 anonymous HTTPS clone 时触发凭据请求并失败；宿主机经本地代理可执行 `git ls-remote`。最终只验证了授权路径或本地 Git object 形成的 clean clone。
- **根因判断**：尚未完全确认。候选原因包括代理差异、Git credential helper、GitHub 仓库可见性、URL rewrite 或 Runner 环境变量差异。
- **影响**：不能接受“任何匿名用户都能从公开 GitHub URL 空克隆运行”的 claim。
- **当前状态**：未解决，且最终 AcceptanceAsset 已明确限制该 claim。
- **退出标准**：在无 credential helper、无 token、隔离 HOME 的 Runner 中对目标 URL 完成 `ls-remote`、clone、checkout 固定 SHA、`npm ci` 和测试；全过程证明未读取 Vault。

### SYS-08：错误分类粒度不足

- **发现阶段**：Runtime attempts 2、3、6、7。
- **可复现表现**：三次失败只给出 `task_runner_result_unsuccessful`，另一次为宽泛的 `node_run_failed`；真正的验证器 `TypeError` 需要进一步查执行资产才能定位。
- **根因**：边界层覆盖了子阶段错误，错误 envelope 未保存 `stage`、`cause_code`、`retryability`、`evidence_ref` 和 sanitized detail。
- **影响**：自动重试策略失真，操作者无法从 Workflow 页面判断是产品测试、网络、协议还是 verifier 失败。
- **当前状态**：未解决。
- **退出标准**：所有 NodeRun 失败都返回稳定领域错误；UI 可直接显示失败阶段、是否可仅重放、关联证据和建议动作，日志中不泄漏密钥。

## 8. Context 机制问题

### CTX-01：Workflow 完成与投影新鲜度脱节

- **发现阶段**：Workflow 已变为 `completed` 后的 Context 验收。
- **可复现表现**：全局状态有 `47` 个 pending projection jobs，全文索引为 `empty`。读取 Context Map 前必须手工调用 Owner rebuild。
- **根因**：业务事务只保证写入 dirty job，不保证后台 projector 在可接受时间内运行并收敛；发布/Workflow 完成门禁也未检查 Context freshness。
- **影响**：AIWS V2 的核心新机制在最需要复盘时不可用；如果读取端未执行严格 fresh check，甚至可能出现元数据存在但正文或索引陈旧的误导状态。
- **本次缓解**：手工 rebuild 后 `47/47` 成功物化、`0` failed、pending 归零，index 变为 `ready`。
- **重建后证据**：全局 `3108` nodes、`8596` document versions、`3400` edges、`56` selections；索引含 `3107` nodes。项目地图含 `162` nodes 和 `175` edges，中文搜索“设计信号”命中正确项目节点。
- **快照哈希**：全局索引 `04d3ea7af98ccf19354b7db821dfb2d706da946732e920bdfec9474c3c087274`；项目地图 `1362327e2cc6df10f3baeab4b05437bf947d574846f5a0dcbd3955c18dcbf433`。
- **遗留风险**：手工 rebuild 是恢复手段，不是生命周期闭环；下一次长 Workflow 仍可能积压。
- **退出标准**：dirty job p95 延迟小于 60 秒；进程重启自动恢复；Workflow 完成前检查本 Workflow 相关节点已物化；index 损坏可自动重建；失败返回 `context_projection_unavailable`。

### CTX-02：新机制的开发效率收益尚不可证

- **观察**：最终地图、关系、版本和 selection 审计显著提高了复盘定位能力；但本轮仍消耗 `10.45M` tokens，并出现大量重复 attempt。
- **证据边界**：没有“同一任务、同一模型、同一代码基线、不使用 Context V2”的受控对照，因此不能计算 token 节省或时间收益。
- **问题**：系统记录了 `56` 次 selection，却没有形成每次选择的 precision、被实际引用率、重复读取率、节省 token、过期拒绝率和对结果的贡献指标。
- **审计评价**：Context V2 在本轮主要贡献是**事后可观测性**，不是已被证明的**事中生产率提升**。
- **退出标准**：对一组固定项目执行 A/B replay；记录 map token、展开 token、引用命中、重复读取、任务成功率和总耗时；只有达到预设阈值后才能宣称“新机制降低成本”。

## 9. 治理与完成语义问题

### GOV-01：`completed` 过度压缩真实结果

- **可复现表现**：Workflow 是绿色 `completed`，但最终 live report 为 `5/6`、来源健康为 `12/15`、Outbox 为 pending `1`。
- **根因**：Workflow 完成状态主要表达 DAG 已闭合、任务已有终态和资产已审批，没有把产品必要 outcome 作为一等实体参与最终状态计算。
- **影响**：管理者只看列表或绿色状态会得出“产品全部完成”的错误结论；审计者必须深入 AcceptanceAsset 才能看到缺口。
- **当前状态**：未解决。
- **建议状态模型**：至少支持 `completed`、`completed_with_gaps`、`waived` 和 `failed`。其中 `waived` 必须有授权人、原因、范围和有效期。
- **退出标准**：任何 mandatory outcome 为 rejected、missing 或 pending 时，Workflow 不得显示纯 `completed`；API、UI、MCP 和导出保持相同语义。

### GOV-02：披露限制与满足要求被混为一谈

- **可复现表现**：第一次 Delivery 正确拒绝全部 claims；第二次通过明确写入 limitation/rejected claim 获得批准，随后 Workflow 总体变绿。
- **正面价值**：系统没有伪造 UI 配额、public clone 或性能 SLO 证据，限制被保留在最终资产中。
- **问题**：记录“没有完成”满足了审计要求，却被上层状态解释为“任务完成”。审计完整性和成果完整性是两个不同维度。
- **影响**：团队可能通过完善免责声明关闭本应继续执行的必要业务任务。
- **建议模型**：AcceptanceAsset 同时输出 `evidence_decision` 和 `outcome_decision`；前者判断陈述是否诚实，后者判断要求是否满足。诚实地报告失败应得到 `evidence_decision=accepted`，但 outcome 仍可为 `incomplete`。
- **退出标准**：以本次 `5/6 + pending outbox` fixture 回归，资产可被证明“陈述可信”，Workflow 必须落在 `completed_with_gaps` 而非 `completed`。

### GOV-03：门禁位置过晚

- **可复现表现**：Collection 到第 2、3 次 attempt 才发现 approval 和 forbidden diff；Runtime 到第 4 次才发现 trusted verifier 必需。
- **根因**：权限、交付策略、diff policy 和能力要求没有在 dispatch 前一次性求值，而是在任务运行后逐层暴露。
- **影响**：本来可以毫秒级拒绝的配置问题消耗完整 attempt，并使重试历史膨胀。
- **当前状态**：未解决。
- **退出标准**：dispatch preflight 一次返回全部 blocking conditions；配置未变化时禁止创建内容相同的新 attempt；UI 直接引导审批或策略修正。

## 10. 性能与可观测性问题

### OPS-01：API 与执行负载缺少隔离

- **观察**：高负载阶段 app 约 `107%` CPU、约 `2.4 GiB` 内存，同时 API 查询曾超时。
- **证据限制**：这是单次运行阶段的采样，不是持续 profile，也不是 p95/p99 指标；不能据此断言长期资源泄漏。
- **风险**：状态投影、索引、验证、测试和交互 API 共享资源时，控制面在最需要诊断时反而不可用。
- **当前状态**：未解决。
- **退出标准**：在 10,000 节点和并发 NodeRun 压测下，交互 API p95/p99、event loop lag、RSS、CPU 和队列延迟均有门槛；projector/verifier 使用独立 worker 或并发配额。

### OPS-02：完整门禁重复执行

- **可复现表现**：一次 `pnpm verify` 约 `543.9` 秒，随后 pre-push 再运行约 `481.5` 秒的重叠门禁，总计约 `1025.4` 秒。
- **根因**：门禁没有基于 Git tree SHA、工具链版本和环境指纹复用可信结果；pre-push 默认不识别刚完成的等价验证。
- **影响**：单次推送增加约 8 分钟重复等待，并扩大 CPU 竞争。
- **当前状态**：未解决。
- **退出标准**：相同 tree、lockfile、Node/pnpm 版本和门禁定义命中本地 attested cache；只重跑受影响套件和不可缓存的 live checks；缓存失效规则可审计。

### OPS-03：缺少阶段化观测

- **可复现表现**：execution 有起止时间和顶层错误码，但无法直接回答 Runner、下载、测试、浏览器、verifier、attestation、Context projection 各自耗时和资源使用。
- **影响**：无法准确量化本次 39 小时中有多少属于等待、平台修复、模型执行、测试或人工审批，也无法判断 Context 是否节省 token。
- **当前状态**：未解决。
- **退出标准**：所有 execution 产出统一 stage spans，至少包含 duration、queue time、attempt/replay、cache hit、input/output hash、sanitized failure code 和资源摘要。

## 11. DesignSignal 产品遗留问题

### PROD-01：日报配额未完成

- **事实**：最终 report `selection.complete=false`，总数 `5/6`；`frontier=2`、`paper=2`、`product=1`、`ui=0`，缺少 `1` 条 UI 信号。
- **当前处理**：系统正确暴露 shortage，没有伪造替代记录。
- **风险**：用户期望的每日固定信息结构不完整；长期缺少某一类别会削弱训练计划。
- **退出标准**：连续 14 个 live run 达到配额，或产品正式改为带类别降级策略的新契约；任何替代都必须保留来源类别和降级原因。

### PROD-02：来源健康不足

最终 `15` 个来源中 `12` 个 healthy、`3` 个 degraded：

| 来源                  | 错误                |  观察延迟 |
| --------------------- | ------------------- | --------: |
| OpenAlex Design & HCI | `source_http_error` | `60748ms` |
| 浙江大学 IDI          | `ECONNRESET`        | `16703ms` |
| OpenAI Research       | `source_http_error` |  `3950ms` |

- **风险**：OpenAlex 长超时占用采集窗口；UI 缺额虽不直接来自上述三个 degraded source，但整体来源冗余仍不足。
- **退出标准**：为每类配额配置至少两个独立健康来源；区分 HTTP 状态、DNS、TLS、代理和解析失败；设置合理超时、退避和熔断。

### PROD-03：外部投递未完成

- **事实**：Outbox 共 `1` 条消息，状态 `pending`、attempts `0`、sent `0`，错误码为 `push_secret_missing`。
- **安全性**：Outbox 只保存环境变量引用 `DESIGNSIGNAL_WEBHOOK_URL`，没有保存 webhook 值，行为符合密钥隔离要求。
- **问题**：报告生成成功不等于通知已送达；当前 Workflow 总状态未显式反映投递缺口。
- **退出标准**：配置授权 secret 后执行 outbox retry，记录外部端确认和 `sentAt`；若投递是 mandatory outcome，完成状态必须随之更新。

### PROD-04：研究深度和证据显式程度退步

匿名盲评中，新版 `3385` 在信息层级、移动端重排、状态可读性、图像可靠性和日常操作效率方面胜出；旧版 `3379` 在研究内容深度、证据显式程度和执行链细节方面更强。旧版存在两张可见 broken image，新版没有 broken image。

这意味着新版主要解决了“能稳定看、能快速扫、能审计状态”，但没有同时证明“研究内容更深”。UI 改善不能替代证据正文密度。

- **退出标准**：建立内容质量 rubric，至少覆盖原始证据引用、反证、推理链、置信度、与 337/902 考纲映射和练习可执行性；盲评不得只比较视觉完成度。

### PROD-05：性能 claim 没有 SLO

- **事实**：最终报告记录了接口和页面耗时，但没有明确 threshold 或独立 performance section。
- **结果**：Delivery 正确拒绝“性能通过阈值 SLO”的 claim，只接受观测值。
- **退出标准**：定义目标环境、样本数、warm/cold 条件及 p50/p95/p99 阈值，失败时阻断相应 claim。

### PROD-06：公开可克隆性证据不足

- **事实**：仓库 URL 和固定 SHA 已交付；授权 clean clone、本地 Git object checkout、`npm ci`、`40/40` tests、doctor 和 fixture dry-run 已通过。
- **缺口**：anonymous public HTTPS clone 在 Runner 中失败，因此不能声称公开匿名克隆已验证。
- **退出标准**：先确认仓库公开可见，再按 SYS-07 的隔离环境完成全链路 clone 验收。

## 12. 合理治理成本与系统意外成本

### 12.1 合理且应保留的成本

以下门禁虽然增加时间，但目的成立，不应因本次重试多而直接删除：

- repository secret scan，前提是错误可定位、误报可解释。
- forbidden diff 和 Project ACL，防止验证任务修改不允许的范围。
- Delivery policy approval 和人审拒绝，防止未经授权的发布。
- trusted verifier、CAS hash、attestation 和固定 SHA，防止“在另一份代码上验证”。
- 六视口浏览器验证、安全头检查和静态资源字节比对。
- 对不成立的 UI quota、public clone、performance SLO claim 明确拒绝。
- 密钥只保存引用，Outbox 和 Context 不持久化原始凭据。

这些机制的价值在于提高结论可信度。问题不是“有门禁”，而是门禁发现太晚、错误不透明、通过后不能缓存复用。

### 12.2 不应接受的系统意外成本

- Runner 未继承代理导致近 4 小时 attempt 最终失败。
- verifier 对 boolean 做迭代并抛裸 `TypeError`。
- 同一 API、Compose 和静态资产证据存在未版本化的多种 shape。
- 后置 verifier 故障迫使完整 Runtime 重跑。
- Workflow 已完成但 Context 仍有 47 个 pending job、index 为空。
- 三次 `task_runner_result_unsuccessful` 无法从顶层错误定位原因。
- 完整 verify 后 pre-push 再重复大部分工作。
- 高负载时诊断 API 超时。
- Host 与 Runner 的 GitHub 访问行为不一致。

这些成本不产生额外产品价值，应该通过协议、预检、幂等 replay、缓存和资源隔离消除。

## 13. AIWS 对本项目的实际帮助评价

以下评分是基于本次单项目证据的审计判断，满分 5 分，不是统计实验：

| 维度           | 评分 | 评价                                                                              |
| -------------- | ---: | --------------------------------------------------------------------------------- |
| 可追溯性       |  5/5 | task、attempt、asset version、claim、attestation、SHA 和 Context 关系可以串联复核 |
| 防止虚假声明   |  4/5 | 首次 Delivery 全拒绝，最终限制项保留；但总体完成语义仍过度乐观                    |
| 可恢复性       |  3/5 | 能通过重试和手工 rebuild 恢复，但缺少 verification-only replay 和自动投影收敛     |
| Context 实用性 |  2/5 | 重建后检索有效，执行完成时却不可用；没有 token 节省证据                           |
| 执行可靠性     |  2/5 | 关键 Runtime 仅第 8 次成功，并迫使平台连续修复                                    |
| 开发效率       |  1/5 | 10.45M tokens、39 小时墙钟、54.2% superseded，当前结果不能支持“提效”结论          |
| 最终产品质量   |  3/5 | 可运行、UI 和运维更稳，但日报、投递、内容深度、SLO 和匿名 clone 均有缺口          |

综合评价：AIWS 对本次项目**有帮助，但帮助主要发生在审计和约束层，而不是生产率层**。它让团队能够准确回答“哪一个 SHA、哪次执行、哪些 claim 有证据”，也迫使交付资产承认未完成项；与此同时，它自身的执行和投影缺陷显著延长了项目。若没有这些治理能力，最终声明可能更快但更不可信；若平台实现成熟，本轮又不应付出现在这么高的系统性重试成本。

## 14. 根因归纳

本次问题可归并为六个结构性根因：

1. **协议未版本化**：Runner、verifier、Compose 和资源清单依赖隐式 JSON shape。
2. **阶段过度耦合**：执行、采集、验证、attest 和 promotion 不能独立重放。
3. **完成模型过粗**：DAG 关闭、陈述可信和业务 outcome 满足被压缩成一个 `completed`。
4. **投影只写 dirty、不保证收敛**：Context 生命周期在事务层完整，在运行层不完整。
5. **环境一致性不足**：Host、app container、managed Runner 和浏览器的网络、Git、工具能力不同。
6. **门禁与观测缺少成本意识**：晚发现、全量重跑、无缓存和通用错误码共同放大失败成本。

## 15. 优化路线

### 15.1 V2.0.1：先修关键可靠性闭环

目标：不改变大模型和产品设计，先消除本轮已经证实的假失败与整段重跑。

| 工作项                               | 验收条件                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Versioned deployment evidence schema | 生产者和消费者双向 schema 校验；非法字段返回 JSON Pointer，不出现裸异常         |
| Runner network preflight             | Git、HTTPS、DNS、Node fetch、浏览器在 dispatch 前完成一致性检查；代理值被脱敏   |
| Verification-only replay             | verifier 故障恢复后复用同一 evidence hash，不重新运行产品构建和部署             |
| Structured failure envelope          | 顶层包含 stage、cause、retry class、evidence ref 和安全 detail                  |
| Context projector watchdog           | pending 自动消费，重启恢复，超过 60 秒告警；Workflow 完成校验相关节点 freshness |
| 资产强类型                           | CSS/JS/image 按 role 和 sniffed MIME 分流，目录穿越测试常驻                     |

### 15.2 V2.1：修正真实完成语义

目标：让绿色状态准确表达业务结果，而不只是流程闭合。

| 工作项                           | 验收条件                                                                   |
| -------------------------------- | -------------------------------------------------------------------------- |
| OutcomeRequirement 一等模型      | 每项要求标记 mandatory/optional、证据、owner、deadline 和状态              |
| 四态完成模型                     | `completed`、`completed_with_gaps`、`waived`、`failed` 在 REST/MCP/UI 一致 |
| 双重审批结论                     | 区分 evidence truthfulness 与 outcome satisfaction                         |
| Delivery/outbox 纳入 outcome     | mandatory 投递 pending 时不能纯 completed                                  |
| Context freshness 纳入 promotion | 相关节点正文、索引和 selection snapshot 均可复核后才 promotion             |

使用本次最终状态作为固定回归 fixture：`5/6`、`12/15` healthy、outbox pending `1` 必须得到 `completed_with_gaps`。

### 15.3 V2.2：降低 Workflow 和门禁成本

目标：减少无价值 attempt、重复测试和控制面资源竞争。

| 工作项                  | 验收条件                                                                |
| ----------------------- | ----------------------------------------------------------------------- |
| Dispatch 综合 preflight | 一次返回 ACL、approval、diff、tool、network 和 verifier 全部阻断项      |
| Attested gate cache     | 相同 tree/toolchain/policy 命中缓存；pre-push 不重复刚完成的完整 verify |
| DAG 阶段 checkpoint     | 每阶段有 input/output hash，失败只重放受影响部分                        |
| Worker 资源隔离         | NodeRun、projector、verifier 不拖垮交互 API；并发下 API p95 达标        |
| Stage telemetry         | 可以量化 queue、model、build、test、verify、approval 和 projection 耗时 |

建议硬指标：同类重放场景 superseded ratio 低于 `15%`，Runtime 首次成功率高于 `80%`，等价 pre-push 缓存命中后低于 `60` 秒。

### 15.4 V2.3：把产品质量而非仅流程质量纳入门禁

目标：避免“页面更稳定、证据更齐全，但内容变浅”。

| 工作项               | 验收条件                                                |
| -------------------- | ------------------------------------------------------- |
| 自动匿名基线盲评     | 候选/旧版标签随机化，保存 rubric、截图 hash 和裁决      |
| 内容证据密度门禁     | 每个结论有来源、原文证据、反证、置信度和考纲映射        |
| 类别完整性与降级契约 | 每类有冗余来源；shortage 的产品状态和 UI 表达固定       |
| 性能 SLO             | 明确环境、样本和 p95/p99 阈值，claim 可由 verifier 判定 |
| Delivery SLO         | outbox 重试、超时、告警和送达证明纳入 outcome           |

## 16. 优先级与责任边界

| 优先级 | 负责人边界           | 必须先处理的事项                                                         |
| ------ | -------------------- | ------------------------------------------------------------------------ |
| 1      | AIWS Platform        | `SYS-02` schema、`SYS-05` replay、`CTX-01` projector、`GOV-01` 完成语义  |
| 2      | AIWS Runtime/Ops     | `SYS-01` preflight、`SYS-08` 错误 envelope、`OPS-01` 隔离、`OPS-02` 缓存 |
| 3      | DesignSignal Product | 补齐 UI 类别、恢复 3 个来源、完成 Outbox 投递、定义性能 SLO              |
| 4      | Product + Governance | 内容深度 rubric、盲评、mandatory outcome 和 waiver 规则                  |

不应由 DesignSignal 业务代码继续兼容无限增长的 Runner 证据 shape；也不应由 AIWS 的 `completed` 状态替产品负责人决定业务缺口可以豁免。协议归 Platform，内容和投递目标归 Product，豁免归明确授权的 Governance owner。

## 17. 已知未知与禁止外推

- 没有受控 A/B 对照，不能声称 Context V2 节省了多少 token 或时间。
- 只有高负载时的 CPU/内存采样，没有连续 profile，不能声称存在内存泄漏。
- anonymous GitHub clone 未成功，不能将授权 clean clone 等同于公众可克隆。
- Outbox 仍 pending，不能声称外部通知已经送达。
- live report 为 `5/6`，不能声称每日固定配额已完整实现。
- 性能没有 threshold，不能把观察到的延迟写成“SLO 通过”。
- Workflow `completed` 只说明当前状态机闭合，不能单独证明所有业务 outcome 完成。
- Context rebuild 后搜索正确，只证明当前快照可用，不证明后台投影长期稳定。

## 18. 附录：证据索引

### 18.1 AIWS 修复提交

| Commit    | 时间（Asia/Shanghai） | 内容                                                    |
| --------- | --------------------- | ------------------------------------------------------- |
| `f5bc250` | 2026-07-29 16:47      | deploy task 改用 Assist executor                        |
| `e324229` | 2026-07-29 17:13      | 解锁只读 Runtime verification                           |
| `c1cc4b2` | 2026-07-29 17:30      | Web 测试串行化                                          |
| `e323afa` | 2026-07-29 19:29      | Docker Runner 浏览器验证能力                            |
| `1ea8f95` | 2026-07-29 21:40      | 可信部署 verifier 和 attestation                        |
| `286c4c2` | 2026-07-30 05:10      | 代理、证据 shape、Compose、静态资产、路径和构建缓存加固 |

### 18.2 Runtime attempt 链

| Attempt | Execution                | 结果                                           |
| ------: | ------------------------ | ---------------------------------------------- |
|       1 | `tex_d4d0fbfbe6024b5bbe` | `pull_request_intent_no_changes`               |
|       2 | `tex_8b6a119b2aa043bf8d` | `task_runner_result_unsuccessful`              |
|       3 | `tex_618d806f5d5446798b` | `task_runner_result_unsuccessful`              |
|       4 | `tex_b22ff22f1af245ef82` | `trusted_verifier_required`                    |
|       5 | `tex_fe4446c8751748f5b5` | `runner_upstream_unavailable`                  |
|       6 | `tex_2e4dc3b036f54a8bb8` | `task_runner_result_unsuccessful`              |
|       7 | `tex_023ab7c25bf4453f95` | `node_run_failed`，Runner 成功后 verifier 失败 |
|       8 | `tex_87d973642ba5402c9e` | completed                                      |

### 18.3 最终日报与 Outbox

| 对象                     | 标识或状态                                                         |
| ------------------------ | ------------------------------------------------------------------ |
| Report                   | `daily_20324e855247313ef7ec`                                       |
| Report date              | `2026-07-29`                                                       |
| Report integrity SHA-256 | `f0413382f33f69e88b833aa6aa41c8d145ca721d7d31c09ac006cdce20ae02e1` |
| Item count               | `5`                                                                |
| Selection complete       | `false`                                                            |
| Outbox message           | `msg_3e0706bdda2e93d71b83`                                         |
| Outbox status            | `pending`，`push_secret_missing`                                   |

### 18.4 相关仓库文档

- [V2.0 旧代码与兼容层审计](v2.0-code-audit.md)
- [V2.0 开发计划](../开发计划v2.0.md)
- [V2.0 测试计划](../测试计划v2.0.md)
- [运行手册](runbook.md)

## 19. 归档结论

DesignSignal V5 当前是一个**可运行、可固定 SHA、可由可信证据复核，但带有明确业务缺口的交付**。AIWS V2 当前是一个**审计能力强于执行成熟度、能约束结论但尚不能低成本稳定完成真实重开发的系统**。

后续最优先事项不是增加更多 Context 节点或继续扩展 UI，而是关闭四个基础缺口：证据协议版本化、verification-only replay、Context 自动收敛和真实完成语义。只有这四项通过固定回归场景，AIWS 才能把本轮展示出的治理价值转化为可重复的工程效率。
