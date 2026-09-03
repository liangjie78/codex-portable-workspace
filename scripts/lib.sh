#!/usr/bin/env bash

portable_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

portable_info() {
  printf 'INFO: %s\n' "$*"
}

portable_warn() {
  printf 'WARN: %s\n' "$*" >&2
}

portable_require_command() {
  local command_name=$1
  command -v "$command_name" >/dev/null 2>&1 || portable_die "missing required command: $command_name"
}

portable_exists() {
  [[ -e "$1" || -L "$1" ]]
}

portable_timestamp() {
  date -u +%Y%m%dT%H%M%SZ
}

portable_backup_path() {
  local target=$1
  local parent base candidate suffix=0
  parent=$(dirname -- "$target")
  base=$(basename -- "$target")
  candidate="$parent/.portable-backup-$(portable_timestamp)-$base"
  while portable_exists "$candidate"; do
    suffix=$((suffix + 1))
    candidate="$parent/.portable-backup-$(portable_timestamp)-${suffix}-$base"
  done
  printf '%s\n' "$candidate"
}

portable_backup_existing() {
  local target=$1
  local backup
  portable_exists "$target" || return 0
  backup=$(portable_backup_path "$target")
  if [[ -d "$target" && ! -L "$target" ]]; then
    cp -a -- "$target" "$backup"
  else
    cp -p -- "$target" "$backup"
  fi
  portable_info "backup created: $backup"
}

portable_copy_file() {
  local source=$1
  local target=$2
  local force=$3
  local dry_run=$4

  [[ -f "$source" ]] || portable_die "source file is missing: $source"
  if portable_exists "$target"; then
    if [[ -f "$target" ]] && cmp -s -- "$source" "$target"; then
      portable_info "unchanged: $target"
      return 0
    fi
    if [[ "$dry_run" == 1 ]]; then
      portable_info "would replace: $target"
      return 0
    fi
    if [[ -d "$target" && ! -L "$target" ]]; then
      portable_die "target is a directory where a file is required: $target"
    fi
    if [[ "$force" != 1 ]]; then
      portable_die "target differs and --force was not supplied: $target"
    fi
    portable_backup_existing "$target"
  elif [[ "$dry_run" == 1 ]]; then
    portable_info "would create: $target"
    return 0
  fi

  mkdir -p -- "$(dirname -- "$target")"
  cp -p -- "$source" "$target"
  portable_info "installed: $target"
}

portable_copy_tree() {
  local source_root=$1
  local target_root=$2
  local force=$3
  local dry_run=$4
  local source relative target

  [[ -d "$source_root" ]] || portable_die "source directory is missing: $source_root"
  while IFS= read -r -d '' source; do
    relative=${source#"$source_root"/}
    target="$target_root/$relative"
    portable_copy_file "$source" "$target" "$force" "$dry_run"
  done < <(find "$source_root" -type f -not -path '*/node_modules/*' -not -path '*/.portable-backup-*/*' -print0 | sort -z)
}

portable_render_file() {
  local source=$1
  local target=$2
  local codex_home=$3
  local workspace_root=$4
  local temp

  temp=$(mktemp)
  python3 "$PORTABLE_SCRIPT_DIR/lib/render_template.py" \
    --source "$source" \
    --target "$temp" \
    --codex-home "$codex_home" \
    --workspace-root "$workspace_root"
  portable_copy_file "$temp" "$target" "$PORTABLE_FORCE" "$PORTABLE_DRY_RUN"
  rm -f -- "$temp"
}

portable_detect_windows_user() {
  local candidate
  if [[ -n "${WINDOWS_USER:-}" ]]; then
    printf '%s\n' "$WINDOWS_USER"
    return 0
  fi
  if command -v cmd.exe >/dev/null 2>&1; then
    candidate=$(cmd.exe /c echo %USERNAME% 2>/dev/null | tr -d '\r\n')
    if [[ -n "$candidate" && "$candidate" != '%USERNAME%' ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  return 1
}

portable_detect_windows_codex_home() {
  local candidate windows_user
  if [[ -n "${WINDOWS_CODEX_HOME:-}" ]]; then
    printf '%s\n' "$WINDOWS_CODEX_HOME"
    return 0
  fi
  if [[ -n "${USERPROFILE:-}" ]] && command -v wslpath >/dev/null 2>&1; then
    candidate="$(wslpath -u "$USERPROFILE" 2>/dev/null || true)/.codex"
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  windows_user=$(portable_detect_windows_user || true)
  if [[ -n "$windows_user" && -d "/mnt/c/Users/$windows_user/.codex" ]]; then
    printf '%s\n' "/mnt/c/Users/$windows_user/.codex"
    return 0
  fi
  return 1
}

portable_config_has_wsl_mode() {
  local config=$1
  [[ -f "$config" ]] || return 1
  awk '
    BEGIN { in_desktop = 0; found = 0 }
    /^[[:space:]]*\[/ {
      in_desktop = ($0 ~ /^[[:space:]]*\[desktop\][[:space:]]*$/)
    }
    in_desktop && /^[[:space:]]*runCodexInWindowsSubsystemForLinux[[:space:]]*=[[:space:]]*true([[:space:]]*#.*)?[[:space:]]*$/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$config"
}
