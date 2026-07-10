# CodexMemory Explicit Verification Design

## Decision

Add an explicit `verify` / `rag_mark_verified` operation that refreshes one
existing card's verification date through the existing durable mutation path.
It never infers verification from search or read activity.

## Alternatives

1. Require callers to submit the whole card through `upsert`. This exposes too
   much card shape for one lifecycle operation.
2. Refresh verification automatically on reads/searches. This would turn
   retrieval into false evidence that the source was checked.
3. Add a narrow explicit mutation. **Selected.** It has one purpose, a small
   interface and uses the existing atomic write/lock/index implementation.

## Interface

`rag_mark_verified(id, last_verified_at?, status?)` and CLI
`verify <id> [--date YYYY-MM-DD] [--status STATUS]`:

- require an existing card ID;
- default the date to the local calendar date;
- preserve `created_at`, source details, body, tags and existing status;
- change status only when the caller explicitly supplies one;
- use the normal upsert path so the index is current before success returns.

## Error Handling and Verification

Unknown IDs return `ok: false` without creating a card. Invalid dates/statuses
are rejected by the existing schema validator. Tests cover successful metadata
preservation, missing-card safety and the MCP end-to-end call.
