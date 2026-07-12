# Security Policy

This repository contains portable workspace configuration, installation scripts, skill snapshots, and MCP tool source code for a Windows Codex/Claude Code setup.

## Supported Usage

The public repository is intended to store portable, reviewable files only. It must not contain local authentication state, tokens, cookies, machine caches, chat/session history, worker job data, or private machine memory data.

Before running the installation scripts on a new machine, read the script changes and adjust paths for your own environment.

## Sensitive Data

Do not commit or paste:

- `.codex\auth.json`
- `.env` or `.env.*`
- API keys, access tokens, refresh tokens, cookies, or passwords
- private keys or certificates
- production service URLs with credentials
- local logs, caches, sessions, worker jobs, or machine memory files

Use `templates/local-secrets.example.ps1` as a shape-only example, then keep any populated secrets file outside the repository.

## Reporting a Vulnerability

If you find a secret exposure or security-sensitive issue, do not open a public issue containing the secret value. Contact the repository owner privately through GitHub profile contact options, or open a minimal public issue that describes the affected file path and risk without including the secret itself.

After any accidental exposure, rotate the affected secret immediately. Removing it from the latest commit is not enough if it was already pushed to GitHub history.

## Local Verification

Run the repository verification before pushing changes:

```powershell
.\scripts\verify.ps1
```

For installed-machine coverage checks, run:

```powershell
.\scripts\verify.ps1 -CheckInstalled -AuditInstalledCoverage
```
