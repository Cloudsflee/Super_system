[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('up', 'down', 'logs', 'status', 'verify', 'backup', 'restore', 'reset', 'bridge')][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Path,
  [string]$ProjectsRoot,
  [string]$CodexHome,
  [string]$CcSwitchRoot,
  [switch]$Confirm,
  [string]$PairingCode
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $Root 'compose.yml'
$Volume = 'aiws-data-v14'
$AppImage = if ($env:AIWS_APP_IMAGE) { $env:AIWS_APP_IMAGE } else { 'aiws-app:1.6.0' }
$RunnerImage = if ($env:AIWS_RUNNER_IMAGE) { $env:AIWS_RUNNER_IMAGE } else { 'aiws-codex-runner:1.6.0-codex-0.144.0' }
$Port = if ($env:AIWS_PORT) { [int]$env:AIWS_PORT } else { 4317 }
$env:AIWS_DOCKER_DATA_VOLUME = $Volume
$env:AIWS_APP_IMAGE = $AppImage
$env:AIWS_RUNNER_IMAGE = $RunnerImage

function Invoke-Compose([string[]]$Arguments, [string]$Override) {
  $files = @('-f', $ComposeFile)
  if ($Override) { $files += @('-f', $Override) }
  & docker compose @files @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed ($LASTEXITCODE)" }
}

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker_cli_required' }
  & docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'docker_engine_unavailable' }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { throw 'docker_compose_required' }
}

function Assert-PortFree {
  $existing = & docker compose -f $ComposeFile ps --status running -q app 2>$null
  if ($existing) { return }
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "port_${Port}_in_use" }
}

function Resolve-Import([string]$Explicit, [string]$EnvironmentValue, [string]$Fallback) {
  foreach ($candidate in @($Explicit, $EnvironmentValue, $Fallback)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Quote-Yaml([string]$Value) { return "'$(($Value -replace "'", "''"))'" }

function New-ImportOverride {
  $codex = Resolve-Import $CodexHome $env:CODEX_HOME (Join-Path $HOME '.codex')
  $cc = Resolve-Import $CcSwitchRoot $env:CC_SWITCH_CONFIG_DIR (Join-Path $HOME '.cc-switch')
  $projects = Resolve-Import $ProjectsRoot $null $null
  if (-not ($codex -or $cc -or $projects)) { return $null }
  $file = Join-Path ([System.IO.Path]::GetTempPath()) "aiws-compose-$([guid]::NewGuid().ToString('N')).yml"
  $lines = @('services:', '  app:', '    environment:')
  if ($codex) { $lines += '      AIWS_HOST_CODEX_HOME: /host/codex' }
  if ($cc) { $lines += '      AIWS_HOST_CC_SWITCH_CONFIG_DIR: /host/cc-switch' }
  if ($projects) { $lines += '      AIWS_HOST_PROJECTS_ROOT: /host/projects' }
  $lines += '    volumes:'
  foreach ($item in @(@($codex, '/host/codex'), @($cc, '/host/cc-switch'), @($projects, '/host/projects'))) {
    if (-not $item[0]) { continue }
    $lines += @('      - type: bind', "        source: $(Quote-Yaml $item[0])", "        target: $($item[1])", '        read_only: true')
  }
  [IO.File]::WriteAllLines($file, $lines, [Text.UTF8Encoding]::new($false))
  Write-Host '只读导入能力已按现有来源配置。'
  return $file
}

function Build-Images {
  & docker build -f (Join-Path $Root 'docker/codex-runner.Dockerfile') --build-arg CODEX_VERSION=0.144.0 -t $RunnerImage $Root
  if ($LASTEXITCODE -ne 0) { throw 'runner_image_build_failed' }
  & docker build --target production -t $AppImage $Root
  if ($LASTEXITCODE -ne 0) { throw 'app_image_build_failed' }
}

function Test-VolumeSubpath {
  & docker volume create $Volume *> $null
  & docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/data" $RunnerImage -c 'mkdir -p /data/.aiws-preflight'
  if ($LASTEXITCODE -ne 0) { throw 'volume_preflight_failed' }
  & docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/probe,volume-subpath=.aiws-preflight" $RunnerImage -c 'test -d /probe'
  $subpathStatus = $LASTEXITCODE
  & docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/data" $RunnerImage -c 'rmdir /data/.aiws-preflight' *> $null
  if ($subpathStatus -ne 0) { throw 'volume_subpath_unsupported' }
  if ($LASTEXITCODE -ne 0) { throw 'volume_preflight_cleanup_failed' }
  & docker run --rm -v /var/run/docker.sock:/var/run/docker.sock $AppImage docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'docker_socket_unavailable_to_app' }
}

function Wait-Healthy {
  for ($i = 0; $i -lt 60; $i++) {
    $container = & docker compose -f $ComposeFile ps -q app 2>$null
    if ($container) {
      $health = & docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $container 2>$null
      if ($health -eq 'healthy') { Write-Host "AIWS 已启动：http://127.0.0.1:$Port"; return }
      if ($health -eq 'unhealthy' -or $health -eq 'exited') { throw "app_$health" }
    }
    Start-Sleep -Seconds 2
  }
  throw 'app_health_timeout'
}

function New-V16MigrationSnapshot {
  $backupRoot = Join-Path $Root '.ai-workspace\backups'
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
  $archive = Join-Path $backupRoot "aiws-v15-before-v16-$stamp.tar.gz"
  $runningContainers = @(
    & docker ps -q --filter 'label=com.docker.compose.project=aiws-v15' --filter 'label=com.docker.compose.service=app'
    & docker ps -q --filter 'label=com.docker.compose.project=aiws-v16' --filter 'label=com.docker.compose.service=app'
  ) | Where-Object { $_ } | Select-Object -Unique
  foreach ($container in $runningContainers) { & docker stop --time 30 $container *> $null; if ($LASTEXITCODE -ne 0) { throw 'existing_app_stop_failed' } }
  $temporary = ".aiws-v16-$([guid]::NewGuid().ToString('N')).tar.gz"
  & docker run --rm --mount "type=volume,src=$Volume,dst=/data,readonly" --volume "${backupRoot}:/backup" $AppImage python3 /opt/aiws/backup_archive.py create /data "/backup/$temporary"
  if ($LASTEXITCODE -ne 0) { throw 'v16_pre_migration_backup_failed' }
  & docker run --rm --volume "${backupRoot}:/backup:ro" $AppImage python3 /opt/aiws/backup_archive.py validate "/backup/$temporary"
  if ($LASTEXITCODE -ne 0) { throw 'v16_pre_migration_backup_invalid' }
  Move-Item -LiteralPath (Join-Path $backupRoot $temporary) -Destination $archive
  $stateSha = (& docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/data,readonly" $AppImage -c 'test ! -f /data/data/state.json || sha256sum /data/data/state.json | cut -d" " -f1' | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'v16_state_sha_failed' }
  $stateCanonicalHash = (& docker run --rm --entrypoint node --mount "type=volume,src=$Volume,dst=/data,readonly" $AppImage --input-type=module -e 'import fs from "node:fs"; import { canonicalStateHash } from "./apps/api/src/state-migration-v15.mjs"; const file="/data/data/state.json"; if(fs.existsSync(file)) console.log(canonicalStateHash(JSON.parse(fs.readFileSync(file,"utf8"))));' | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'v16_state_hash_failed' }
  $stateFacts = & docker run --rm --entrypoint node --mount "type=volume,src=$Volume,dst=/data,readonly" $AppImage -e 'const fs=require("node:fs"),file="/data/data/state.json"; if(fs.existsSync(file)){const bytes=fs.readFileSync(file),state=JSON.parse(bytes); console.log(JSON.stringify({bytes:bytes.length,schema_version:state.schema_version??null}));}'
  $manifest = [ordered]@{
    version = '1.6.0'; created_at = (Get-Date).ToString('o'); source_project = 'aiws-v15'; target_project = 'aiws-v16'
    archive = (Split-Path -Leaf $archive); archive_sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    state_sha256 = $(if ($stateSha) { $stateSha } else { $null }); state_canonical_hash = $(if ($stateCanonicalHash) { $stateCanonicalHash } else { $null })
    app_image = (& docker image inspect aiws-app:1.5.0 --format '{{.Id}}' 2>$null); runner_image = (& docker image inspect aiws-codex-runner:1.5.0-codex-0.144.0 --format '{{.Id}}' 2>$null)
    state_facts = @($stateFacts); stopped_app_containers = @($runningContainers); managed_runners = @(& docker ps -a --filter 'label=aiws.managed=true' --format '{{.ID}}|{{.Image}}|{{.Status}}')
  }
  $manifestPath = "$archive.manifest.json"
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
  [pscustomobject]@{ Archive = $archive; Manifest = $manifestPath; StateSha = $stateSha; WasRunning = $runningContainers.Count -gt 0 }
}

function Restore-V16MigrationSnapshot([string]$Archive, [string]$ExpectedStateSha) {
  $full = (Resolve-Path -LiteralPath $Archive).Path; $parent = Split-Path -Parent $full; $leaf = Split-Path -Leaf $full
  & docker run --rm --volume "${parent}:/backup:ro" $AppImage python3 /opt/aiws/backup_archive.py validate "/backup/$leaf"
  if ($LASTEXITCODE -ne 0) { throw 'v16_restore_archive_invalid' }
  & docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/data" $AppImage -c 'case "$1" in /data) find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + ;; *) exit 90 ;; esac' sh /data
  if ($LASTEXITCODE -ne 0) { throw 'v16_restore_clear_failed' }
  & docker run --rm --volume "${parent}:/backup:ro" --mount "type=volume,src=$Volume,dst=/data" $AppImage python3 /opt/aiws/backup_archive.py extract "/backup/$leaf" /data
  if ($LASTEXITCODE -ne 0) { throw 'v16_restore_failed' }
  $restoredSha = (& docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/data,readonly" $AppImage -c 'test ! -f /data/data/state.json || sha256sum /data/data/state.json | cut -d" " -f1' | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or ($ExpectedStateSha -and $restoredSha -ne $ExpectedStateSha)) { throw 'v16_restore_hash_mismatch' }
}

function Invoke-Bridge([string]$Action) {
  if ($Action -notin @('install','start','stop','status','uninstall')) { throw 'bridge_action_required' }
  $bridgeRoot = Join-Path $env:LOCALAPPDATA 'AIWS\bridge'; $exe = Join-Path $bridgeRoot 'aiws-bridge.exe'; $pidFile = Join-Path $bridgeRoot 'bridge.pid'; $taskName = 'AIWS Windows Bridge'
  if ($Action -eq 'install') {
    New-Item -ItemType Directory -Path $bridgeRoot -Force | Out-Null
    $export = Join-Path ([IO.Path]::GetTempPath()) "aiws-bridge-$([guid]::NewGuid().ToString('N'))"
    try {
      & docker build --target windows-bridge-export --output "type=local,dest=$export" $Root
      if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_build_failed' }
      Copy-Item -LiteralPath (Join-Path $export 'aiws-bridge.exe') -Destination $exe -Force
    } finally { if (Test-Path -LiteralPath $export) { Remove-Item -LiteralPath $export -Recurse -Force } }
    & schtasks.exe /Create /TN $taskName /SC ONLOGON /TR "`"$exe`" run" /F *> $null
    if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_task_install_failed' }
    $code = if ($PairingCode) { $PairingCode } else { $env:AIWS_PAIRING_CODE }
    if ($code) { & $exe pair $code; if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_pairing_failed' } }
    Write-Host "Bridge 已安装：$exe"; return
  }
  if ($Action -eq 'start') {
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'windows_bridge_not_installed' }
    if (Test-Path -LiteralPath $pidFile) { $runningPid = [int](Get-Content -LiteralPath $pidFile -Raw); if (Get-Process -Id $runningPid -ErrorAction SilentlyContinue) { Write-Host 'Bridge 已运行。'; return } }
    $process = Start-Process -FilePath $exe -ArgumentList 'run' -WindowStyle Hidden -PassThru
    [IO.File]::WriteAllText($pidFile, [string]$process.Id, [Text.UTF8Encoding]::new($false)); Write-Host "Bridge 已启动 (PID $($process.Id))。"; return
  }
  if ($Action -eq 'stop') {
    if (Test-Path -LiteralPath $pidFile) { $runningPid = [int](Get-Content -LiteralPath $pidFile -Raw); $process = Get-Process -Id $runningPid -ErrorAction SilentlyContinue; if ($process -and $process.Path -eq $exe) { Stop-Process -Id $runningPid -Force; $process.WaitForExit(5000) }; Remove-Item -LiteralPath $pidFile -Force }
    Write-Host 'Bridge 已停止。'; return
  }
  if ($Action -eq 'status') {
    if (-not (Test-Path -LiteralPath $exe)) { Write-Host 'Bridge 未安装。'; return }
    & $exe status; if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_not_paired' }
    if (Test-Path -LiteralPath $pidFile) { $runningPid = [int](Get-Content -LiteralPath $pidFile -Raw); if (Get-Process -Id $runningPid -ErrorAction SilentlyContinue) { Write-Host "running PID $runningPid"; return } }
    Write-Host 'paired but offline'; return
  }
  if ($Action -eq 'uninstall') {
    Invoke-Bridge 'stop'; & schtasks.exe /Delete /TN $taskName /F *> $null
    if (Test-Path -LiteralPath $bridgeRoot) { Remove-Item -LiteralPath $bridgeRoot -Recurse -Force }
    Write-Host 'Bridge 已卸载；Codex Home 与项目未修改。'
  }
}

function Invoke-Backup([string]$Destination) {
  if (-not $Destination) { throw 'backup_path_required' }
  $full = [IO.Path]::GetFullPath($Destination)
  if (Test-Path -LiteralPath $full) { throw 'backup_target_exists' }
  $parent = Split-Path -Parent $full
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'backup_parent_missing' }
  $temporary = ".aiws-backup-$([guid]::NewGuid().ToString('N')).tar.gz"
  $running = & docker compose -f $ComposeFile ps --status running -q app 2>$null
  try {
    if ($running) { Invoke-Compose @('stop', 'app') }
    & docker run --rm --mount "type=volume,src=$Volume,dst=/data,readonly" --volume "${parent}:/backup" $AppImage python3 /opt/aiws/backup_archive.py create /data "/backup/$temporary"
    if ($LASTEXITCODE -ne 0) { throw 'backup_failed' }
    & docker run --rm --volume "${parent}:/backup:ro" $AppImage python3 /opt/aiws/backup_archive.py validate "/backup/$temporary"
    if ($LASTEXITCODE -ne 0) { throw 'backup_validation_failed' }
    Move-Item -LiteralPath (Join-Path $parent $temporary) -Destination $full
    Write-Host '备份已完成。'
  } finally {
    if ($running) { Invoke-Compose @('up', '-d', 'app') }
  }
}

function Invoke-Restore([string]$Archive) {
  if (-not $Confirm) { throw 'restore_requires_confirm' }
  if (-not $Archive -or -not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw 'restore_archive_missing' }
  if (& docker compose -f $ComposeFile ps --status running -q app 2>$null) { throw 'restore_requires_stopped_app' }
  & docker volume inspect $Volume *> $null
  if ($LASTEXITCODE -ne 0) { & docker volume create $Volume *> $null }
  & docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/data" $AppImage -c 'test -z "$(ls -A /data)"'
  if ($LASTEXITCODE -ne 0) { throw 'restore_target_not_empty' }
  $full = (Resolve-Path -LiteralPath $Archive).Path
  $parent = Split-Path -Parent $full
  $leaf = Split-Path -Leaf $full
  & docker run --rm --volume "${parent}:/backup:ro" $AppImage python3 /opt/aiws/backup_archive.py validate "/backup/$leaf"
  if ($LASTEXITCODE -ne 0) { throw 'restore_archive_invalid' }
  & docker run --rm --volume "${parent}:/backup:ro" --mount "type=volume,src=$Volume,dst=/data" $AppImage python3 /opt/aiws/backup_archive.py extract "/backup/$leaf" /data
  if ($LASTEXITCODE -ne 0) { throw 'restore_failed' }
  Write-Host '恢复已完成；应用保持停止状态。'
}

Set-Location $Root
Assert-Docker
switch ($Command) {
  'up' {
    Build-Images
    Test-VolumeSubpath
    $snapshot = New-V16MigrationSnapshot
    Assert-PortFree
    $override = New-ImportOverride
    try {
      Invoke-Compose @('up', '-d', '--remove-orphans') $override
      Wait-Healthy
    } catch {
      Invoke-Compose @('stop', 'app')
      Restore-V16MigrationSnapshot $snapshot.Archive $snapshot.StateSha
      throw
    } finally { if ($override) { Remove-Item -LiteralPath $override -Force } }
  }
  'down' { Invoke-Compose @('down', '--remove-orphans'); Write-Host "数据卷 $Volume 已保留。" }
  'logs' { Invoke-Compose @('logs', '-f', '--tail', '200', 'app') }
  'status' { Invoke-Compose @('ps'); & docker volume inspect $Volume --format 'data volume: {{.Name}}' 2>$null }
  'verify' {
    Invoke-Compose @('config', '--quiet')
    Build-Images
    & docker build --target verify -t aiws-verify:1.6.0 $Root
    if ($LASTEXITCODE -ne 0) { throw 'verify_image_build_failed' }
    & docker run --rm $RunnerImage --version
    if ($LASTEXITCODE -ne 0) { throw 'runner_version_failed' }
    $bridgeVerify = Join-Path ([IO.Path]::GetTempPath()) 'aiws-bridge-verify'
    if (Test-Path -LiteralPath $bridgeVerify) { Remove-Item -LiteralPath $bridgeVerify -Recurse -Force }
    try {
      & docker build --target windows-bridge-export --output "type=local,dest=$bridgeVerify" $Root
      if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_export_failed' }
      if (-not (Test-Path -LiteralPath (Join-Path $bridgeVerify 'aiws-bridge.exe') -PathType Leaf)) { throw 'windows_bridge_export_missing' }
    } finally { if (Test-Path -LiteralPath $bridgeVerify) { Remove-Item -LiteralPath $bridgeVerify -Recurse -Force } }
    & docker run --rm aiws-verify:1.6.0 corepack pnpm verify
    if ($LASTEXITCODE -ne 0) { throw 'container_verify_failed' }
  }
  'backup' { Invoke-Backup $Path }
  'restore' { Invoke-Restore $Path }
  'reset' {
    if (-not $Confirm) { throw 'reset_requires_confirm' }
    Invoke-Compose @('down', '--remove-orphans')
    & docker volume rm $Volume
    if ($LASTEXITCODE -ne 0) { throw 'reset_volume_remove_failed' }
    Write-Host "仅数据卷 $Volume 已删除。"
  }
  'bridge' { Invoke-Bridge $Path }
}
