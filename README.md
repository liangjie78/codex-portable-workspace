# Codex Portable Workspace

Private, version-controlled configuration for recreating a personal Codex + Claude Code workspace on Windows.

## What it restores

- Codex global `AGENTS.md`
- Workspace workflow and collaboration rules
- Shared Codex/Claude Code skills
- Customized CC-Switch worker source
- A safe, machine-generated `config.toml`

It never restores login sessions, tokens, cookies, caches, conversation history, or worker jobs.

## New computer

Install Git, Node.js, Codex, Claude Code, and GitHub CLI, then:

```powershell
git clone https://github.com/liangjie78/codex-portable-workspace.git
cd codex-portable-workspace
.\scripts\install.ps1 -Force -InstallWorkerDependencies
.\scripts\verify.ps1 -CheckInstalled
```

The defaults are:

```text
Codex home:    %USERPROFILE%\.codex
Claude home:   %USERPROFILE%\.claude
Workspace:     D:\Workspace
Worker source: D:\Workspace\Tools\cc-switch-worker-mcp
```

Log in to Codex, GitHub, and external connectors separately after installation.
When `-Force` replaces an existing file or directory, the installer first creates a timestamped `.portable-backup-*` copy beside it.

## Keep the repository current

Run from the repository:

```powershell
.\scripts\backup.ps1
git diff
.\scripts\verify.ps1
```

Review the diff before committing and pushing.

## Safety model

The backup script uses a fixed allowlist. `.gitignore` is a second line of defense, and `verify.ps1` rejects known secret filenames and common credential formats. Do not manually add `.codex\auth.json`, `.env`, API keys, cookies, logs, sessions, or temporary job data.
