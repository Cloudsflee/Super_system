# AIWS 协作型 MCP 架构

## 1. 产品定位与设计结论

AIWS 是协作平台，本地优先只是首个部署形态，不是产品边界。Leader 在本机或云服务器运行一个中心实例，成员通过网页参与项目，并让各自 Codex 通过远程 MCP 控制其有权限的项目。

MCP 是面向 Agent 的标准 API，不是安全边界。网页 REST、WebSocket/SSE 与 MCP 最终进入同一业务执行层，但必须使用不同入口、凭据 audience、限流和审计策略。

采用以下结论：

- Core 保持 capability registry、审批、Vault、项目状态和 operation executor 的唯一权威。
- 本地模式保留内嵌 `/api/mcp`，用于开发、诊断和单机 Codex。
- 团队模式以独立 `aiws-mcp-gateway` 作为唯一对外 MCP 入口。
- Gateway 终止外部 Streamable HTTP session，再作为 MCP Client 连接私有 Core；不复制 220 个 operation。
- Gateway 不挂 `aiws-data`、Vault 或 `docker.sock`，不能绕过 Core scope、project allowlist 和审批。
- 每个成员或自动化客户端使用独立身份与凭据，不共享 Leader token。

## 2. 三种部署形态

### 2.1 Local

```text
Browser/Codex -> 127.0.0.1:4317 -> AIWS App/Core
                                      + embedded /api/mcp
                                      + JSON-local single writer
                                      + ephemeral Runner containers
```

Local 是默认开发和个人部署模式。MCP 只接受 loopback 或受管容器，不承诺远程协作。

### 2.2 Team Single Node

```text
Team Browser ---- HTTPS ----> Web/API ingress ----> AIWS Core
Team Codex  ----- HTTPS ----> MCP ingress --------> MCP Gateway
                                                        |
                                             signed private MCP hop
                                                        |
                                                    AIWS Core
                                                        |
                                             ephemeral Runner network
```

`compose.yml` 与 `compose.collaboration.yml` 组合启动该模式。Gateway 与 Core 共享私有 `mcp-core` network；Runner 只加入 `mcp-agents` network，通过 Gateway 使用 MCP，不能直接访问 Core service。

### 2.3 Team Scale

Team Scale 保持客户端 URL 和 MCP contract 不变，将以下进程状态外置：

- 用户、团队、项目成员关系与业务状态迁移到 PostgreSQL。
- Gateway 限流、OAuth state 和 session routing 元数据迁移到 Redis。
- Streamable HTTP 使用 sticky routing；断线恢复依赖 operation cursor，不依赖某个 Runner 进程。
- Core、Gateway 和 Worker 可分别扩缩容。

JSON-local 只用于 Local 和小团队单 Core，不允许多个 Core 容器共享写同一个 volume。

## 3. Gateway 与 Core 职责

| 能力 | Gateway | Core |
|---|---|---|
| TLS/OAuth 接入 | 负责 | 不对公网暴露 |
| MCP initialize/session | 终止外部 session | 维持私有 upstream session |
| tools/resources 转发 | 负责 | 目录和执行权威 |
| 用户/项目最终授权 | 初筛 | 强制校验 |
| 限流 | 边缘限流 | client 级最终限流 |
| 业务状态和 Vault | 禁止访问 | 唯一所有者 |
| Docker socket | 禁止访问 | 仅 Runner manager 使用 |
| 审批与 destructive nonce | 不得决定 | 强制校验 |
| 审计 | 连接级元数据 | 用户、项目和 operation 事实 |

Gateway 只能代理 `/mcp` 和健康检查，不是通用 HTTP reverse proxy。Gateway 到 Core 的每个请求包含带时间戳和 nonce 的 HMAC 签名；Core 的 `gateway` 模式拒绝未签名的私网 MCP 请求和重放。

## 4. 身份与授权模型

### 4.1 当前过渡模型

schema 17 的 `mcp_clients` 继续保存 token hash、scopes、project allowlist、expiry、状态与限流。新增 `subject_user_id` 将 MCP client 绑定到真实用户；MCP 请求通过异步 actor context 进入既有 route handler，使 trace 和 `created_by_user_id` 不再统一落到 Local Owner。

Bearer token 仍适合内部 Runner、CI 和早期可信团队。每人必须独立创建，撤销一人不能影响其他成员。

### 4.2 正式团队模型

正式远程协作需要后续 state schema 增加：

- `teams`
- `team_memberships`
- `project_memberships`
- `auth_identities`
- `oauth_grants`

OAuth access token 至少携带或可反查：`subject_user_id`、`team_id`、`client_id`、`audience=aiws-mcp`、scopes、expiry。Core 将 token scopes 与 project membership 取交集；客户端声明不能扩大成员权限。

建议角色：

- `leader`：团队和项目管理，可签发成员授权。
- `maintainer`：项目写入、Runner、Git 操作。
- `contributor`：受限项目写入，不具备发布和审批权限。
- `viewer`：只读 resources。
- `approver`：独立 `approval:decide`，不能与发起变更的同一身份自批。

`setup:admin`、`mcp:admin`、`destructive:execute` 和凭据管理必须进行 step-up authentication，不能仅凭普通 Codex session 获得。

## 5. 成员 Codex 接入

过渡期由 Settings 为成员创建一次性 token，并输出：

```toml
[mcp_servers.aiws-team]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "AIWS_MCP_TOKEN"
required = true
```

正式模式使用 MCP OAuth，成员执行 Codex 登录流程后获得短期 token，不由 Leader 分发长期 secret。Gateway 的公网 URL 保持稳定；Local 和 Team 切换不改变 tools/resources contract。

成员本机 Codex 调用的是服务端 AIWS 项目状态和受管 workspace。成员本地 repo 的修改仍通过 Git branch/PR 同步，不能把服务端绝对文件路径当作本地路径使用。

## 6. 网络与秘密边界

- Web 使用 `app.<domain>`，MCP 使用 `mcp.<domain>/mcp`，分别配置超时、流式代理和速率限制。
- Core 端口只绑定宿主 loopback或私有 Docker network，公网 ingress 不转发 `/api/mcp`。
- Gateway 宿主端口默认仍绑定 `127.0.0.1`，由 Caddy/Nginx 提供 HTTPS。
- Gateway/Core HMAC secret 使用 Docker secret file，至少 32 bytes，不进入镜像、命令参数、日志或报告。
- Gateway 不转发任意 URL、Host header、Cookie 或浏览器 session。
- 外部 Bearer/OAuth token 只转发给固定 Core MCP URL。
- Runner token 短期、项目限权；Runner network 只能到 Gateway，不得访问 Core 或 Vault。

## 7. Session、恢复与扩容

当前 Team Single Node 的 Gateway session 在内存中，Gateway 重启后客户端必须重新 initialize。业务 operation 和事件 cursor 仍在 Core，可在新 session 中继续读取，不应重复执行写 operation。

横向扩容前必须满足：

1. ingress 按外部 `Mcp-Session-Id` sticky routing；
2. token/IP rate window 使用共享存储；
3. Gateway shutdown 先停止接收 initialize，再 drain active session；
4. Core operation 使用幂等键和持久 cursor；
5. 服务重启测试证明没有重复审批、重复 commit 或重复发布。

## 8. 部署流程

1. 生成权限为 owner-only、长度至少 32 bytes 的 Gateway secret file。
2. 设置 `AIWS_MCP_GATEWAY_SECRET_FILE` 与 HTTPS `AIWS_PUBLIC_MCP_URL`。
3. 使用 `docker compose -f compose.yml -f compose.collaboration.yml up -d --build`。
4. Caddy/Nginx 将 Web domain 转到 `4317`，MCP domain 的 `/mcp` 转到 `4319`。
5. 为每个成员创建独立、项目限权、带到期时间的 client。
6. 从成员机器运行 Codex initialize、tools/list、只读 resource 和受控写入验收。

远程网页正式开放前，必须先完成真正的用户登录、session cookie、CSRF 和 project membership enforcement。没有这些能力时，只能通过团队 VPN 进行受限试用，不能把 Local Owner Web API 直接放到公网。

## 9. 验收标准

- 外部 Codex 只访问 Gateway，不直接访问 Core `/api/mcp`。
- Gateway 容器没有 AIWS volume、Vault、Docker socket 或宿主 workspace mount。
- 篡改、过期或重放的 Gateway HMAC 被 Core 拒绝。
- 两个不同 `subject_user_id` 的 MCP client 产生不同 actor trace。
- project allowlist 和 scope 在 Gateway 之外仍由 Core 强制执行。
- operator 不能自批，成员不能通过 MCP 获得 setup/mcp admin 或 destructive 权限。
- Gateway restart 后可重新 initialize，并从 operation cursor 恢复读取。
- Local mode、stdio bridge、旧 HTTP/UI 与内嵌 MCP 保持兼容。
