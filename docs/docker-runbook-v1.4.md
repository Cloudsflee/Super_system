# AI Workspace V1.4 Docker Runbook

V1.4 的默认部署由一个长期 AIWS app 容器和按需创建的 Codex Runner sibling containers 组成。宿主只需要 Docker Desktop/Engine 与 Docker Compose；业务状态继续使用 JSON-local，并保存在命名卷 `aiws-data-v14`。

## 1. 固定交付参数

| 项目 | 默认值 |
|---|---|
| Web/API | `http://127.0.0.1:4317` |
| App image | `aiws-app:1.4.0` |
| Runner image | `aiws-codex-runner:1.4.0-codex-0.144.0` |
| Data volume | `aiws-data-v14` |
| Compose project | `aiws-v14` |

端口只绑定 loopback。Compose 会将 Docker socket 挂入 app，app 再创建带资源限制和 `aiws.managed=true` label 的临时 Runner。

## 2. 启动

Windows PowerShell：

```powershell
.\scripts\aiws.ps1 up
```

macOS / Linux：

```bash
bash scripts/aiws.sh up
```

`up` 会检查 Docker/Compose、端口、命名卷、volume-subpath 和 socket，然后构建 app/Runner 并等待 health 变为 healthy。

### 2.1 只读导入

启动脚本会发现 `CODEX_HOME` 或默认 `~/.codex`，并可发现 `CC_SWITCH_CONFIG_DIR` 或默认 `~/.cc-switch`。存在的来源通过临时 Compose override 只读挂载，不会直接交给 Runner。

项目目录必须显式指定：

```powershell
.\scripts\aiws.ps1 up -ProjectsRoot 'E:\projects'
```

```bash
bash scripts/aiws.sh up --projects-root /home/user/projects
```

配置后，项目引导只接受导入根下的相对路径，例如 `team/service-a`。未配置项目根时，仍可使用 Git/GitHub URL、归档上传和浏览器目录上传。

可显式覆盖发现来源：

```powershell
.\scripts\aiws.ps1 up -CodexHome 'E:\config\codex' -CcSwitchRoot 'E:\config\cc-switch'
```

```bash
bash scripts/aiws.sh up --codex-home /config/codex --cc-switch-root /config/cc-switch
```

## 3. 日常操作

| 操作 | PowerShell | POSIX |
|---|---|---|
| 查看状态 | `.\scripts\aiws.ps1 status` | `bash scripts/aiws.sh status` |
| 跟踪日志 | `.\scripts\aiws.ps1 logs` | `bash scripts/aiws.sh logs` |
| 停止服务 | `.\scripts\aiws.ps1 down` | `bash scripts/aiws.sh down` |
| 完整验证 | `.\scripts\aiws.ps1 verify` | `bash scripts/aiws.sh verify` |

`down` 不删除 `aiws-data-v14`。再次执行 `up` 会复用 state、vault、workspace 与 artifact。

## 4. 备份

目标目录必须已经存在，目标文件不能已经存在：

```powershell
New-Item -ItemType Directory -Force .\aiws-backups | Out-Null
.\scripts\aiws.ps1 backup .\aiws-backups\aiws-2026-07-12.tar.gz
```

```bash
mkdir -p ./aiws-backups
bash scripts/aiws.sh backup ./aiws-backups/aiws-2026-07-12.tar.gz
```

脚本记录 app 原运行状态，停止 app，以只读方式打包数据卷，原子移动备份文件，并在成功或失败后恢复原运行状态。

## 5. 恢复

恢复要求 app 已停止、目标卷为空，并显式确认：

```powershell
.\scripts\aiws.ps1 down
.\scripts\aiws.ps1 reset -Confirm
.\scripts\aiws.ps1 restore .\aiws-backups\aiws-2026-07-12.tar.gz -Confirm
.\scripts\aiws.ps1 up
```

```bash
bash scripts/aiws.sh down
bash scripts/aiws.sh reset --confirm
bash scripts/aiws.sh restore ./aiws-backups/aiws-2026-07-12.tar.gz --confirm
bash scripts/aiws.sh up
```

归档校验拒绝绝对路径、`..`、重复路径、符号链接、硬链接、设备节点、FIFO、超限成员数和超限展开体积。恢复失败时 app 保持停止。

## 6. Reset 边界

```powershell
.\scripts\aiws.ps1 reset -Confirm
```

```bash
bash scripts/aiws.sh reset --confirm
```

`reset` 只删除命名卷 `aiws-data-v14`。它不会删除：

- 仓库内 V1.3 `.ai-workspace`
- `CODEX_HOME` / `~/.codex`
- cc-switch 配置
- `--projects-root` 指定的目录
- 备份文件或其他 Docker volume

缺少显式确认时命令直接失败。

## 7. 验证与诊断

`verify` 执行 Compose config、生产/验证/Runner 镜像构建、固定 Codex 版本检查和验证镜像内的完整 `corepack pnpm verify`。

基础检查：

```bash
docker compose config
docker compose ps
docker image inspect aiws-app:1.4.0
docker run --rm aiws-codex-runner:1.4.0-codex-0.144.0 --version
```

API：

```text
GET http://127.0.0.1:4317/api/health
GET http://127.0.0.1:4317/api/system/deployment
```

deployment 响应只包含 mode、ready 与 import capability，不返回宿主路径、socket 路径、卷名或 Secret。

### 7.1 端口占用

`up` 在 `4317` 已被非当前 Compose app 占用时失败。先停止旧的 Vite/API 开发服务，或仅为临时测试设置 `AIWS_PORT`。

### 7.2 Docker/Runner 不可用

确认 Docker 使用 Linux containers，`docker info` 与 `docker compose version` 成功，然后重新执行 `up`。容器部署内不提供 Host Profile fallback。

### 7.3 数据未出现

V1.4 故意创建全新卷，不导入 V1.3 `.ai-workspace`。使用 `docker volume inspect aiws-data-v14` 确认卷存在；不要通过复制宿主旧目录绕过版本边界。

## 8. 宿主开发模式

开发热更新仍使用 Node.js 24、Corepack 和 pnpm：

```bash
corepack pnpm install
corepack pnpm dev
```

该模式继续使用仓库 `.ai-workspace`、Vite `4317` 和 API `4318`，可保留 Host Profile 兼容；它与 V1.4 生产卷互不迁移。

