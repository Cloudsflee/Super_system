[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('up', 'down', 'logs', 'status', 'verify', 'backup', 'restore', 'reset')][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Path,
  [string]$ProjectsRoot,
  [string]$CodexHome,
  [string]$CcSwitchRoot,
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $Root 'compose.yml'
$Volume = 'aiws-data-v14'
$AppImage = if ($env:AIWS_APP_IMAGE) { $env:AIWS_APP_IMAGE } else { 'aiws-app:1.4.0' }
$RunnerImage = if ($env:AIWS_RUNNER_IMAGE) { $env:AIWS_RUNNER_IMAGE } else { 'aiws-codex-runner:1.4.0-codex-0.144.0' }
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
    & docker run --rm --entrypoint sh --mount "type=volume,src=$Volume,dst=/data,readonly" --volume "${parent}:/backup" $AppImage -c 'tar -C /data -czf "/backup/$1" .' sh $temporary
    if ($LASTEXITCODE -ne 0) { throw 'backup_failed' }
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
    Assert-PortFree
    Build-Images
    Test-VolumeSubpath
    $override = New-ImportOverride
    try { Invoke-Compose @('up', '-d', '--remove-orphans') $override } finally { if ($override) { Remove-Item -LiteralPath $override -Force } }
    Wait-Healthy
  }
  'down' { Invoke-Compose @('down', '--remove-orphans'); Write-Host "数据卷 $Volume 已保留。" }
  'logs' { Invoke-Compose @('logs', '-f', '--tail', '200', 'app') }
  'status' { Invoke-Compose @('ps'); & docker volume inspect $Volume --format 'data volume: {{.Name}}' 2>$null }
  'verify' {
    Invoke-Compose @('config', '--quiet')
    Build-Images
    & docker build --target verify -t aiws-verify:1.4.0 $Root
    if ($LASTEXITCODE -ne 0) { throw 'verify_image_build_failed' }
    & docker run --rm $RunnerImage --version
    if ($LASTEXITCODE -ne 0) { throw 'runner_version_failed' }
    & docker run --rm aiws-verify:1.4.0 corepack pnpm verify
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
}
