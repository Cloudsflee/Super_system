#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT/compose.yml"
SOURCE_VOLUME=aiws-data-v19
VOLUME=aiws-data-v20
APP_IMAGE=${AIWS_APP_IMAGE:-aiws-app:2.0.0}
RUNNER_IMAGE=${AIWS_RUNNER_IMAGE:-aiws-codex-runner:2.0.0-codex-0.144.0}
PORT=${AIWS_PORT:-4317}
COMMAND=${1:-status}
shift || true
PATH_ARG=
PROJECTS_ROOT=
CODEX_HOME_ARG=
CC_SWITCH_ROOT=
CONFIRM=0

while (($#)); do
  case "$1" in
    --projects-root) PROJECTS_ROOT=${2:?missing_projects_root}; shift 2 ;;
    --codex-home) CODEX_HOME_ARG=${2:?missing_codex_home}; shift 2 ;;
    --cc-switch-root) CC_SWITCH_ROOT=${2:?missing_cc_switch_root}; shift 2 ;;
    --confirm) CONFIRM=1; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) if [[ -n "$PATH_ARG" ]]; then echo "unexpected argument: $1" >&2; exit 2; fi; PATH_ARG=$1; shift ;;
  esac
done

export AIWS_DOCKER_DATA_VOLUME="$VOLUME" AIWS_DOCKER_INSTANCE=aiws-v20 AIWS_APP_IMAGE="$APP_IMAGE" AIWS_RUNNER_IMAGE="$RUNNER_IMAGE"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
assert_docker() { command -v docker >/dev/null || { echo docker_cli_required >&2; exit 1; }; docker info --format '{{.ServerVersion}}' >/dev/null; docker compose version >/dev/null; }
existing_dir() { local value=${1:-}; [[ -n "$value" && -d "$value" ]] && { cd "$value" && pwd -P; }; }
yaml_quote() { local value=${1//\'/\'\'}; printf "'%s'" "$value"; }

new_import_override() {
  local codex cc projects file
  codex=$(existing_dir "$CODEX_HOME_ARG" || existing_dir "${CODEX_HOME:-}" || existing_dir "$HOME/.codex" || true)
  cc=$(existing_dir "$CC_SWITCH_ROOT" || existing_dir "${CC_SWITCH_CONFIG_DIR:-}" || existing_dir "$HOME/.cc-switch" || true)
  projects=$(existing_dir "$PROJECTS_ROOT" || true)
  [[ -z "$codex$cc$projects" ]] && return
  file=$(mktemp "${TMPDIR:-/tmp}/aiws-compose-XXXXXX.yml")
  {
    echo services:; echo '  app:'; echo '    environment:'
    [[ -n "$codex" ]] && echo '      AIWS_HOST_CODEX_HOME: /host/codex'
    [[ -n "$cc" ]] && echo '      AIWS_HOST_CC_SWITCH_CONFIG_DIR: /host/cc-switch'
    [[ -n "$projects" ]] && echo '      AIWS_HOST_PROJECTS_ROOT: /host/projects'
    echo '    volumes:'
    if [[ -n "$codex" ]]; then echo '      - type: bind'; printf '        source: %s\n' "$(yaml_quote "$codex")"; echo '        target: /host/codex'; echo '        read_only: true'; fi
    if [[ -n "$cc" ]]; then echo '      - type: bind'; printf '        source: %s\n' "$(yaml_quote "$cc")"; echo '        target: /host/cc-switch'; echo '        read_only: true'; fi
    if [[ -n "$projects" ]]; then echo '      - type: bind'; printf '        source: %s\n' "$(yaml_quote "$projects")"; echo '        target: /host/projects'; echo '        read_only: true'; fi
  } >"$file"
  echo '只读导入能力已按现有来源配置。' >&2
  printf '%s' "$file"
}

build_images() {
  docker build -f "$ROOT/docker/codex-runner.Dockerfile" --build-arg CODEX_VERSION=0.144.0 -t "$RUNNER_IMAGE" "$ROOT"
  docker build --target production -t "$APP_IMAGE" "$ROOT"
}
build_verify_image() {
  local verify_image=aiws-verify:2.0.0 cache_image
  if docker image inspect "$verify_image" >/dev/null 2>&1 && docker run --rm --entrypoint sh --mount "type=bind,src=$ROOT,dst=/source,readonly" "$verify_image" -c 'test -d /app/node_modules && test -d "$(corepack pnpm store path)" && cmp -s /app/pnpm-lock.yaml /source/pnpm-lock.yaml && test "$(codex --version)" = "codex-cli 0.144.0" && (command -v chromium-browser >/dev/null || command -v chromium >/dev/null)'; then
    cache_image="aiws-verify-toolchain:$$-$RANDOM"
    docker tag "$verify_image" "$cache_image"
    set +e
    docker build -f "$ROOT/docker/verify-refresh.Dockerfile" --build-arg "VERIFY_BASE_IMAGE=$cache_image" -t "$verify_image" "$ROOT"
    local result=$?
    docker image rm "$cache_image" >/dev/null 2>&1
    set -e
    return "$result"
  fi
  docker build --target verify -t "$verify_image" "$ROOT"
}
test_volume_subpath() {
  local preflight="aiws-v20-preflight-$$-$RANDOM"
  docker volume create --label aiws.owner=aiws-v20-release --label aiws.role=preflight "$preflight" >/dev/null
  set +e
  docker run --rm --entrypoint sh --mount "type=volume,src=$preflight,dst=/data" "$RUNNER_IMAGE" -c 'mkdir -p /data/.aiws-preflight'
  local result=$?
  if [[ "$result" == 0 ]]; then docker run --rm --entrypoint sh --mount "type=volume,src=$preflight,dst=/probe,volume-subpath=.aiws-preflight" "$RUNNER_IMAGE" -c 'test -d /probe'; result=$?; fi
  docker volume rm -f "$preflight" >/dev/null
  local cleanup=$?
  set -e
  [[ "$cleanup" == 0 ]] || { echo volume_preflight_cleanup_failed >&2; return 1; }
  [[ "$result" == 0 ]] || { echo volume_subpath_unsupported >&2; return 1; }
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "$APP_IMAGE" docker info --format '{{.ServerVersion}}' >/dev/null
}
backup_data() {
  [[ -n "$PATH_ARG" ]] || { echo backup_path_required >&2; exit 2; }
  local full parent temporary running
  full=$(cd "$(dirname "$PATH_ARG")" && printf '%s/%s' "$PWD" "$(basename "$PATH_ARG")")
  [[ ! -e "$full" ]] || { echo backup_target_exists >&2; exit 1; }
  parent=$(dirname "$full"); temporary=".aiws-backup-$$-$RANDOM.tar.gz"
  running=$(compose ps --status running -q app 2>/dev/null || true)
  [[ -z "$running" ]] || compose stop app
  set +e
  docker run --rm --mount "type=volume,src=$VOLUME,dst=/data,readonly" --volume "$parent:/backup" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py create /data "/backup/$temporary"
  docker run --rm --volume "$parent:/backup:ro" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py validate "/backup/$temporary"
  result=$?
  set -e
  [[ -z "$running" ]] || compose up -d app
  if [[ "$result" != 0 ]]; then rm -f "$parent/$temporary"; return "$result"; fi
  mv "$parent/$temporary" "$full"
  echo '备份已完成。'
}
restore_data() {
  [[ "$CONFIRM" == 1 ]] || { echo restore_requires_confirm >&2; exit 2; }
  [[ -f "$PATH_ARG" ]] || { echo restore_archive_missing >&2; exit 2; }
  [[ -z "$(compose ps --status running -q app 2>/dev/null || true)" ]] || { echo restore_requires_stopped_app >&2; exit 1; }
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null
  docker run --rm --entrypoint sh --mount "type=volume,src=$VOLUME,dst=/data" "$APP_IMAGE" -c 'test -z "$(ls -A /data)"' || { echo restore_target_not_empty >&2; exit 1; }
  local full parent leaf
  full=$(cd "$(dirname "$PATH_ARG")" && printf '%s/%s' "$PWD" "$(basename "$PATH_ARG")"); parent=$(dirname "$full"); leaf=$(basename "$full")
  docker run --rm --volume "$parent:/backup:ro" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py validate "/backup/$leaf"
  docker run --rm --volume "$parent:/backup:ro" --mount "type=volume,src=$VOLUME,dst=/data" "$APP_IMAGE" python3 /opt/aiws/backup_archive.py extract "/backup/$leaf" /data
  echo '恢复已完成；应用保持停止状态。'
}

cd "$ROOT"
assert_docker
case "$COMMAND" in
  up)
    build_images; test_volume_subpath; override=$(new_import_override || true)
    trap '[[ -z "${override:-}" ]] || rm -f "$override"' EXIT
    release_args=("$ROOT/scripts/v20-release.mjs" --compose-file "$COMPOSE_FILE" --source-volume "$SOURCE_VOLUME" --target-volume "$VOLUME" --project-name aiws-v20 --app-image "$APP_IMAGE" --runner-image "$RUNNER_IMAGE" --port "$PORT")
    [[ -z "$override" ]] || release_args+=(--override "$override")
    node "${release_args[@]}" ;;
  down) compose down --remove-orphans; echo "数据卷 $VOLUME 已保留。" ;;
  logs) compose logs -f --tail 200 app ;;
  status) compose ps; docker volume inspect "$VOLUME" --format 'data volume: {{.Name}}' 2>/dev/null || true; docker volume inspect "$SOURCE_VOLUME" --format 'retained V1.10 volume: {{.Name}}' 2>/dev/null || true ;;
  verify)
    compose config --quiet; build_images; build_verify_image
    bridge_export=$(mktemp -d "${TMPDIR:-/tmp}/aiws-bridge-XXXXXX"); trap 'rm -rf "${bridge_export:-}"' EXIT
    docker build --target windows-bridge-export --output "type=local,dest=$bridge_export" "$ROOT"; test -f "$bridge_export/aiws-bridge.exe"
    docker run --rm "$RUNNER_IMAGE" --version; docker run --rm aiws-verify:2.0.0 corepack pnpm verify ;;
  backup) backup_data ;;
  restore) restore_data ;;
  reset)
    [[ "$CONFIRM" == 1 ]] || { echo reset_requires_confirm >&2; exit 2; }
    compose down --remove-orphans; docker volume rm "$VOLUME"; echo "仅数据卷 $VOLUME 已删除。" ;;
  *) echo 'usage: aiws.sh {up|down|logs|status|verify|backup|restore|reset} [--confirm]' >&2; exit 2 ;;
esac
