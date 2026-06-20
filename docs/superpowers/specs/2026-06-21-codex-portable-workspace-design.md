# Codex Portable Workspace Design

## Goal

Store durable Codex and Workspace rules in a private Git repository and recreate the environment on a new Windows machine with one PowerShell command.

## Architecture

The repository is the source of truth for portable configuration:

- `codex/` stores global guidance and a safe configuration template.
- `workspace/` stores cross-project workflow rules.
- `skills/shared/` stores the adapted skills used by both Codex and Claude Code.
- `tools/` stores the customized CC-Switch worker source.
- `scripts/` performs backup, installation, verification, and secret scanning.

Machine-specific state is generated during installation. Authentication, tokens, cookies, sessions, caches, logs, worker jobs, and local databases never enter Git.

## Installation flow

`install.ps1` accepts explicit Codex home, Claude home, and Workspace paths. It copies rules and skills, installs worker dependencies when requested, and renders `config.toml` from placeholders. Existing files require `-Force`; otherwise the script stops instead of overwriting user work.

## Backup flow

`backup.ps1` refreshes only approved files and directories from the current machine. It does not discover arbitrary `.codex` contents. After copying, it runs the repository verifier and secret scan.

## Verification

`verify.ps1` checks repository structure, forbidden filenames, high-confidence credential patterns, skill manifests, generated configuration, and optional installed targets. A full test restores into isolated directories and runs worker offline verification.

## Safety

The repository is private but is treated as potentially exposable. Secrets are excluded by design, not merely hidden by repository visibility. All external paths are parameterized or generated.
