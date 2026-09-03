#!/usr/bin/env bash
set -Eeuo pipefail

PORTABLE_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PORTABLE_REPO_ROOT=$(cd -- "$PORTABLE_SCRIPT_DIR/.." && pwd -P)

temporary_root=$(mktemp -d -t codex-portable-smoke.XXXXXX)
cleanup() {
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

codex_home="$temporary_root/codex"
workspace_root="$temporary_root/workspace"
common_args=(
  --no-windows-codex
  --codex-home "$codex_home"
  --workspace-root "$workspace_root"
)
verify_args=(
  --codex-home "$codex_home"
  --workspace-root "$workspace_root"
)

printf '%s\n' 'Smoke: dry-run must not create targets'
bash "$PORTABLE_SCRIPT_DIR/install.sh" --dry-run "${common_args[@]}" >/dev/null
[[ ! -e "$codex_home" && ! -e "$workspace_root" ]]

printf '%s\n' 'Smoke: isolated install and verification'
bash "$PORTABLE_SCRIPT_DIR/install.sh" --force "${common_args[@]}" >/dev/null
bash "$PORTABLE_SCRIPT_DIR/verify.sh" --installed "${verify_args[@]}" >/dev/null
grep -Eq '^runCodexInWindowsSubsystemForLinux[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$codex_home/config.toml"

printf '%s\n' 'Smoke: unrelated files survive a forced install'
printf '%s\n' 'user file must survive' > "$workspace_root/user-file.txt"
printf '%s\n' 'custom_config_marker = "preserve-me"' >> "$codex_home/config.toml"
bash "$PORTABLE_SCRIPT_DIR/install.sh" --force "${common_args[@]}" >/dev/null
grep -Fqx 'user file must survive' "$workspace_root/user-file.txt"
grep -Fqx 'custom_config_marker = "preserve-me"' "$codex_home/config.toml"

printf '%s\n' 'Smoke: changed managed files require force and are backed up'
printf '%s\n' 'BROKEN' > "$workspace_root/AGENTS.md"
if bash "$PORTABLE_SCRIPT_DIR/install.sh" "${common_args[@]}" >/dev/null 2>&1; then
  printf '%s\n' 'expected install without --force to fail' >&2
  exit 1
fi
bash "$PORTABLE_SCRIPT_DIR/install.sh" --force "${common_args[@]}" >/dev/null
compgen -G "$workspace_root/.portable-backup-*-AGENTS.md" >/dev/null
bash "$PORTABLE_SCRIPT_DIR/verify.sh" --installed "${verify_args[@]}" >/dev/null

printf '%s\n' 'Smoke passed.'
