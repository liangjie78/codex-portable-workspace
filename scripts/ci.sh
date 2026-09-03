#!/usr/bin/env bash
set -Eeuo pipefail

PORTABLE_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PORTABLE_REPO_ROOT=$(cd -- "$PORTABLE_SCRIPT_DIR/.." && pwd -P)

bash "$PORTABLE_SCRIPT_DIR/verify.sh"
bash "$PORTABLE_SCRIPT_DIR/smoke.sh"

if git -C "$PORTABLE_REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$PORTABLE_REPO_ROOT" diff --check
fi

printf 'CI checks passed.\n'
