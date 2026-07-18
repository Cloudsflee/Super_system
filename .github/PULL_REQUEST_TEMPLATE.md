## 历史门禁影响

V1.75-Decision: choose-one
V1.75-Reason: explain which frozen baseline assertions cover the change or why tests were updated

V1.8-Decision: choose-one
V1.8-Reason: explain which MCP/HTTP/UI assertions cover the change or why tests were updated

允许的 Decision：`existing-valid`、`tests-updated`、`not-needed`。

- `existing-valid`：Reason 必须指出仍然有效的现有断言及覆盖关系。
- `tests-updated`：测试已随行为或契约变化更新。
- `not-needed`：仅适用于无 P0 业务域影响的变更。

## 检查

- [ ] `corepack pnpm gate:pre-push` 通过
- [ ] V1.75 catalog 继续冻结 `1.7.0` / schema `16`，V1.8 catalog 继续冻结 `1.8.0` / schema `17`
- [ ] 当前产品版本、schema、路由、MCP tools 和 collections 只按“不早于/不少于历史基线”校验
- [ ] 新增 deterministic test 已登记到 `tests/v175/suite-files.json`
- [ ] 新增/修改的 HTTP、WebSocket、stream、state collection 已进入 capability registry
- [ ] MCP 写操作仍受 project scope、审批 revision/target hash 和 destructive scope 约束
- [ ] 已确认测试使用隔离 `AIWS_HOME` 与专用外部资源
- [ ] 已检查报告和日志不含凭据、Header、查询参数或原始请求体
