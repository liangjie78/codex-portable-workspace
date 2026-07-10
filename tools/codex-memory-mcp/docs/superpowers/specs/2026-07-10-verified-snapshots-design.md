# CodexMemory Verified Snapshots Design

## Decision

Add an explicit, append-only local snapshot operation. It captures the durable
knowledge-root content and writes a SHA-256 manifest. Automatic restore,
automatic retention deletion and remote copying are out of scope.

## Alternatives

1. Copy only Markdown cards. This loses evaluation fixtures, source evidence
   and the current index that explain a card's state.
2. Export one JSON file. This adds custom import/restore semantics and weakens
   normal file-level inspection.
3. Directory snapshot plus checksum manifest. **Selected.** It uses the
   existing file layout, is independently inspectable and has clear completion
   semantics.

## Interface

`rag_snapshot(label?)` and CLI `snapshot [--label TEXT]`:

- first validate the store; invalid cards cannot be snapshotted;
- copy only `cards`, `sources`, `eval` and `indexes` into `backups` under the
  knowledge root, excluding locks, temporary files and older backups;
- write `manifest.json` containing relative paths, byte lengths and SHA-256
  digests;
- use a `.partial` directory and rename it only after all copy/manifest work
  succeeds;
- return the final snapshot path and file count.

## Safety and Verification

Labels are normalized to an ASCII-safe filename segment. A snapshot never
overwrites another snapshot, deletes data or restores data. Tests verify that
the manifest detects the captured files and that an invalid store fails before
creating a snapshot.
