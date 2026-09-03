#!/usr/bin/env bash
set -Eeuo pipefail

PORTABLE_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PORTABLE_REPO_ROOT=$(cd -- "$PORTABLE_SCRIPT_DIR/.." && pwd -P)
export PORTABLE_SCRIPT_DIR PORTABLE_REPO_ROOT
# shellcheck source=lib.sh
source "$PORTABLE_SCRIPT_DIR/lib.sh"

CHECK_INSTALLED=0
SKIP_CONFIG=0
CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
WINDOWS_CODEX_HOME=${WINDOWS_CODEX_HOME:-}
WORKSPACE_ROOT=${WORKSPACE_ROOT:-/mnt/d/Workspace}
ERRORS=0

usage() {
  cat <<'EOF'
Usage: bash scripts/verify.sh [options]

Options:
  --installed               Also compare installed files with this repository.
  --codex-home PATH         WSL Codex home (default: $HOME/.codex).
  --windows-codex-home PATH Also verify a Windows Codex home mounted in WSL.
  --workspace-root PATH     Workspace root (default: /mnt/d/Workspace).
  --skip-config             Do not require or check config.toml.
  --help                    Show this help.
EOF
}

while (($#)); do
  case $1 in
    --installed) CHECK_INSTALLED=1 ;;
    --codex-home) shift; (($#)) || portable_die "--codex-home requires a path"; CODEX_HOME=$1 ;;
    --windows-codex-home) shift; (($#)) || portable_die "--windows-codex-home requires a path"; WINDOWS_CODEX_HOME=$1 ;;
    --workspace-root) shift; (($#)) || portable_die "--workspace-root requires a path"; WORKSPACE_ROOT=$1 ;;
    --skip-config) SKIP_CONFIG=1 ;;
    --help|-h) usage; exit 0 ;;
    *) portable_die "unknown option: $1" ;;
  esac
  shift
done

fail_check() {
  printf 'FAIL: %s\n' "$*" >&2
  ERRORS=$((ERRORS + 1))
}

require_file() {
  local path=$1
  [[ -f "$path" ]] || fail_check "missing file: $path"
}

required_files=(
  "README.md"
  "AGENTS.md"
  ".gitignore"
  "LICENSE"
  "SECURITY.md"
  "codex/AGENTS.md"
  "codex/config.fragment.toml"
  "workspace/AGENTS.md"
  "workspace/00_本机环境与工具清单.template.md"
  "workspace/01_全局工作台.md"
  "workspace/02_Codex用户使用说明.md"
  "wsl/.wslconfig"
  "docs/architecture.md"
  "docs/migration.md"
  "scripts/install.sh"
  "scripts/backup.sh"
  "scripts/doctor.sh"
  "scripts/smoke.sh"
  "scripts/ci.sh"
  "scripts/lib.sh"
  "scripts/lib/normalize_template.py"
  "scripts/lib/render_template.py"
  "scripts/lib/update_codex_config.py"
  ".github/workflows/ci.yml"
)
for relative in "${required_files[@]}"; do
  require_file "$PORTABLE_REPO_ROOT/$relative"
done

for legacy in \
  "$PORTABLE_REPO_ROOT/codex/config.template.toml" \
  "$PORTABLE_REPO_ROOT/scripts/backup.ps1" \
  "$PORTABLE_REPO_ROOT/scripts/ci.ps1" \
  "$PORTABLE_REPO_ROOT/scripts/common.ps1" \
  "$PORTABLE_REPO_ROOT/scripts/doctor.ps1" \
  "$PORTABLE_REPO_ROOT/scripts/install.ps1" \
  "$PORTABLE_REPO_ROOT/scripts/smoke-portable-workspace.ps1" \
  "$PORTABLE_REPO_ROOT/scripts/verify.ps1" \
  "$PORTABLE_REPO_ROOT/skills" \
  "$PORTABLE_REPO_ROOT/tools"; do
  if portable_exists "$legacy"; then
    fail_check "legacy path must not exist: $legacy"
  fi
done

while IFS= read -r -d '' script; do
  if ! bash -n "$script"; then
    fail_check "Bash syntax error: $script"
  fi
done < <(find "$PORTABLE_REPO_ROOT/scripts" -type f -name '*.sh' -print0 | sort -z)

portable_require_command python3
if ! python3 - \
  "$PORTABLE_REPO_ROOT/scripts/lib/normalize_template.py" \
  "$PORTABLE_REPO_ROOT/scripts/lib/render_template.py" \
  "$PORTABLE_REPO_ROOT/scripts/lib/update_codex_config.py" <<'PY'
import ast
import pathlib
import sys

for raw_path in sys.argv[1:]:
    ast.parse(pathlib.Path(raw_path).read_text(encoding="utf-8"), filename=raw_path)
PY
then
  fail_check "Python syntax validation failed"
fi

if ! grep -Eq '^runCodexInWindowsSubsystemForLinux[[:space:]]*=[[:space:]]*true[[:space:]]*$' \
  "$PORTABLE_REPO_ROOT/codex/config.fragment.toml"; then
  fail_check "Codex config fragment does not enable WSL agent mode"
fi
for key in networkingMode=mirrored autoProxy=true dnsTunneling=true firewall=true; do
  grep -Eq "^$key$" "$PORTABLE_REPO_ROOT/wsl/.wslconfig" || fail_check "WSL config is missing: $key"
done

while IFS= read -r -d '' path; do
  relative=${path#"$PORTABLE_REPO_ROOT"/}
  base=$(basename -- "$path")
  case "$base" in
    auth.json|.env|.env.*|*.pem|*.key|*.p12|*.pfx|*.jks|*.keystore|id_rsa|id_ed25519|*.sqlite|*.sqlite3)
      [[ "$base" == ".env.example" ]] || fail_check "sensitive filename is present: $relative"
      ;;
  esac
done < <(find "$PORTABLE_REPO_ROOT" -path "$PORTABLE_REPO_ROOT/.git" -prune -o -type f -print0)

if command -v rg >/dev/null 2>&1; then
  if rg -n -I --hidden -g '!.git/**' -g '!*.png' -g '!*.webp' -g '!*.jpg' \
    -e 'sk-[A-Za-z0-9]{20,}' \
    -e 'ghp_[A-Za-z0-9]{20,}' \
    -e 'github_pat_[A-Za-z0-9_]{20,}' \
    -e 'AKIA[0-9A-Z]{16}' \
    "$PORTABLE_REPO_ROOT" >/dev/null; then
    fail_check "high-confidence credential pattern found"
  fi
fi

compare_rendered() {
  local source=$1
  local target=$2
  local codex_home=$3
  local workspace_root=$4
  local temp
  [[ -f "$target" ]] || { fail_check "installed file is missing: $target"; return; }
  temp=$(mktemp)
  python3 "$PORTABLE_SCRIPT_DIR/lib/render_template.py" \
    --source "$source" \
    --target "$temp" \
    --codex-home "$codex_home" \
    --workspace-root "$workspace_root"
  if ! cmp -s -- "$temp" "$target"; then
    fail_check "installed file differs from portable source: $target"
  fi
  rm -f -- "$temp"
}

verify_installed_codex() {
  local target=$1
  compare_rendered "$PORTABLE_REPO_ROOT/codex/AGENTS.md" "$target/AGENTS.md" "$target" "$WORKSPACE_ROOT"
  if [[ "$SKIP_CONFIG" != 1 ]] && ! portable_config_has_wsl_mode "$target/config.toml"; then
    fail_check "Codex WSL flag is not enabled: $target/config.toml"
  fi
}

if [[ "$CHECK_INSTALLED" == 1 ]]; then
  verify_installed_codex "$CODEX_HOME"
  if [[ -n "$WINDOWS_CODEX_HOME" && "$WINDOWS_CODEX_HOME" != "$CODEX_HOME" ]]; then
    verify_installed_codex "$WINDOWS_CODEX_HOME"
  fi

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
    compare_rendered \
      "$PORTABLE_REPO_ROOT/workspace/$source_name" \
      "$WORKSPACE_ROOT/$target_name" \
      "$CODEX_HOME" \
      "$WORKSPACE_ROOT"
  done
fi

if [[ "$ERRORS" -gt 0 ]]; then
  printf 'Verification failed: %s check(s)\n' "$ERRORS" >&2
  exit 1
fi
printf 'Verification passed.\n'
