# CodexMemory Hardening Design

## Decision

Evolve the existing file-first CodexMemory MVP into a reliable local memory
layer without adding a database, network dependency, embedding model, or new
machine-wide service. The external MCP interface stays small: the existing six
tools remain compatible and one read-only `rag_health` tool is added.

This design is approved under the user's instruction to make all remaining
decisions autonomously.

## Context and Evidence

The current store validates 30 cards and has no load/card errors. The query
evaluation passes 17/17 cases and the stdio MCP smoke test passes. The MVP
already has useful card schema validation and deterministic search, but its
write path uses direct file overwrites, `rag_upsert` can leave the JSONL index
stale, and no command reports whether the store/index is operationally healthy.

## Alternatives Considered

1. Add a SQLite or vector database.
   - Better future ranking/query options, but adds installation, backup,
     migration, and portability work that is not justified by 30 local cards.
2. Keep the MVP unchanged and only add more cards.
   - Lowest short-term risk, but preserves the failure modes that make local
     memory unreliable as use grows.
3. Harden the file-first implementation and add observability. **Selected.**
   - Retains the portable zero-dependency model while making mutations safer,
     discoverable, and regression-tested.

## Modules and Interfaces

`cardStore.mjs` remains the deep store module. Its interface owns card parsing,
validation, search, mutation, indexing, and health reporting. Callers do not
learn lock-file names, temporary-file conventions, secret patterns, index
comparison, or duplicate-ID resolution.

`cli.mjs` and `server.mjs` are shallow adapters over that interface. They only
translate arguments and results; neither implements storage policy.

The external seam is intentionally limited to:

- existing `search`, `get`, `upsert`, `finish`, `validate`, and `reindex`;
- new read-only `health` / `rag_health`.

## Mutation Reliability

All mutations use one store-local exclusive lock with bounded retry and stale
lock recovery. The lock protects card writes and index rebuilds from concurrent
MCP processes. Every individual file is written to a uniquely named sibling
temporary file and atomically renamed only after its contents are complete.

`upsert` treats the card ID as the identity. It detects duplicate IDs, preserves
the original `created_at` when updating an existing card, updates the canonical
location when the type changes, and rebuilds the index before returning success.
It rejects ambiguous duplicate stores rather than overwriting an arbitrary file.

`finish` validates all lessons before writing any of them, then performs the
batch and index rebuild under the same lock. Invalid input cannot leave a
partially accepted batch.

## Data Safety and Quality

The store strips a UTF-8 BOM before frontmatter parsing, validates ISO local
dates, enforces compact-card size limits, rejects malformed tags, and blocks
high-confidence credential patterns such as private keys, provider tokens, and
Bearer authorization values. The guard is deliberately narrow: prose that says
"do not store tokens" remains valid, while actual credential-looking values do
not enter the durable knowledge base.

Existing hard-rule and privacy boundaries remain unchanged. Health reporting and
tests never print environment variables or credential values.

## Health Reporting

`health` reads the store without mutating it and returns:

- validation status and card/load error counts;
- per-status counts and cards whose verification date is overdue;
- index state (`current`, `missing`, `invalid`, or `stale`) based on card IDs
  and revision fields;
- actionable warnings and the local knowledge-root path.

This gives Codex a cheap preflight/diagnostic tool without making normal search
or write calls more complex.

## Configuration

The existing user-level stdio configuration remains opt-in and keeps explicit
startup and tool timeouts. It will add a `cwd` and an allowlist of the seven
intended tool names, both supported by the official Codex config reference.
The MCP remains optional (`required` is not enabled), so a local memory failure
cannot prevent Codex from starting.

## Verification Plan

Add Node built-in test-runner coverage for BOM parsing, date and credential
rejection, duplicate-ID policy, metadata preservation, automatic index refresh,
health states, and concurrent mutation serialization. Extend the MCP smoke test
to assert the new read-only tool and end-to-end health response. Run:

```powershell
$env:CODEX_MEMORY_ROOT='D:\Workspace\CodexMemory'
node --test
node src\cli.mjs validate
node src\cli.mjs reindex
node scripts\eval.mjs
node scripts\smoke.mjs
```

## Acceptance Criteria

- No direct production card/index overwrite remains in mutation code.
- Valid single writes and task-completion batches leave a current index.
- Repeated/concurrent writes cannot create a partial JSONL index or silently
  create duplicate IDs.
- The MCP advertises `rag_health` as a read-only tool and returns useful store
  state from a temporary root.
- Existing cards, the 17 query evaluation cases, and all legacy MCP operations
  remain compatible.
