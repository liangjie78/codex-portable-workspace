#!/usr/bin/env python3
"""Update only Codex's [desktop] WSL agent flag while preserving the file."""

from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path


KEY = "runCodexInWindowsSubsystemForLinux"
KEY_RE = re.compile(rf"^(?P<prefix>\s*{re.escape(KEY)}\s*=\s*)(?P<value>true|false)(?P<tail>\s*(?:#.*)?)$", re.IGNORECASE)
SECTION_RE = re.compile(r"^\s*\[([^\[\]]+)\]\s*$")


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def update(path: Path, create: bool) -> str:
    if not path.exists():
        if not create:
            raise FileNotFoundError(path)
        write_atomic(path, f"[desktop]\n{KEY} = true\n")
        return "created"

    original = path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in original else "\n"
    lines = original.splitlines()
    in_desktop = False
    found = False
    changed = False

    for index, line in enumerate(lines):
        section = SECTION_RE.match(line)
        if section:
            in_desktop = section.group(1).strip() == "desktop"
        if not in_desktop:
            continue
        match = KEY_RE.match(line)
        if not match:
            continue
        found = True
        replacement = f"{match.group('prefix')}true{match.group('tail')}"
        if replacement != line:
            lines[index] = replacement
            changed = True
        break

    if not found:
        desktop_start = None
        insert_at = len(lines)
        for index, line in enumerate(lines):
            section = SECTION_RE.match(line)
            if section and section.group(1).strip() == "desktop":
                desktop_start = index
                insert_at = len(lines)
                for next_index in range(index + 1, len(lines)):
                    if SECTION_RE.match(lines[next_index]):
                        insert_at = next_index
                        break
                break
        if desktop_start is None:
            if lines and lines[-1].strip():
                lines.append("")
            lines.extend(["[desktop]", f"{KEY} = true"])
        else:
            lines.insert(insert_at, f"{KEY} = true")
        changed = True

    if changed:
        ending = newline if original.endswith(("\n", "\r")) else ""
        write_atomic(path, newline.join(lines) + ending)
        return "updated"
    return "unchanged"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", type=Path, required=True)
    parser.add_argument("--create", action="store_true")
    args = parser.parse_args()
    print(update(args.path, args.create))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
