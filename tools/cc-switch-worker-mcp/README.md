# CC-Switch Worker MCP

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

CC-Switch Worker MCP is a local MCP server that lets Codex delegate bounded coding work to Claude Code through a local CC-Switch gateway. Codex keeps the supervisor role: it decides the task boundary, starts a worker, reviews the result, and runs final verification.

The goal is to save Codex main-thread context on real engineering tasks. It is not a standalone model client and it does not include model credentials.

## Features

- Starts scoped Claude Code worker jobs from MCP tools.
- Supports async job lifecycle tools: start, get, list, diagnose, tail, wait, and cancel.
- Records compact progress facts such as heartbeat, health state, changed files, checks, and policy results.
- Provides safe-mode permission hooks for bounded read/edit/check workflows.
- Detects duplicate active jobs for the same task unless parallel execution is explicit.
- Includes setup, doctor, offline smoke tests, and npm package hygiene checks.
- Lets Codex select Claude Code skills per task and grants only the exact `Skill(name)` permissions for that worker invocation.
- Uses the local CC-Switch gateway by default: `http://127.0.0.1:15721`.

## Requirements

- Node.js 20 or newer.
- Claude Code CLI installed locally.
- A reachable CC-Switch gateway.
- A Codex Desktop or other MCP-compatible client that can run local stdio MCP servers.

Authentication is intentionally external to this repository. Configure it on your own machine with one of these options:

- `ANTHROPIC_AUTH_TOKEN`
- `CC_SWITCH_API_KEY_FILE`
- the default local gateway flow, `PROXY_MANAGED`

Do not commit tokens, `.env` files, gateway config files, logs, job snapshots, or local memory files.

## Install From GitHub

After you publish this repository, replace `YOUR_GITHUB_USERNAME` with your GitHub username and use the tag you create.

```json
{
  "mcpServers": {
    "cc-switch-worker": {
      "command": "npx",
      "args": [
        "github:YOUR_GITHUB_USERNAME/cc-switch-worker-mcp#v0.4.5-rc.1"
      ]
    }
  }
}
```

You can also clone and run it from source:

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/cc-switch-worker-mcp.git
cd cc-switch-worker-mcp
npm install
npm run mcp:setup
npm run mcp:doctor
```

Source-mode MCP config:

```json
{
  "mcpServers": {
    "cc-switch-worker": {
      "command": "node",
      "args": ["/absolute/path/to/cc-switch-worker-mcp/src/cc-switch-worker-mcp.mjs"]
    }
  }
}
```

Check a GitHub tag without installing globally:

```bash
npx github:YOUR_GITHUB_USERNAME/cc-switch-worker-mcp#v0.4.5-rc.1 --doctor
```

Expected shape:

```json
{
  "server_version": "0.4.5-rc.1",
  "ok": true
}
```

## Tools

- `cc_switch_start_implementation`: start a background worker job.
- `cc_switch_get_job`: read compact job status.
- `cc_switch_list_jobs`: list recent persisted jobs.
- `cc_switch_diagnose_job`: inspect local MCP-level evidence for one job.
- `cc_switch_tail_job`: read compact status, with optional logs/events.
- `cc_switch_wait_for_job`: observe a job for a short window.
- `cc_switch_cancel_job`: request cancellation.
- `cc_switch_implement_in_workspace`: synchronous mode for tiny edits.

Large evidence is opt-in:

- `include_logs: true`
- `include_events: true`
- `include_diff: true`

Default status output is intentionally small so the supervisor agent does not spend context reading logs unless it needs them.

## Recommended Workflow

Start with one clear, bounded implementation task:

```json
{
  "name": "cc_switch_start_implementation",
  "arguments": {
    "cwd": "/absolute/project/path",
    "task": "Make the requested code change.",
    "worker_profile": "scoped_patch",
    "safety_mode": "safe",
    "allowed_dirs": ["src"],
    "forbidden_paths": [".env", "node_modules", "logs"],
    "required_skills": ["tdd"],
    "checks": ["npm test"]
  }
}
```

Operational rules:

- Codex defines the task boundary before starting a worker.
- One implementation task should map to one worker job.
- Keep `allowed_dirs` narrow and `forbidden_paths` explicit.
- Let Codex choose `required_skills` when a workflow is useful; omit it otherwise. The worker explicitly invokes, only permits, and stages the listed skills in an isolated directory for `--bare` mode discovery.
- Do not ask for logs, events, or diffs while the job is still running unless you are investigating a specific failure.
- After terminal status, review changed files, policy output, checks, and the relevant diff.
- Treat this MCP as a permission boundary helper, not as an OS or container sandbox.

## Use Cases

Model selection is controlled by CC-Switch routing by default. This MCP leaves `model` unset unless the caller explicitly overrides it.

| `use_case` | Model source | Effort | Async default timeout | Best for |
| --- | --- | --- | --- | --- |
| `auto` | CC-Switch route | `max` | none | general implementation |
| `fast_patch` | CC-Switch route | `high` | 120s | small patches |
| `simple_agent_task` | CC-Switch route | `high` | 180s | simple agentic coding |
| `scaffold_or_tests` | CC-Switch route | `high` | 300s | scaffolding, glue code, tests |
| `debug_loop` | CC-Switch route | `max` | none | reproduce, locate, fix, validate |
| `agentic_coding` | CC-Switch route | `max` | none | multi-step implementation |
| `complex_reasoning` | CC-Switch route | `max` | none | architecture and hard logic |
| `long_context_codebase` | CC-Switch route | `max` | none | broad codebase work |
| `docs_generation` | CC-Switch route | `high` | none | documentation |

## Verification

Offline verification does not call the real model gateway:

```bash
npm run mcp:verify:offline
```

Focused checks:

```bash
npm run mcp:doctor
npm run mcp:smoke:tools
npm run mcp:smoke:permission
npm run mcp:smoke:diagnostics
```

Real worker smoke requires Claude Code and a reachable CC-Switch gateway:

```bash
npm run mcp:smoke
```

## Release Hygiene

Before publishing to GitHub, use a clean copy or the release archive produced from the npm whitelist. Do not upload:

- `node_modules/`
- `mem.md`
- `AGENTS.md`
- `.env` or `.env.*`
- `backup/`
- logs, indexes, caches, bytecode, coverage, build, or dist directories
- local Codex config, secrets, job snapshots, or machine-specific paths

The package whitelist is defined in `package.json` under `files`.

## Status

Current version: `0.4.5-rc.1`.

This project is beta software for developers who are comfortable running local MCP servers and reviewing worker-generated code before accepting it.
