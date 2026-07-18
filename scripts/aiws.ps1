[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('up', 'down', 'logs', 'status', 'verify', 'backup', 'restore', 'reset', 'purge-legacy', 'bridge')][string]$Command = 'status',
  [Parameter(Position = 1)][string]$Path,
  [string]$ProjectsRoot,
  [string]$CodexHome,
  [string]$CcSwitchRoot,
  [switch]$Confirm,
  [switch]$DiscardUnmigratable,
  [string]$PairingCode
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ComposeFile = Join-Path $Root 'compose.yml'
$Volume = 'aiws-data-v19'
$SourceVolume = 'aiws-data-v18'
$AppImage = if ($env:AIWS_APP_IMAGE) { $env:AIWS_APP_IMAGE } else { 'aiws-app:1.9.0' }
$RunnerImage = if ($env:AIWS_RUNNER_IMAGE) { $env:AIWS_RUNNER_IMAGE } else { 'aiws-codex-runner:1.9.0-codex-0.144.0' }
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

function Build-VerifyImage {
  $verifyImage = 'aiws-verify:1.9.0'
  $compatible = $false
  & docker image inspect $verifyImage *> $null
  if ($LASTEXITCODE -eq 0) {
    & docker run --rm --entrypoint sh --mount "type=bind,src=$Root,dst=/source,readonly" $verifyImage -c 'test -d /app/node_modules && test -d "$(corepack pnpm store path)" && cmp -s /app/pnpm-lock.yaml /source/pnpm-lock.yaml && test "$(codex --version)" = "codex-cli 0.144.0" && (command -v chromium-browser >/dev/null || command -v chromium >/dev/null)'
    $compatible = $LASTEXITCODE -eq 0
  }
  if (-not $compatible) {
    & docker build --target verify -t $verifyImage $Root
    if ($LASTEXITCODE -ne 0) { throw 'verify_image_build_failed' }
    return
  }
  $cacheImage = "aiws-verify-toolchain:$([guid]::NewGuid().ToString('N'))"
  & docker tag $verifyImage $cacheImage
  if ($LASTEXITCODE -ne 0) { throw 'verify_toolchain_tag_failed' }
  try {
    & docker build -f (Join-Path $Root 'docker\verify-refresh.Dockerfile') --build-arg "VERIFY_BASE_IMAGE=$cacheImage" -t $verifyImage $Root
    if ($LASTEXITCODE -ne 0) { throw 'verify_image_refresh_failed' }
  } finally {
    & docker image rm $cacheImage *> $null
  }
}

function Test-VolumeSubpath {
  $preflight = "aiws-v19-preflight-$([guid]::NewGuid().ToString('N'))"
  & docker volume create --label 'aiws.owner=aiws-v19-release' --label 'aiws.role=preflight' $preflight *> $null
  if ($LASTEXITCODE -ne 0) { throw 'volume_preflight_create_failed' }
  try {
    & docker run --rm --entrypoint sh --mount "type=volume,src=$preflight,dst=/data" $RunnerImage -c 'mkdir -p /data/.aiws-preflight'
    if ($LASTEXITCODE -ne 0) { throw 'volume_preflight_failed' }
    & docker run --rm --entrypoint sh --mount "type=volume,src=$preflight,dst=/probe,volume-subpath=.aiws-preflight" $RunnerImage -c 'test -d /probe'
    if ($LASTEXITCODE -ne 0) { throw 'volume_subpath_unsupported' }
  } finally {
    & docker volume rm -f $preflight *> $null
    if ($LASTEXITCODE -ne 0) { throw 'volume_preflight_cleanup_failed' }
  }
  & docker run --rm -v /var/run/docker.sock:/var/run/docker.sock $AppImage docker info --format '{{.ServerVersion}}' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'docker_socket_unavailable_to_app' }
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
    $override = New-ImportOverride
    try {
      $releaseArgs = @(
        (Join-Path $Root 'scripts\v19-release.mjs'), 'up',
        '--compose-file', $ComposeFile,
        '--source-volume', $SourceVolume,
        '--target-volume', $Volume,
        '--app-image', $AppImage,
        '--runner-image', $RunnerImage,
        '--port', [string]$Port
      )
      if ($override) { $releaseArgs += @('--override', $override) }
      if ($DiscardUnmigratable) { $releaseArgs += '--discard-unmigratable' }
      & node @releaseArgs
      if ($LASTEXITCODE -ne 0) { throw 'v19_release_up_failed' }
    } finally { if ($override) { Remove-Item -LiteralPath $override -Force } }
  }
  'down' { Invoke-Compose @('down', '--remove-orphans'); Write-Host "数据卷 $Volume 已保留。" }
  'logs' { Invoke-Compose @('logs', '-f', '--tail', '200', 'app') }
  'status' { Invoke-Compose @('ps'); & docker volume inspect $Volume --format 'data volume: {{.Name}}' 2>$null }
  'verify' {
    Invoke-Compose @('config', '--quiet')
    Build-Images
    Build-VerifyImage
    & docker run --rm $RunnerImage --version
    if ($LASTEXITCODE -ne 0) { throw 'runner_version_failed' }
    $bridgeVerify = Join-Path ([IO.Path]::GetTempPath()) 'aiws-bridge-verify'
    if (Test-Path -LiteralPath $bridgeVerify) { Remove-Item -LiteralPath $bridgeVerify -Recurse -Force }
    try {
      & docker build --target windows-bridge-export --output "type=local,dest=$bridgeVerify" $Root
      if ($LASTEXITCODE -ne 0) { throw 'windows_bridge_export_failed' }
      if (-not (Test-Path -LiteralPath (Join-Path $bridgeVerify 'aiws-bridge.exe') -PathType Leaf)) { throw 'windows_bridge_export_missing' }
    } finally { if (Test-Path -LiteralPath $bridgeVerify) { Remove-Item -LiteralPath $bridgeVerify -Recurse -Force } }
    & docker run --rm aiws-verify:1.9.0 corepack pnpm verify
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
  'purge-legacy' {
    if (-not $Confirm) { throw 'purge_legacy_requires_confirm' }
    & node (Join-Path $Root 'scripts\v19-release.mjs') purge-legacy --confirm --compose-file $ComposeFile --target-volume $Volume --app-image $AppImage --runner-image $RunnerImage --port ([string]$Port)
    if ($LASTEXITCODE -ne 0) { throw 'purge_legacy_failed' }
  }
  'bridge' { Invoke-Bridge $Path }
}
