#!/usr/bin/env python3
"""Render the small, explicit placeholder set used by this repository."""

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
    replacements = {
        "{{CODEX_HOME}}": args.codex_home,
        "{{WORKSPACE_ROOT}}": args.workspace_root,
    }
    for placeholder, value in replacements.items():
        text = text.replace(placeholder, value)

    args.target.parent.mkdir(parents=True, exist_ok=True)
    with args.target.open("w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
