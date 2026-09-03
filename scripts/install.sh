#!/usr/bin/env bash
set -Eeuo pipefail

PORTABLE_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PORTABLE_REPO_ROOT=$(cd -- "$PORTABLE_SCRIPT_DIR/.." && pwd -P)
export PORTABLE_SCRIPT_DIR PORTABLE_REPO_ROOT
# shellcheck source=lib.sh
source "$PORTABLE_SCRIPT_DIR/lib.sh"

PORTABLE_FORCE=0
PORTABLE_DRY_RUN=0
SKIP_CONFIG=0
SKIP_WINDOWS_CODEX=0
WORKSPACE_ROOT=${WORKSPACE_ROOT:-/mnt/d/Workspace}
CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
WINDOWS_CODEX_HOME=${WINDOWS_CODEX_HOME:-}

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [options]

Install the current WSL2-first Codex workflow into explicit targets.

Options:
  --dry-run, --what-if       Preview writes without changing files.
  --force                    Back up differing managed files before replacing them.
  --codex-home PATH          WSL Codex home (default: $HOME/.codex).
  --windows-codex-home PATH  Windows Codex home mounted in WSL (auto-detected when present).
  --no-windows-codex         Do not install into a detected Windows Codex home.
  --workspace-root PATH      Workspace root (default: /mnt/d/Workspace).
  --skip-config              Do not create or update config.toml.
  --help                     Show this help.
EOF
}

while (($#)); do
  case $1 in
    --dry-run|--what-if) PORTABLE_DRY_RUN=1 ;;
    --force) PORTABLE_FORCE=1 ;;
    --codex-home) shift; (($#)) || portable_die "--codex-home requires a path"; CODEX_HOME=$1 ;;
    --windows-codex-home) shift; (($#)) || portable_die "--windows-codex-home requires a path"; WINDOWS_CODEX_HOME=$1 ;;
    --no-windows-codex) SKIP_WINDOWS_CODEX=1 ;;
    --workspace-root) shift; (($#)) || portable_die "--workspace-root requires a path"; WORKSPACE_ROOT=$1 ;;
    --skip-config) SKIP_CONFIG=1 ;;
    --help|-h) usage; exit 0 ;;
    *) portable_die "unknown option: $1" ;;
  esac
  shift
done

portable_require_command python3
[[ "$(uname -s)" == "Linux" ]] || portable_die "run this installer inside a Linux environment, preferably WSL2 Ubuntu"

declare -a CODEX_TARGETS=()
add_unique_target() {
  local candidate=$1 existing
  [[ -n "$candidate" ]] || return 0
  for existing in "${CODEX_TARGETS[@]:-}"; do
    [[ "$existing" == "$candidate" ]] && return 0
  done
  CODEX_TARGETS+=("$candidate")
}

add_unique_target "$CODEX_HOME"
if [[ "$SKIP_WINDOWS_CODEX" != 1 && -z "$WINDOWS_CODEX_HOME" ]]; then
  WINDOWS_CODEX_HOME=$(portable_detect_windows_codex_home || true)
fi
if [[ "$SKIP_WINDOWS_CODEX" != 1 ]]; then
  add_unique_target "$WINDOWS_CODEX_HOME"
fi

portable_info "repository: $PORTABLE_REPO_ROOT"
portable_info "workspace target: $WORKSPACE_ROOT"
portable_info "Codex targets: ${CODEX_TARGETS[*]}"

install_config() {
  local target=$1
  local config="$target/config.toml"

  [[ "$SKIP_CONFIG" == 1 ]] && return 0
  if portable_config_has_wsl_mode "$config"; then
    portable_info "Codex WSL mode already enabled: $config"
    return 0
  fi
  if [[ "$PORTABLE_DRY_RUN" == 1 ]]; then
    portable_info "would enable Codex WSL mode: $config"
    return 0
  fi
  if portable_exists "$config" && [[ "$PORTABLE_FORCE" != 1 ]]; then
    portable_die "config.toml exists without the managed WSL flag; re-run with --force: $config"
  fi
  if portable_exists "$config"; then
    portable_backup_existing "$config"
  fi
  python3 "$PORTABLE_SCRIPT_DIR/lib/update_codex_config.py" --path "$config" --create >/dev/null
  portable_info "Codex WSL mode enabled: $config"
}

for codex_target in "${CODEX_TARGETS[@]}"; do
  portable_render_file \
    "$PORTABLE_REPO_ROOT/codex/AGENTS.md" \
    "$codex_target/AGENTS.md" \
    "$codex_target" \
    "$WORKSPACE_ROOT"
  install_config "$codex_target"
done

workspace_sources=(
  "AGENTS.md"
  "00_本机环境与工具清单.template.md"
  "01_全局工作台.md"
  "02_Codex用户使用说明.md"
)
for source_name in "${workspace_sources[@]}"; do
  target_name=$source_name
  if [[ "$source_name" == *.template.md ]]; then
    target_name=${source_name%.template.md}.md
  fi
  portable_render_file \
    "$PORTABLE_REPO_ROOT/workspace/$source_name" \
    "$WORKSPACE_ROOT/$target_name" \
    "$CODEX_HOME" \
    "$WORKSPACE_ROOT"
done

portable_info "installation complete"
