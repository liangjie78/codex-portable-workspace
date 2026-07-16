# CC-Switch Worker MCP

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

CC-Switch Worker MCP is a local MCP server that lets Codex delegate bounded coding work to Claude Code through a local CC-Switch gateway. Codex keeps the supervisor role: it decides the task boundary, starts a worker, reviews the result, and runs final verification.

The goal is to save Codex main-thread context on real engineering tasks. It is not a standalone model client and it does not include model credentials.

## Features

- Starts scoped Claude Code worker jobs from MCP tools.
- Supports async job lifecycle tools: start, get, list, diagnose, tail, wait, and cancel.
- Records compact progress facts such as heartbeat, health state, changed files, checks, and policy results.
- Provides safe-mode permission hooks for bounded read/edit/check workflows.
- Defaults to safe mode, always merges mandatory forbidden paths, and confines Read/Write/Glob/Grep plus tool working directories to the job workspace.
- Applies per-use-case effort and budget defaults, disables inherited ToolSearch unless requested, and records Claude result limit/cost metadata.
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

After moving the source directory or changing a linked installation, run `npm run mcp:setup` and `npm run mcp:doctor` again. Restart the MCP client afterward; already-running server processes keep the code that they loaded at startup.

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
- `--bare` workers receive an isolated generated settings file. Selected skills and settings are removed after the worker exits; the user's full Claude settings and skill directory are not added to the worker scope.
- File and safe read-only Bash hooks resolve existing symlink/junction ancestors before checking `cwd`, `allowed_dirs`, and `forbidden_paths`, so a pre-existing link cannot redirect an approved path outside the workspace.
- Do not ask for logs, events, or diffs while the job is still running unless you are investigating a specific failure.
- After terminal status, review changed files, policy output, checks, and the relevant diff.
- Treat this MCP as a permission boundary helper, not as an OS or container sandbox.

## Use Cases

Model selection is controlled by CC-Switch routing by default. This MCP leaves `model` unset unless the caller explicitly overrides it.

The `model` input is only a selector passed to Claude Code. CC-Switch may route that selector to another provider, so neither `model` nor result-event `models_used` proves the underlying provider model.

| `use_case` | Model source | Effort | Requested budget limit | Async default timeout | Best for |
| --- | --- | --- | --- | --- | --- |
| `auto` | current CC-Switch route | `high` | `$0.50` | none | general implementation |
| `fast_patch` | current CC-Switch route | `low` | `$0.05` | 120s | small patches |
| `simple_agent_task` | current CC-Switch route | `medium` | `$0.10` | 180s | simple agentic coding |
| `scaffold_or_tests` | current CC-Switch route | `medium` | `$0.25` | 300s | scaffolding, glue code, tests |
| `debug_loop` | current CC-Switch route | `max` | `$1.00` | none | reproduce, locate, fix, validate |
| `agentic_coding` | current CC-Switch route | `max` | `$1.00` | none | multi-step implementation |
| `complex_reasoning` | current CC-Switch route | `max` | `$2.00` | none | architecture and hard logic |
| `long_context_codebase` | current CC-Switch route | `max` | `$1.50` | none | broad codebase work |
| `docs_generation` | current CC-Switch route | `low` | `$0.10` | none | documentation |

## Cost and Limit Semantics

- `enable_tool_search` defaults to `false`. The server removes an inherited `ENABLE_TOOL_SEARCH` value unless the caller explicitly enables it.
- `max_budget_usd` is passed to Claude Code as `--max-budget-usd`. Enforcement can happen after a model or tool turn, so `total_cost_usd` can exceed the requested limit. The recorded value is Claude Code result metadata, not a provider invoice.
- Claude Code can execute a tool before it emits `error_max_budget_usd` or `error_max_turns`. Valid file changes in that state are reported as `partial_worker_limit`; a successful read-only tool with no final text gets a specific `*_after_tool_success` failure reason.
- Claude Code `2.1.178` exposes `--max-budget-usd` but not `--max-turns`. This server does not present an ignored `max_turns` input as a reliable guard.
- `partial` is not accepted completion. Review changed files and rerun any missing checks before using the result.

Worker stdout, stderr, and tool-event logs are size-bounded and common credential forms are redacted before persistence. Workspace snapshots skip sensitive and forbidden paths; persisted snapshots contain hashes and metadata, not file bodies. Terminal job directories expire after seven days by default (`CC_SWITCH_WORKER_JOB_TTL_MS` can shorten or extend this). Worker subprocesses inherit only the environment variables required for the runtime, proxy, certificates, and authentication flow.

Redaction and path hooks are defense in depth. Explicit permissive mode, concurrent link replacement, and arbitrary external tools still require a real OS sandbox. Do not place secrets in worker tasks or files.

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
