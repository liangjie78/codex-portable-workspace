#!/usr/bin/env bash
set -Eeuo pipefail

PORTABLE_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PORTABLE_REPO_ROOT=$(cd -- "$PORTABLE_SCRIPT_DIR/.." && pwd -P)
export PORTABLE_SCRIPT_DIR PORTABLE_REPO_ROOT
# shellcheck source=lib.sh
source "$PORTABLE_SCRIPT_DIR/lib.sh"

APPLY=0
FORCE=0
CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
WINDOWS_CODEX_HOME=${WINDOWS_CODEX_HOME:-}
WORKSPACE_ROOT=${WORKSPACE_ROOT:-/mnt/d/Workspace}

usage() {
  cat <<'EOF'
Usage: bash scripts/backup.sh [options]

Read the current installed public rules back into this repository.
The default is a dry run. --apply is required to write repository files.

Options:
  --dry-run                  Show differences without writing (default).
  --apply                    Apply differences to the repository.
  --force                    Allow replacing repository files after review.
  --codex-home PATH          WSL Codex home (default: $HOME/.codex).
  --windows-codex-home PATH  Use this Windows Codex home as the rule source.
  --workspace-root PATH      Workspace root (default: /mnt/d/Workspace).
  --help                     Show this help.
EOF
}

while (($#)); do
  case $1 in
    --dry-run) APPLY=0 ;;
    --apply) APPLY=1 ;;
    --force) FORCE=1 ;;
    --codex-home) shift; (($#)) || portable_die "--codex-home requires a path"; CODEX_HOME=$1 ;;
    --windows-codex-home) shift; (($#)) || portable_die "--windows-codex-home requires a path"; WINDOWS_CODEX_HOME=$1 ;;
    --workspace-root) shift; (($#)) || portable_die "--workspace-root requires a path"; WORKSPACE_ROOT=$1 ;;
    --help|-h) usage; exit 0 ;;
    *) portable_die "unknown option: $1" ;;
  esac
  shift
done

portable_require_command python3

if [[ -z "$WINDOWS_CODEX_HOME" ]]; then
  WINDOWS_CODEX_HOME=$(portable_detect_windows_codex_home || true)
fi
CODEX_SOURCE_HOME=$CODEX_HOME
if [[ -n "$WINDOWS_CODEX_HOME" && -f "$WINDOWS_CODEX_HOME/AGENTS.md" ]]; then
  CODEX_SOURCE_HOME=$WINDOWS_CODEX_HOME
fi

if [[ "$APPLY" == 1 && "$FORCE" != 1 ]]; then
  if ! git -C "$PORTABLE_REPO_ROOT" diff --quiet || ! git -C "$PORTABLE_REPO_ROOT" diff --cached --quiet; then
    portable_die "repository has existing changes; review them and re-run with --force"
  fi
fi

ERRORS=0
backup_rule() {
  local installed=$1
  local portable=$2
  local temp
  if [[ ! -f "$installed" ]]; then
    printf 'WARN: installed source is missing: %s\n' "$installed" >&2
    ERRORS=$((ERRORS + 1))
    return 0
  fi
  temp=$(mktemp)
  python3 "$PORTABLE_SCRIPT_DIR/lib/normalize_template.py" \
    --source "$installed" \
    --target "$temp" \
    --codex-home "$CODEX_SOURCE_HOME" \
    --workspace-root "$WORKSPACE_ROOT"
  if cmp -s -- "$temp" "$portable"; then
    portable_info "unchanged: $portable"
  elif [[ "$APPLY" == 1 ]]; then
    [[ "$FORCE" == 1 ]] || portable_die "refusing to replace repository file without --force: $portable"
    cp -p -- "$temp" "$portable"
    portable_info "updated from installed state: $portable"
  else
    portable_info "would update from installed state: $portable"
  fi
  rm -f -- "$temp"
}

backup_rule \
  "$CODEX_SOURCE_HOME/AGENTS.md" \
  "$PORTABLE_REPO_ROOT/codex/AGENTS.md"

workspace_sources=(
  "AGENTS.md"
  "00_本机环境与工具清单.md"
  "01_全局工作台.md"
  "02_Codex用户使用说明.md"
)
for target_name in "${workspace_sources[@]}"; do
  source_name=$target_name
  if [[ "$target_name" == 00_* ]]; then
    source_name="$target_name.template.md"
  fi
  backup_rule \
    "$WORKSPACE_ROOT/$target_name" \
    "$PORTABLE_REPO_ROOT/workspace/$source_name"
done

if [[ "$ERRORS" -gt 0 ]]; then
  portable_die "backup could not read all required installed rules"
fi
if [[ "$APPLY" == 1 ]]; then
  portable_info "backup applied; run bash scripts/verify.sh before committing"
else
  portable_info "dry run complete; no repository files were written"
fi
