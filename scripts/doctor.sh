#!/usr/bin/env bash
set -Eeuo pipefail

PORTABLE_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PORTABLE_REPO_ROOT=$(cd -- "$PORTABLE_SCRIPT_DIR/.." && pwd -P)
export PORTABLE_SCRIPT_DIR PORTABLE_REPO_ROOT
# shellcheck source=lib.sh
source "$PORTABLE_SCRIPT_DIR/lib.sh"

CODEX_HOME=${CODEX_HOME:-$HOME/.codex}
WINDOWS_CODEX_HOME=${WINDOWS_CODEX_HOME:-}
WORKSPACE_ROOT=${WORKSPACE_ROOT:-/mnt/d/Workspace}

usage() {
  cat <<'EOF'
Usage: bash scripts/doctor.sh [options]

Options:
  --codex-home PATH          WSL Codex home (default: $HOME/.codex).
  --windows-codex-home PATH  Windows Codex home mounted in WSL.
  --workspace-root PATH      Workspace root (default: /mnt/d/Workspace).
  --help                     Show this help.
EOF
}

while (($#)); do
  case $1 in
    --codex-home) shift; (($#)) || portable_die "--codex-home requires a path"; CODEX_HOME=$1 ;;
    --windows-codex-home) shift; (($#)) || portable_die "--windows-codex-home requires a path"; WINDOWS_CODEX_HOME=$1 ;;
    --workspace-root) shift; (($#)) || portable_die "--workspace-root requires a path"; WORKSPACE_ROOT=$1 ;;
    --help|-h) usage; exit 0 ;;
    *) portable_die "unknown option: $1" ;;
  esac
  shift
done

checks=0
failures=0
warnings=0

check_result() {
  local status=$1
  local name=$2
  local detail=$3
  checks=$((checks + 1))
  case "$status" in
    OK) printf '[OK] %s: %s\n' "$name" "$detail" ;;
    WARN) printf '[WARN] %s: %s\n' "$name" "$detail"; warnings=$((warnings + 1)) ;;
    FAIL) printf '[FAIL] %s: %s\n' "$name" "$detail"; failures=$((failures + 1)) ;;
    *) portable_die "invalid doctor status: $status" ;;
  esac
}

if [[ "$(uname -s)" == "Linux" ]]; then
  check_result OK "kernel" "$(uname -r)"
else
  check_result FAIL "kernel" "not running Linux"
fi

if [[ -n "${WSL_DISTRO_NAME:-}" && "$(uname -r)" == *microsoft*WSL* ]]; then
  check_result OK "WSL" "$WSL_DISTRO_NAME"
else
  check_result WARN "WSL" "the current shell is Linux, but WSL2 identity was not confirmed"
fi

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" == ubuntu ]]; then
    check_result OK "distribution" "${PRETTY_NAME:-Ubuntu}"
  else
    check_result WARN "distribution" "${PRETTY_NAME:-unknown Linux}"
  fi
else
  check_result WARN "distribution" "/etc/os-release is missing"
fi

for command_name in bash git curl python3; do
  if command -v "$command_name" >/dev/null 2>&1; then
    check_result OK "$command_name" "$(command -v "$command_name")"
  else
    check_result FAIL "$command_name" "command is missing"
  fi
done

for command_name in node npm; do
  if command -v "$command_name" >/dev/null 2>&1; then
    check_result OK "$command_name" "$("$command_name" --version 2>/dev/null || printf 'installed')"
  else
    check_result WARN "$command_name" "optional command is missing"
  fi
done

if command -v codex >/dev/null 2>&1; then
  check_result OK "Codex CLI" "$(command -v codex); $(codex --version 2>/dev/null || true)"
else
  check_result FAIL "Codex CLI" "command is missing"
fi

if command -v bwrap >/dev/null 2>&1; then
  check_result OK "bubblewrap" "$(command -v bwrap)"
else
  check_result WARN "bubblewrap" "command is missing; Codex sandbox may not run"
fi

if sudo -n id -u >/dev/null 2>&1; then
  check_result OK "sudo" "non-interactive sudo is available"
else
  check_result WARN "sudo" "non-interactive sudo is unavailable"
fi

if [[ -z "$WINDOWS_CODEX_HOME" ]]; then
  WINDOWS_CODEX_HOME=$(portable_detect_windows_codex_home || true)
fi
config_target=$WINDOWS_CODEX_HOME
if [[ -z "$config_target" ]]; then
  config_target=$CODEX_HOME
fi
if portable_config_has_wsl_mode "$config_target/config.toml"; then
  check_result OK "Codex agent mode" "WSL mode is enabled in the active Codex config"
else
  check_result FAIL "Codex agent mode" "WSL flag is not enabled in $config_target/config.toml"
fi

if [[ -f "$WINDOWS_CODEX_HOME/../.wslconfig" ]]; then
  wslconfig="$WINDOWS_CODEX_HOME/../.wslconfig"
  all_networking=1
  for key in networkingMode=mirrored autoProxy=true dnsTunneling=true firewall=true; do
    grep -Eq "^$key[[:space:]]*$" "$wslconfig" || all_networking=0
  done
  if [[ "$all_networking" == 1 ]]; then
    check_result OK "WSL network profile" "mirrored, autoProxy, DNS tunneling and firewall are enabled"
  else
    check_result WARN "WSL network profile" "the current .wslconfig differs from the recorded profile"
  fi
else
  check_result WARN "WSL network profile" ".wslconfig was not found through the detected Windows Codex home"
fi

if command -v codex >/dev/null 2>&1; then
  sandbox_output=$(timeout 30 codex sandbox -- /bin/bash -lc 'printf codex-wsl-doctor-ok' 2>&1 || true)
  if [[ "$sandbox_output" == *codex-wsl-doctor-ok* ]]; then
    check_result OK "Codex sandbox" "Bash command executed inside the local sandbox"
  else
    check_result FAIL "Codex sandbox" "sandbox test did not return the success marker"
  fi
fi

if command -v getent >/dev/null 2>&1 && getent hosts archive.ubuntu.com >/dev/null 2>&1; then
  check_result OK "DNS" "archive.ubuntu.com resolves"
else
  check_result WARN "DNS" "archive.ubuntu.com did not resolve"
fi

if command -v curl >/dev/null 2>&1 && curl -fsSIL --max-time 10 https://github.com >/dev/null 2>&1; then
  check_result OK "network" "HTTPS request to GitHub succeeded"
else
  check_result WARN "network" "HTTPS request to GitHub failed or timed out"
fi

printf 'Doctor summary: checks=%s warnings=%s failures=%s\n' "$checks" "$warnings" "$failures"
if [[ "$failures" -gt 0 ]]; then
  exit 1
fi
