# CodexMemory MVP Spec

## Purpose

CodexMemory is a local-first long-term memory layer for Codex. It turns durable experience into small, source-backed knowledge cards and exposes a small MCP interface for search, read, upsert, validation and indexing.

It is not a replacement for global rules. It is an on-demand memory layer.

## Architecture

```text
Global rules and Workspace workbench
  Hard rules, project workflow, safety boundaries.

Local knowledge base
  Machine-specific cards, sources, indexes and eval queries.

codex-memory-mcp
  Portable CLI and MCP adapter.
```

## Knowledge Root

The current machine uses:

```text
D:\Workspace\CodexMemory
```

The tool resolves the root in this order:

1. `CODEX_MEMORY_ROOT`
2. `D:\Workspace\CodexMemory` when it exists
3. `<home>\.codex-memory`

For reproducible installs on other computers, set `CODEX_MEMORY_ROOT` explicitly.

## Card Format

Cards are Markdown files with frontmatter:

```yaml
---
id: win-powershell-encoding-001
title: PowerShell 读取中文文件需要显式 UTF-8
type: pitfall
scope: global
project: null
status: active
confidence: high
tags: [windows, powershell, encoding]
source_path: D:\Workspace\00_本机环境与工具清单.md
source_section: Windows / PowerShell 注意事项
created_at: 2026-07-08
updated_at: 2026-07-08
last_verified_at: 2026-07-08
---

## Problem

...
```

Required fields:

- `id`
- `title`
- `type`
- `status`
- `confidence`
- `tags`
- `source_path`
- body text

Allowed `type` values:

- `environment`
- `tool`
- `workflow`
- `pitfall`
- `project`
- `error`
- `decision`

Allowed `status` values:

- `active`
- `needs_verification`
- `stale`
- `deprecated`

Allowed `confidence` values:

- `high`
- `medium`
- `low`

## Search

MVP search is deterministic full-text scoring:

```text
title hit > tag hit > project/type hit > source hit > body hit > recent verification > confidence
```

This keeps search explainable before adding embeddings.

## MCP Interface

The public interface is intentionally small:

```text
rag_search(query, project?, type?, tags?, limit?)
rag_get(id)
rag_upsert(card)
rag_finish_task(task_summary, project?, outcome?, source_path?, lessons)
rag_validate()
rag_reindex()
```

The implementation can change without changing the caller's mental model.

`rag_search` has two output modes:

- default text mode: compact one-line results for Codex and terminal readability;
- `format: "json"`: full structured search result for scripts and tests.

Use `verbose: true` only when the caller needs tags and short notes in text mode. For full details, call `rag_get(id)`.

## Maintenance Rules

- Add cards only for reusable knowledge.
- Prefer 3 to 5 high-quality cards after a project, not long transcript dumps.
- Keep hard rules in global rules and the Workspace workbench.
- Add `source_path` and evidence for every card.
- Mark uncertain cards `needs_verification`.
- Mark outdated cards `stale` or `deprecated`; do not silently delete useful history.
- Never store secrets or production credentials.
- At task completion, analyze whether the task produced reusable experience. If yes, write 1 to 5 cards with `rag_finish_task` or `rag_upsert`, then validate and reindex. If not, say no new reusable memory was found.

## Validation

Minimum gates:

```powershell
node src\cli.mjs validate
node src\cli.mjs reindex
node src\cli.mjs search "PowerShell 中文乱码"
node scripts\eval.mjs
node scripts\smoke.mjs
```
