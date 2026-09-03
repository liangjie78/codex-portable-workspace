#!/usr/bin/env python3
"""Turn the two known machine paths back into portable placeholders."""

from __future__ import annotations

import argparse
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--codex-home", required=True)
    parser.add_argument("--workspace-root", required=True)
    args = parser.parse_args()

    text = args.source.read_text(encoding="utf-8")
    for value, placeholder in (
        (args.codex_home, "{{CODEX_HOME}}"),
        (args.workspace_root, "{{WORKSPACE_ROOT}}"),
    ):
        text = text.replace(value, placeholder)
    args.target.parent.mkdir(parents=True, exist_ok=True)
    with args.target.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
