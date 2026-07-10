# codex-memory-mcp

Local-first, durable knowledge-card RAG for Codex.

This package is the reproducible tool layer. It does not contain this computer's memory data. The local knowledge base lives outside the package and is selected with `CODEX_MEMORY_ROOT`.

## Separation

```text
D:\Workspace\CodexMemory
  Local knowledge base for this machine only.

D:\Workspace\Projects\Project-013-CodexMemory\03_Source\codex-memory-mcp
  Portable MCP and CLI source code.
```

On another computer, copy or clone this package, create a local knowledge root for that machine, then set `CODEX_MEMORY_ROOT` to that local path.

## Knowledge Boundary

Store in CodexMemory:

- local environment facts and tool paths;
- Windows and PowerShell pitfalls;
- project history and reusable project lessons;
- build, test, verification and recovery workflows;
- common error symptoms, causes, fixes and evidence.

Do not store in CodexMemory:

- global hard rules;
- security policy;
- project directory rules;
- credentials, tokens, cookies, private production addresses;
- unreviewed long logs or one-off temporary commands.

Hard rules stay in `C:\Users\Administrator\.codex\AGENTS.md` and `D:\Workspace\01_全局工作台.md`. The RAG store is supporting memory only.

## Commands

Use PowerShell:

```powershell
$env:CODEX_MEMORY_ROOT = 'D:\Workspace\CodexMemory'
node src\cli.mjs validate
node src\cli.mjs reindex
node src\cli.mjs health
node src\cli.mjs search "PowerShell 中文乱码" --limit 5
node src\cli.mjs search "PowerShell 中文乱码" --limit 5 --json
node src\cli.mjs get win-powershell-encoding-001
node src\cli.mjs verify win-powershell-encoding-001 --status active
node src\cli.mjs snapshot --label before-major-change
node src\cli.mjs finish .\task-completion.json
node --test
node scripts\eval.mjs
```

Run the MCP server:

```powershell
$env:CODEX_MEMORY_ROOT = 'D:\Workspace\CodexMemory'
node src\server.mjs
```

The local Codex config has been updated with `[mcp_servers.codex-memory]`. Restart Codex after config changes so a new session can load the MCP tool list.

Run a no-pollution smoke test:

```powershell
node scripts\smoke.mjs
```

## MCP Tools

- `rag_search(query, project?, type?, tags?, limit?)`
- `rag_brief(query, project?, limit?)`
- `rag_maintenance_plan(limit?)`
- `rag_get(id)`
- `rag_mark_verified(id, last_verified_at?, status?)`
- `rag_snapshot(label?)`
- `rag_upsert(card)`
- `rag_finish_task(task_summary, project?, outcome?, source_path?, lessons)`
- `rag_validate()`
- `rag_health()`
- `rag_reindex()`

`rag_finish_task` is the preferred completion hook. At the end of a task, the agent should decide whether the task produced reusable experience. If yes, pass 1-5 structured lessons. The tool writes cards and rebuilds the index. If there are no reusable lessons, do not write a filler card.

`rag_search` defaults to a compact text list so multiple Chinese results stay readable in Codex output. Each result now includes a concise `match=` explanation. Pass `format: "json"` when a script needs structured fields, or `verbose: true` when the text list should include tags and short notes.

Cards can include up to 12 reviewed `aliases`: common user phrasings or bilingual synonyms. Search prefers complete phrases, then rewards how many distinct English words or Chinese two-character terms a card covers. Title, alias and tag evidence outrank source and body evidence. A non-empty query still requires an actual phrase or term overlap, so freshness and confidence cannot admit unrelated cards.

`rag_brief` is the read-only start-of-task companion. It turns the current query into a compact list of relevant cards, source pointers and verification reminders. It never creates a memory root or changes a card/index. Use `format: "json"` for scripts; the default text mode is intended for a Codex task prompt.

`rag_maintenance_plan` is a read-only upkeep report. It can recommend re-verification, fixing a missing local source, adding reviewed aliases or manually reviewing exact duplicate titles/aliases. It never applies these suggestions, reindexes, marks a card verified, merges cards or deletes files.

`rag_health` is a safe preflight tool. It reports validation errors, index state, card statuses, cards not verified in more than 180 days, and missing absolute local evidence paths. It never writes to the knowledge root. On Windows it checks only drive-qualified local paths, not UNC network shares. A missing source is a warning rather than a schema failure, so historical or label-based provenance remains portable.

When an external fact has actually been rechecked, use `rag_mark_verified` (or CLI `verify`) instead of rewriting the whole card. It records an explicit verification date and only changes status if you supply one. Reading or searching a card never refreshes its verification date.

`rag_snapshot` creates a new local directory under `backups/` containing cards, sources, evaluation fixtures and the current index. It writes SHA-256 checksums in `manifest.json` and publishes the snapshot only after it is complete. Snapshots never restore, overwrite or delete data; restore is deliberately a separate manual decision.

## Reliability guarantees

- Card and JSONL index files are written through a sibling temporary file and an atomic rename.
- Every multi-file mutation uses a durable local journal. A prepared journal rolls back on the next mutation; a committed journal finishes publishing, so type moves, task-completion batches, and index updates recover to a consistent state after interruption.
- Mutations acquire an owner-aware local lock with a heartbeat lease. A former owner cannot delete a replacement lock, and a live slow snapshot is not reclaimed solely because it exceeds the old fixed timeout.
- An upsert treats `id` as the identity, preserves an existing card's `created_at`, moves the canonical card if its type changes, and updates the index in the same transaction before reporting success.
- A task-completion batch validates every lesson before any write and commits its cards and index together. Ambiguous duplicate IDs are rejected instead of silently choosing a file.
- `rag_get` and `rag_search` refuse a pending transaction, duplicate card ID, or non-canonical card location instead of choosing an arbitrary memory. Run `rag_reindex` to recover a valid pending journal.
- The MCP boundary rejects malformed JSON-RPC requests and invalid tool arguments without initializing the knowledge root; an oversized unterminated stdin line is discarded at a 1 MiB boundary.
- The parser accepts UTF-8 BOM files and safely round-trips quoted frontmatter values, tags and aliases.
- Validation rejects malformed local dates, oversized cards, and credential-looking values (such as private keys, provider tokens, and Bearer headers). Use a redacted description instead of sensitive values.

These checks supplement, rather than replace, the rule that paths, versions, ports and external facts in a memory card must be independently re-verified before use.

## Reproducibility

This package uses only Node.js built-in modules. No `npm install` is required.

The MCP server is portable; the knowledge base is not bundled. Each machine should initialize its own `CODEX_MEMORY_ROOT`.

## Verification

Run from this package root:

```powershell
$env:CODEX_MEMORY_ROOT = 'D:\Workspace\CodexMemory'
node --test
node src\cli.mjs validate
node src\cli.mjs reindex
node src\cli.mjs health
node scripts\eval.mjs
node scripts\smoke.mjs
```

`scripts\smoke.mjs` creates and deletes its own temporary knowledge root. It does not add test cards to the real knowledge base.

`scripts\eval.mjs` keeps the existing Top-3 acceptance gate and also reports Top-1 count and mean reciprocal rank, so retrieval quality can be compared as cards grow.
