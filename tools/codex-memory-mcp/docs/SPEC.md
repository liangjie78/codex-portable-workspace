# CodexMemory Spec

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
aliases: [中文文件乱码, PowerShell 读取 UTF-8 文本]
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

Optional `aliases` is a reviewed array of up to 12 non-empty, unique, one-line phrases. Each alias is limited to 120 characters. Use it for common natural-language questions and bilingual equivalents; do not place generated speculation or secrets there.

## Search

Search is deterministic and explainable:

```text
full phrase > term coverage > title > alias/tag > source > body > recent verification > confidence
```

This keeps search explainable before adding embeddings. A query must overlap a phrase or useful term. English stop words and a small set of non-informative Chinese bigrams do not inflate coverage. `match_reason` identifies phrase and term evidence; `score` is comparable within one package version, not a stable public scale.

For continuous Han text, search uses overlapping two-character terms. Reviewed aliases let a card answer natural Chinese wording even when its canonical title/body is English or uses a technical abbreviation.

## MCP Interface

The public interface is intentionally small:

```text
rag_search(query, project?, type?, tags?, limit?)
rag_brief(query, project?, limit?)
rag_maintenance_plan(limit?)
rag_get(id)
rag_mark_verified(id, last_verified_at?, status?)
rag_snapshot(label?)
rag_upsert(card)
rag_finish_task(task_summary, project?, outcome?, source_path?, lessons)
rag_validate()
rag_health()
rag_reindex()
```

The implementation can change without changing the caller's mental model.

`rag_search` has two output modes:

- default text mode: compact one-line results for Codex and terminal readability;
- `format: "json"`: full structured search result for scripts and tests.

Use `verbose: true` only when the caller needs tags and short notes in text mode. For full details, call `rag_get(id)`.

`rag_brief` is a read-only task-start view. It reuses search and health checks to list relevant cards, their source pointers and any verification reminders. It returns a compact text brief by default or a structured JSON brief for scripts. A brief never initializes a knowledge root, reindexes, updates metadata or creates cards.

`rag_maintenance_plan` is a read-only maintenance view. It reports only evidence-backed `verify`, `source_missing`, `add_aliases` and `possible_duplicate` suggestions. A duplicate is reported only when normalized titles or aliases are exactly the same, not from ordinary word overlap. The plan never applies an action, writes a card, changes status, rebuilds the index or deletes content.

## Maintenance Rules

- Add cards only for reusable knowledge.
- Prefer 3 to 5 high-quality cards after a project, not long transcript dumps.
- Keep hard rules in global rules and the Workspace workbench.
- Add `source_path` and evidence for every card.
- Mark uncertain cards `needs_verification`.
- Mark outdated cards `stale` or `deprecated`; do not silently delete useful history.
- Never store secrets or production credentials.
- Treat an `id` as one canonical card. An update preserves `created_at`; conflicting duplicate files are a validation error.
- Mutations use an owner-aware local lock with a heartbeat lease, atomic file replacement, and a durable transaction journal. Successful writes publish cards and the index as one recoverable transaction; `rag_reindex` repairs a valid pending journal before rebuilding the index.
- `rag_health` is the preflight surface for validation, index freshness, status counts and overdue verification dates.
- `rag_health` also checks whether absolute local `source_path` values still exist. A missing path is surfaced as a warning; it does not silently rewrite card status or block a legitimate non-file provenance label.
- Use `rag_mark_verified` only after a source has been actually rechecked. It preserves card content and status by default, updates the verification date, and rebuilds the index before success returns.
- Use `rag_snapshot` before material memory changes when an independent local recovery point is valuable. It copies the allowed knowledge-root directories and emits a SHA-256 manifest; it never restores or removes snapshots.
- A snapshot index stores card locations relative to its own root, so the snapshot can be health-checked as an independent local store.
- Read operations reject duplicate IDs, cards outside their canonical type directory, and a pending transaction rather than silently selecting one potentially wrong card.
- At task completion, analyze whether the task produced reusable experience. If yes, write 1 to 5 cards with `rag_finish_task` or `rag_upsert`, then validate and reindex. If not, say no new reusable memory was found.

## Validation

Minimum gates:

```powershell
node src\cli.mjs validate
node src\cli.mjs reindex
node src\cli.mjs health
node src\cli.mjs search "PowerShell 中文乱码"
node --test
node scripts\eval.mjs
node scripts\smoke.mjs
```
