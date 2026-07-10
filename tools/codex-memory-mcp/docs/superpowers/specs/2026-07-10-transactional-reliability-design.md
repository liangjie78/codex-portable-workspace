# CodexMemory Transactional Reliability Design

## Decision

Evolve the file-first store to a recoverable transactional mutation model while
preserving its zero-dependency, local-only, portable design. This release also
hardens the stdio JSON-RPC boundary so malformed client input cannot terminate
the MCP process.

The user explicitly authorized autonomous iteration of the local CodexMemory
and related MCP system. That authorization is treated as approval for this
reversible, compatibility-preserving reliability release.

## Evidence

The healthy baseline is 35 valid cards, a current index, 35 existing source
paths, 16/16 unit tests, 22/22 retrieval evaluations, and a 9-tool MCP smoke
test. Independent audits then reproduced these risks in isolated temporary
stores:

- JSON text `null` terminates `server.mjs` instead of returning a protocol
  error.
- A type move writes the new card before deleting the old one; interruption
  leaves duplicate IDs that prevent reindexing and normal upserts.
- A multi-card completion may leave the first cards written and its index
  missing if a later write fails.
- A fixed-age lock can be reclaimed while a long snapshot still owns it, and
  a former owner can delete a newer owner's lock during cleanup.
- `rag_mark_verified` reads before it obtains the write lock, so it can restore
  stale card content over a concurrent update.

## Alternatives Considered

1. **Add SQLite or a vector database.** This would give database transactions,
   but adds installation, migration, backup, and portability work unrelated to
   the immediate filesystem correctness defects.
2. **Keep individual atomic writes and document recovery.** This leaves callers
   with partial-success ambiguity and requires manual filesystem repair after a
   crash; it is not suitable for a durable memory layer.
3. **Add a small, durable filesystem journal inside the existing deep store.**
   This is selected. It keeps the public MCP and CLI mental model intact while
   making multi-file operations recoverable without a new dependency or service.

## Architecture

`cardStore.mjs` remains the one deep module that owns parsing, validation,
locking, transaction planning, atomic replacement, index production, recovery,
and storage health. `cli.mjs` and `server.mjs` remain thin adapters.

### Owner-aware lock

The exclusive store lock records a random owner ID, PID, acquisition time, and
heartbeat time. A live owner periodically refreshes its lease while an async
operation such as a snapshot runs. Recovery may reclaim only an expired lease;
unlocking re-reads the lock and removes it only when its owner ID still matches.
This prevents an older process from deleting a newer lock.

### Durable mutation journal

Before a mutation changes visible cards or the JSONL index, the store writes an
atomic journal with every target path's prior and intended content. The journal
has two states:

- `prepared`: a crash or write failure rolls the store back to the recorded
  prior state on the next write operation.
- `committed`: recovery re-applies the intended state, then removes the journal.

An upsert, type move, explicit verification, completion batch, and index rebuild
all use the same journal. A caller either receives success with the intended
cards and index, or receives failure with the store rolled back; a process crash
is recovered before the next mutation. Read operations detect a pending journal
and return an integrity warning instead of silently returning a partially
committed memory.

### Consistent read and verification semantics

Duplicate IDs and cards stored outside their canonical type directory are
integrity errors. `rag_get` and `rag_search` do not silently select one duplicate
as authoritative. `rag_mark_verified` re-reads its target inside the exclusive
transaction and changes only verification/status metadata, preserving concurrent
content updates.

### MCP protocol boundary

The server accepts only non-null JSON-RPC object requests with a string method,
returns `-32600` for invalid requests, keeps notification behavior silent, and
caps an unterminated stdin line at a bounded size. Tool calls validate their
required domain inputs before reaching the store; invalid calls return a
structured tool error and do not initialize or mutate a knowledge root.

## Scope Boundaries

- No database, embedding model, network dependency, or automatic bulk
  extraction is introduced.
- The existing nine tool names and their successful-call result shapes remain
  compatible.
- No real knowledge card is rewritten during tests; all fault injection runs in
  temporary roots.
- No global provider, Headroom, Claude, GitNexus, or runtime-cache path is
  modified as part of this release.

## Verification Plan

Add deterministic tests for malformed protocol input, oversized unterminated
requests, owner-only lock release, stale lock recovery, mark-verified merge
semantics, interrupted type move, multi-card failure rollback, pending-journal
read protection, duplicate-ID read protection, and canonical-directory
validation. Retain the current regression gates:

```powershell
node --test
node src/cli.mjs validate
node src/cli.mjs reindex
node src/cli.mjs health
node scripts/eval.mjs
node scripts/smoke.mjs
```

## Acceptance Criteria

- Malformed JSON-RPC cannot terminate the server; a valid request immediately
  after an invalid one still succeeds.
- Interrupted type moves and completion batches recover to an all-before or
  all-after state with a current index.
- A live lock cannot be stolen solely because a slow operation exceeds the old
  180-second age threshold, and a former owner cannot remove a newer lock.
- Verification cannot overwrite a concurrent card-content update.
- No read path silently returns an arbitrary duplicate card.
- Existing real-store validation, retrieval evaluation, and MCP smoke tests
  stay green.
