# CodexMemory Source Integrity Design

## Decision

Extend the existing read-only health report with source-evidence integrity.
Only absolute local paths are checked (drive-qualified paths on Windows; UNC
network paths are deliberately excluded). A missing path is an operational
warning, not a card-schema error and not a write blocker.

The user authorized autonomous decisions for this thread; this small extension
is approved under that instruction.

## Alternatives

1. Do nothing. This keeps health simple but cannot reveal deleted local evidence.
2. Reject cards whose source path is missing. This would incorrectly reject
   legitimate provenance labels such as task completion analysis and historical
   external references.
3. Report source integrity in `rag_health`. **Selected.** It makes evidence
   drift visible while preserving card portability and existing workflows.

## Interface

`getStoreHealth` gains a `sources` object:

- `checked`: number of absolute local paths inspected;
- `existing`: inspected paths that exist;
- `missing`: inspected paths that do not exist;
- `uncheckable`: labels, relative paths and non-local references intentionally
  excluded from filesystem checks;
- `missing_sources`: at most 25 card identifiers and paths for remediation.

Health is `ok` only when validation, index and inspected sources are healthy.
A missing source adds an actionable warning but does not change the card's
status, mutate data or prevent search/upsert.

## Verification

Add a temporary-root test with a card whose absolute source path is absent. It
must write successfully, then make `getStoreHealth` return `missing = 1`, a
warning, and `ok = false`. Existing real cards must remain healthy after the
change.
