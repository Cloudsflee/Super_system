## 检查

- [ ] `corepack pnpm gate:pre-push` 通过
- [ ] `corepack pnpm test:v20:impact` 无未分类文件
- [ ] V1.75 catalog 继续冻结 `1.7.0` / schema `16`，V1.8 catalog 继续冻结 `1.8.0` / schema `17`
- [ ] 当前产品版本、schema、路由、MCP tools 和 collections 只按“不早于/不少于历史基线”校验
- [ ] 新增 deterministic test 已登记到 `tests/v175/suite-files.json`
- [ ] 新增/修改的 HTTP、WebSocket、stream、state collection 已进入 capability registry
- [ ] MCP 写操作仍受 project scope、审批 revision/target hash 和 destructive scope 约束
- [ ] 已确认测试使用隔离 `AIWS_HOME` 与专用外部资源
- [ ] 已检查报告和日志不含凭据、Header、查询参数或原始请求体
