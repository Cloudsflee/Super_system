# V3-Clean 运维 Runbook

状态：目标运行手册。代码尚未完成 clean runtime 实施时，本手册中的命令只
能作为接口和发布验收约定，不能被解释为当前 V6/R6 运行时已经支持。

规范依据：[`architecture/v3-clean-break.md`](architecture/v3-clean-break.md)、
[`architecture/import-contract.md`](architecture/import-contract.md) 和
[`architecture/api-v2-contract.md`](architecture/api-v2-contract.md)。

## 1. 运行边界

- 生产业务只挂载 `v3-clean` schema family 和 clean CAS root。
- 历史 V2.3/V3 数据卷、旧 migration、旧 CAS 和旧 runtime 只能作为离线
  importer 输入，不能被 App 启动时打开。
- App、Broker、Runner、Parser Worker、Windows Bridge 和 MCP Gateway 使用
  独立 profile；Gateway 不持久化业务数据，也不挂 Docker socket。
- 所有公开业务请求走 `/api/v2`。健康探针是 `/livez` 和 `/readyz`；历史
  路由不作为兼容入口恢复。

## 2. 发布前 preflight

1. 确认旧系统已停止写入，保存 V2.3 和当前 V3 的 byte-level snapshot、
   CAS manifest、schema fingerprint 和 source receipt。
2. 确认目标镜像、Runner digest、Parser worker profile、锁文件和 SBOM
   绑定同一 source commit。
3. 确认凭据只提供重新绑定所需的元数据；secret、token、cookie 和旧 Vault
   密文不进入输入卷。
4. 在临时卷执行架构扫描、schema checksum、外键和 CAS manifest 检查。
5. 只有所有报告为 `passed` 才能进入 importer。

## 3. 一次性 Importer 流程

以下是离线工具的规范命令；实现完成前不得把它们伪装成现有 `pnpm` 脚本。

```text
aiws-import inspect --manifest INPUT.json --report INSPECT.json
aiws-import dry-run --sources SOURCES.json --merge MERGE.json --out PLAN.json
aiws-import run --plan PLAN.json --target TEMP_VOLUME --checkpoint CHECKPOINT.json
aiws-import resume --checkpoint CHECKPOINT.json --target TEMP_VOLUME
aiws-import verify --checkpoint CHECKPOINT.json --report VERIFY.json
aiws-import cutover --verify VERIFY.json --deployment CUTOVER.json
```

执行要求：

- `inspect` 只读并验证来源完整性；
- `dry-run` 生成实体计数、ID mapping、引用翻译、凭据 rebind 清单和冲突
  清单，不写业务行；
- `run/resume` 只写临时 clean 卷，按 identity → ACL → project → workflow →
  context → Assist → execution → Evidence → delivery 顺序 checkpoint；
- 语义冲突整批失败；纯技术 ID 碰撞使用确定性重映射并记录算法版本；
- `verify` 在封闭快照上检查行数、关系闭合、revision/head、event 顺序、
  ACL、CAS、credential 状态和 golden workflow；
- `cutover` 只接受通过的 verify receipt，执行部署级原子切换并记录操作员
  审批。

失败目标卷必须保持不可挂载生产，保留 checkpoint、输入 hash、mapping hash
和失败报告供修复后 resume。

## 4. 日常健康检查

1. `GET /livez` 只证明进程存活。
2. `GET /readyz` 必须同时通过 schema family、migration checksum、SQLite
   integrity/foreign-key、CAS manifest、Broker/Runner profile 和必要适配器
   检查。
3. 长任务通过 `/api/v2/operations/{id}` 查询；SSE 与 JSON replay 必须从同一
   durable cursor 读取。
4. 业务故障先保存 request id、operation receipt、event cursor 和 redacted
   error envelope，不收集 secret、完整 prompt 或宿主绝对路径。

## 5. 备份与恢复

- 停止业务写入后，对 clean SQLite、CAS、配置元数据和 receipt 做逐字节哈希；
- 备份 manifest 必须记录 schema family、source commit、CAS root hash 和
  parent receipt；
- 恢复到新的临时卷，执行 `integrity_check`、外键、CAS、event 顺序和核心
  golden journey，再切换正式卷；
- 恢复过程不运行旧 migration，不把旧卷重新挂为 clean runtime。

## 6. 回滚

回滚是部署级操作：停止当前 clean deployment，封存失败卷，恢复上一份已验收
的镜像、数据库/CAS 卷和 deployment receipt，重新执行 `livez`、`readyz` 和
核心业务探针。回滚不会在 clean runtime 内恢复 `/api/v1`、旧 session 分支或
旧 schema 兼容开关。

## 7. 凭据重新绑定

导入后的 credential 状态必须是 `rebind_required`。操作员通过新的 provider
proof、scope 和 profile revision 完成 rebind/rotation；旧 token、cookie、
Vault ciphertext 和 session secret 永不复制。probe 结果是新的 Evidence，
不能沿用旧的 `active` 状态。

## 8. 事故矩阵

| 现象 | 首个动作 | 允许的恢复路径 |
| --- | --- | --- |
| schema/checksum 不匹配 | 停止业务流量并封存卷 | 修复镜像或从 receipt 恢复 |
| CAS hash 不匹配 | 隔离受影响对象 | 从可信 manifest 恢复或重跑 importer |
| ACL/replay 越界 | 阻断请求并保留审计 receipt | 修复权限策略后重新验证 |
| Runner/Parser 超时 | 保留 operation/checkpoint | 同一输入 hash 重试 |
| importer 语义冲突 | 整批标记 failed | 新 merge manifest 后新批次 |
| cutover 健康检查失败 | 不挂载目标卷 | 执行部署级 rollback |

所有事故处理都要生成四项工件：修改/目标 artifact、patch 或 mapping、带
字面输出和退出码的 verification record、可执行 rollback receipt。
