#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createInterface, emitKeypressEvents } from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DANGEROUS_BASH_DENY_RULES,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_CLAUDE_CC_SWITCH,
  DEFAULT_FAST_PATCH_TIMEOUT_MS,
  DEFAULT_FORBIDDEN_PATHS,
  DEFAULT_FOREGROUND_WAIT_CAP_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_IDLE_AFTER_MS,
  DEFAULT_SCAFFOLD_TIMEOUT_MS,
  DEFAULT_SIMPLE_TASK_TIMEOUT_MS,
  DEFAULT_IGNORED_DIRS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SYNC_TIMEOUT_MS,
  JOB_ROOT,
  JOB_TTL_MS,
  MAX_DIFF_CONTENT_BYTES,
  MAX_DIFF_LINES,
  MAX_FILE_BYTES,
  MAX_OUTPUT_CHARS,
  MAX_STREAM_EVENTS,
  PACKAGE_ROOT,
  SELF_SCRIPT,
  SERVER_VERSION,
  USE_CASES,
  WORKER_PROFILES,
} from "./core/config.mjs";
import {
  claudeResultMetadata,
  classifyClaudeEvent,
  compactClaudeEvent,
  consumeJsonLines,
  phaseFromClaudeEvent,
  summarizeClaudeEvent,
} from "./core/stream-events.mjs";

const jobs = new Map();
const JOB_ID_PATTERN = /^ccsw_[a-z0-9]+_[a-z0-9]{6}$/;
const SUBPROCESS_ENV_ALLOWLIST = new Set([
  "ALL_PROXY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_MODEL", "APPDATA", "CC_SWITCH_API_KEY_FILE", "CC_SWITCH_KEEP_ANTHROPIC_API_KEY",
  "CC_SWITCH_WORKER_SKILLS_ROOT", "CLAUDE_BIN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "ComSpec", "COMSPEC", "DISABLE_AUTO_UPDATE", "HOME", "HOMEDRIVE", "HOMEPATH",
  "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LC_ALL", "LC_CTYPE", "LOCALAPPDATA", "NO_PROXY",
  "NODE_EXTRA_CA_CERTS", "NUMBER_OF_PROCESSORS", "OS", "Path", "PATH", "PATHEXT",
  "ProgramData", "PROGRAMDATA", "ProgramFiles", "PROGRAMFILES", "ProgramFiles(x86)",
  "ProgramW6432", "SHELL", "SSL_CERT_DIR", "SSL_CERT_FILE", "SystemRoot", "SYSTEMROOT",
  "TEMP", "TERM", "TMP", "TMPDIR", "USERPROFILE", "windir", "WINDIR",
  "all_proxy", "http_proxy", "https_proxy", "no_proxy",
]);
const PROCESS_TERMINATION_GRACE_MS = 5000;
const RESTORED_JOB_STALE_AFTER_MS = Math.max(DEFAULT_HEARTBEAT_INTERVAL_MS * 4, 60_000);
let lastJobCleanupAt = 0;
let shuttingDown = false;

const toolOutputSchema = {
  type: "object",
  properties: {
    server_version: { type: "string" },
    status: { type: "string" },
  },
  additionalProperties: true,
};

const tools = [
  {
    name: "cc_switch_implement_in_workspace",
    title: "Run CC-Switch worker synchronously",
    description:
      "Synchronous pure-execution coding worker for tiny edits only. Runs Claude Code through claude-cc-switch in a real workspace, requires real file changes, and returns changed files plus validation status. Prefer cc_switch_start_implementation for normal or long tasks. Use for implementation, not advice.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: implementationSchema({ includeAsync: false }),
    outputSchema: toolOutputSchema,
  },
  {
    name: "cc_switch_start_implementation",
    title: "Start CC-Switch worker job",
    description:
      "Start one async CC-Switch coding worker for one clearly scoped implementation task and return a job_id immediately. Best default: the host agent defines the task boundary, this worker edits/checks files, and the host reviews terminal diff/policy/checks. Do not start a second worker for the same task while the first job is running. If a follow-up worker is needed after terminal status, include the previous job_id, terminal status, failure/check result, and current diff summary in the new task. Do not request logs/events/diffs while running unless debugging. Default auto use_case pins sonnet/high with a bounded API budget; fast_patch pins haiku/low.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: implementationSchema({ includeAsync: true }),
    outputSchema: toolOutputSchema,
  },
  {
    name: "cc_switch_get_job",
    title: "Read CC-Switch worker status",
    description:
      "Read compact status/result for a CC-Switch worker job. By default it returns only short factual state and omits stdout/stderr, stream events, per-file diffs, and tool-call debug details to save host tokens. Use include_* flags only for debugging or final review.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        include_logs: { type: "boolean", description: "Include stdout/stderr tails. Defaults to false to save caller tokens." },
        include_events: { type: "boolean", description: "Include recent stream-json events. Defaults to false." },
        include_diff: { type: "boolean", description: "Include per-file unified diffs from the final result. Defaults to false." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    outputSchema: toolOutputSchema,
  },
  {
    name: "cc_switch_list_jobs",
    title: "List CC-Switch worker jobs",
    description:
      "List recent CC-Switch worker jobs from memory and the persisted job root. This is a read-only diagnostic view for finding stuck, orphaned, partial, failed, or recently completed jobs without knowing a job_id.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum jobs to return. Defaults to 20, capped at 100." },
        status: {
          type: "string",
          enum: ["all", "running", "completed", "partial", "failed", "orphaned", "cancel_requested"],
          description: "Optional status filter. Defaults to all.",
        },
        include_health: { type: "boolean", description: "Include compact health state. Defaults to true." },
      },
      additionalProperties: false,
    },
    outputSchema: toolOutputSchema,
  },
  {
    name: "cc_switch_diagnose_job",
    title: "Diagnose CC-Switch worker job",
    description:
      "Return deterministic local diagnostics for one CC-Switch worker job: health state, likely failure class, permission-denial evidence, timeout facts, and compact inspection targets. Does not run the worker or contact external services.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        include_events: { type: "boolean", description: "Include recent stream and hook summaries. Defaults to false." },
        include_logs: { type: "boolean", description: "Include stdout/stderr tails. Defaults to false." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    outputSchema: toolOutputSchema,
  },
  {
    name: "cc_switch_tail_job",
    title: "Read CC-Switch worker tail",
    description:
      "Return compact running-job progress and files changed so far. Logs/events are opt-in and should stay disabled unless debugging.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        include_logs: { type: "boolean", description: "Include stdout/stderr tails. Defaults to false." },
        include_events: { type: "boolean", description: "Include recent stream-json events. Defaults to false." },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    outputSchema: toolOutputSchema,
  },
  {
    name: "cc_switch_wait_for_job",
    title: "Observe CC-Switch worker job",
    description:
      "Observe a CC-Switch worker job for a short foreground window. Returns completion/partial/failure if done; otherwise returns running compact status. This is not the main polling loop, not a timeout policy, and never cancels or reviews the worker. A worker can stay quiet for long thinking segments.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        max_wait_ms: {
          type: "number",
          description:
            "Caller-requested observation window. This is only a foreground observation helper; it does not control worker lifetime.",
        },
        poll_interval_ms: {
          type: "number",
          description: "Internal observation interval while this tool call is waiting. This does not control the worker lifetime.",
        },
        include_logs: { type: "boolean", description: "Include stdout/stderr tails if the job reaches a terminal state. Defaults to false." },
        include_events: { type: "boolean", description: "Include recent stream-json events. Defaults to false." },
        include_diff: { type: "boolean", description: "Include per-file unified diffs if the job reaches a terminal state. Defaults to false." },
        quiet_with_changes_ms: {
          type: "number",
          description: "Deprecated compatibility field. Ignored.",
        },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    outputSchema: toolOutputSchema,
  },
  {
    name: "cc_switch_cancel_job",
    title: "Cancel CC-Switch worker job",
    description:
      "Request cancellation of a running CC-Switch worker job. Use only when the user asks to stop, the task is obsolete, or continuing is clearly unsafe. Do not cancel merely because the job is quiet or still thinking.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
    outputSchema: toolOutputSchema,
  },
];

if (process.argv.includes("--setup")) {
  runSetup().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
} else if (process.argv.includes("--doctor")) {
  runDoctor().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
} else if (process.argv.includes("--permission-hook")) {
  runPermissionHook().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  runMcpServer().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

function installServerLifecycleHandlers() {
  process.stdin.on("end", () => {
    shutdownServer("stdin_ended", 0);
  });
  process.stdin.on("close", () => {
    shutdownServer("stdin_closed", 0);
  });
  process.on("SIGTERM", () => {
    shutdownServer("sigterm", 0);
  });
  process.on("SIGINT", () => {
    shutdownServer("sigint", 130);
  });
}

function shutdownServer(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const job of jobs.values()) {
    if (!job || !["running", "cancel_requested"].includes(job.status)) continue;
    job.updated_at = new Date().toISOString();
    job.phase = "server_shutdown";
    job.phase_message = `MCP server shutting down: ${reason}`;
    job.last_error_kind = "mcp_server_shutdown";
    if (job.child) {
      job.cancel_requested = true;
      job.status = "cancel_requested";
      terminateChildProcess(job.child);
    } else if (job.restored_from_disk && job.process_pid && processPidAlive(job.process_pid)) {
      job.cancel_requested = true;
      job.status = "cancel_requested";
      try {
        terminateProcessByPid(job.process_pid);
      } catch {
        // Persisted PIDs can disappear between the liveness check and kill.
      }
    }
    writeJobStatus(job);
  }
  process.exitCode = exitCode;
  setTimeout(() => {
    process.exit(exitCode);
  }, PROCESS_TERMINATION_GRACE_MS + 250).unref();
}

function terminateChildProcess(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return false;
  let signaled = false;
  try {
    signaled = child.kill("SIGTERM");
  } catch {
    return false;
  }
  if (!signaled) return false;
  setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child can exit between the state check and the signal.
      }
    }
  }, PROCESS_TERMINATION_GRACE_MS).unref();
  return true;
}

function terminateProcessByPid(pid) {
  if (!pid || !processPidAlive(pid)) return false;
  process.kill(pid, "SIGTERM");
  return true;
}

async function runMcpServer() {
  installServerLifecycleHandlers();
  const server = new McpServer({
    name: "cc-switch-worker-mcp",
    version: SERVER_VERSION,
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: jsonSchemaToZod(tool.inputSchema),
        outputSchema: jsonSchemaToZod(tool.outputSchema),
        annotations: tool.annotations,
      },
      async (args) => {
        try {
          return await callTool({ name: tool.name, arguments: args ?? {} });
        } catch (error) {
          return toolErrorResult(error);
        }
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runDoctor() {
  const checks = [];
  checks.push({
    name: "node_version",
    ok: Number(process.versions.node.split(".")[0]) >= 20,
    detail: process.version,
  });

  const claudeBin = process.env.CLAUDE_CC_SWITCH_BIN || DEFAULT_CLAUDE_CC_SWITCH;
  const resolvedClaudeBin = resolveExecutable(claudeBin);
  checks.push({
    name: "claude_cc_switch",
    ok: Boolean(resolvedClaudeBin),
    detail: resolvedClaudeBin || `not found: ${claudeBin}`,
  });

  const claudeCodeBin = process.env.CLAUDE_BIN || resolveExecutable("claude") || defaultClaudeBin();
  checks.push({
    name: "claude_code_cli",
    ok: Boolean(resolveExecutable(claudeCodeBin)),
    detail: resolveExecutable(claudeCodeBin) || `not found or not executable: ${claudeCodeBin}`,
  });
  const claudeCapabilities = inspectClaudeCliCapabilities(claudeCodeBin);
  checks.push({
    name: "claude_print_limits",
    ok: claudeCapabilities.ok && claudeCapabilities.max_budget_usd,
    detail: `max_budget_usd=${claudeCapabilities.max_budget_usd}; max_turns=${claudeCapabilities.max_turns}; ${claudeCapabilities.detail}`,
  });

  const keyFile = process.env.CC_SWITCH_API_KEY_FILE || resolve(homedir(), ".codex/secrets/cc_switch_api_key");
  const hasToken = Boolean(process.env.ANTHROPIC_AUTH_TOKEN);
  const hasKeyFile = existsSync(keyFile);
  checks.push({
    name: "cc_switch_auth",
    ok: true,
    detail: hasToken
      ? "ANTHROPIC_AUTH_TOKEN is set"
      : hasKeyFile
        ? `key file exists: ${keyFile}`
        : "launcher will default ANTHROPIC_AUTH_TOKEN to PROXY_MANAGED for the local CC-Switch gateway",
  });

  try {
    mkdirSync(JOB_ROOT, { recursive: true });
    accessSync(JOB_ROOT, fsConstants.W_OK);
    checks.push({ name: "job_root_writable", ok: true, detail: JOB_ROOT });
  } catch (error) {
    checks.push({ name: "job_root_writable", ok: false, detail: `${JOB_ROOT}: ${error.message}` });
  }

  const invocation = buildClaudeCcSwitchInvocation({
    prompt: "<doctor-prompt>",
    cwd: process.cwd(),
    permission_mode: "dontAsk",
    model: null,
    reasoning_effort: "high",
    max_budget_usd: 0.05,
    output_format: "stream-json",
    claude_settings_arg: JSON.stringify({ permissions: { defaultMode: "dontAsk" } }),
  });
  checks.push({
    name: "stream_json_args",
    ok: invocation.args.includes("--verbose")
      && invocation.args.includes("--include-partial-messages")
      && invocation.args.includes("--settings")
      && invocation.args.includes("--effort")
      && invocation.args.includes("--max-budget-usd")
      && invocation.args.includes("--input-format")
      && invocation.args.includes("text")
      && invocation.args.includes("--add-dir"),
    detail: previewClaudeArgs(invocation.args, "<doctor-prompt>").join(" "),
  });

  const codexRegistration = inspectCodexRegistration();
  checks.push({
    name: "codex_registration_path",
    ok: codexRegistration.ok,
    detail: codexRegistration.detail,
  });

  const processDrift = inspectCcSwitchMcpProcesses();
  checks.push({
    name: "cc_switch_mcp_processes",
    ok: processDrift.ok,
    detail: processDrift.detail,
  });

  const jobRootSummary = summarizeJobRoot();
  checks.push({
    name: "job_root_summary",
    ok: jobRootSummary.ok,
    detail: jobRootSummary.ok
      ? `${jobRootSummary.total_jobs} jobs; running=${jobRootSummary.status_counts.running ?? 0}; orphaned=${jobRootSummary.status_counts.orphaned ?? 0}; stale_running=${jobRootSummary.stale_running_jobs}; active_duplicate_groups=${jobRootSummary.active_duplicate_groups}`
      : jobRootSummary.error,
  });

  const payload = {
    server_version: SERVER_VERSION,
    ok: checks.every((check) => check.ok),
    checks,
    codex_registration: codexRegistration,
    process_drift: processDrift,
    claude_capabilities: claudeCapabilities,
    job_root_summary: jobRootSummary,
    setup_hint: checks.every((check) => check.ok)
      ? null
      : "Run cc-switch-worker-mcp --setup in a terminal to install/configure Claude Code and verify the local CC-Switch gateway flow.",
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload.ok;
}

function inspectClaudeCliCapabilities(command) {
  const resolved = resolveExecutable(command);
  if (!resolved) return { ok: false, max_budget_usd: false, max_turns: false, detail: "Claude Code CLI not found" };
  const result = spawnSync(resolved, ["--help"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    shell: platform() === "win32",
  });
  const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    ok: result.status === 0,
    max_budget_usd: help.includes("--max-budget-usd"),
    max_turns: help.includes("--max-turns"),
    detail: result.status === 0 ? "capabilities read from claude --help" : (result.error?.message ?? `claude --help exit ${result.status}`),
  };
}

function inspectCodexRegistration() {
  const configPath = resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"), "config.toml");
  const expectedPath = resolve(SELF_SCRIPT);
  if (!existsSync(configPath)) {
    return {
      ok: true,
      config_path: configPath,
      registered_path: null,
      expected_path: expectedPath,
      detail: `Codex config not found; skipped: ${configPath}`,
    };
  }

  const block = tomlSection(readTextIfExists(configPath), "mcp_servers.cc-switch-worker");
  if (!block) {
    return {
      ok: true,
      config_path: configPath,
      registered_path: null,
      expected_path: expectedPath,
      detail: "cc-switch-worker is not registered in Codex config; skipped",
    };
  }

  const registeredPath = ccSwitchScriptFromTomlBlock(block);
  if (!registeredPath) {
    return {
      ok: false,
      config_path: configPath,
      registered_path: null,
      expected_path: expectedPath,
      detail: "cc-switch-worker registration exists but no cc-switch-worker-mcp.mjs arg was found",
    };
  }

  const actualPath = resolve(registeredPath);
  const ok = samePath(actualPath, expectedPath) || isInsidePackage(actualPath);
  return {
    ok,
    config_path: configPath,
    registered_path: actualPath,
    expected_path: expectedPath,
    detail: ok
      ? `registered path matches this server: ${actualPath}`
      : `registered path mismatch: ${actualPath}; expected ${expectedPath}`,
  };
}

function inspectCcSwitchMcpProcesses() {
  const expectedPath = resolve(SELF_SCRIPT);
  if (process.env.CC_SWITCH_WORKER_DOCTOR_ISOLATED === "1") {
    return {
      ok: true,
      expected_path: expectedPath,
      processes: [],
      detail: "process path drift check skipped in isolated CI",
    };
  }
  if (platform() !== "win32") {
    return {
      ok: true,
      expected_path: expectedPath,
      processes: [],
      detail: "process path drift check is only available on Windows; skipped",
    };
  }

  const result = spawnSync("pwsh", [
    "-NoProfile",
    "-Command",
    [
      "$ErrorActionPreference = 'Stop';",
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" |",
      "Where-Object { $_.CommandLine -match 'cc-switch-worker-mcp[\\\\/]src[\\\\/]cc-switch-worker-mcp\\.mjs' } |",
      "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ].join(" "),
  ], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "unknown error").trim();
    return {
      ok: true,
      expected_path: expectedPath,
      processes: [],
      detail: `process path drift check skipped: ${detail}`,
    };
  }

  const rows = parsePowershellJsonRows(result.stdout);
  const processes = rows.map((row) => {
    const scriptPath = ccSwitchScriptFromCommandLine(row.CommandLine ?? "");
    return {
      pid: row.ProcessId ?? null,
      script_path: scriptPath ? resolve(scriptPath) : null,
      matches_this_server: scriptPath ? (samePath(scriptPath, expectedPath) || isInsidePackage(scriptPath)) : false,
    };
  });
  const mismatches = processes.filter((item) => item.script_path && !item.matches_this_server);
  const uniquePaths = new Set(processes.map((item) => item.script_path).filter(Boolean).map(canonicalPathKey));
  return {
    ok: mismatches.length === 0,
    expected_path: expectedPath,
    processes,
    detail: processes.length === 0
      ? "no live cc-switch-worker MCP node processes found"
      : mismatches.length === 0
        ? `${processes.length} live cc-switch-worker MCP process(es), all match this server`
        : `${mismatches.length} live cc-switch-worker MCP process(es) use a different script path; unique_paths=${uniquePaths.size}`,
  };
}

function tomlSection(text, dottedName) {
  const sectionHeader = `[${dottedName}]`;
  const lines = text.split(/\r?\n/);
  let inSection = false;
  const block = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      if (inSection) break;
      inSection = trimmed === sectionHeader;
      continue;
    }
    if (inSection) block.push(line);
  }
  return inSection || block.length > 0 ? block.join("\n") : null;
}

function ccSwitchScriptFromTomlBlock(block) {
  const argsMatch = block.match(/^\s*args\s*=\s*\[([\s\S]*?)\]/m);
  if (!argsMatch) return null;
  for (const match of argsMatch[1].matchAll(/(['"])(.*?)\1/g)) {
    const value = match[2];
    if (/cc-switch-worker-mcp[\\/]src[\\/]cc-switch-worker-mcp\.mjs$/i.test(value)) return value;
  }
  return null;
}

function ccSwitchScriptFromCommandLine(commandLine) {
  const match = commandLine.match(/(?:^|\s)(?:"([^"]*cc-switch-worker-mcp[\\/]src[\\/]cc-switch-worker-mcp\.mjs)"|(\S*cc-switch-worker-mcp[\\/]src[\\/]cc-switch-worker-mcp\.mjs))/i);
  return match?.[1] ?? match?.[2] ?? null;
}

function parsePowershellJsonRows(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function samePath(a, b) {
  return canonicalPathKey(a) === canonicalPathKey(b);
}

function isInsidePackage(path) {
  const rel = relative(PACKAGE_ROOT, resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function canonicalPathKey(path) {
  const resolved = resolve(path);
  return platform() === "win32" ? resolved.toLowerCase() : resolved;
}

async function runSetup() {
  process.stdout.write("CC-Switch Worker MCP setup\n\n");

  const claudeCodeBin = process.env.CLAUDE_BIN || resolveExecutable("claude") || defaultClaudeBin();
  let resolvedClaudeCode = resolveExecutable(claudeCodeBin);
  if (resolvedClaudeCode) {
    process.stdout.write(`Claude Code CLI: ${resolvedClaudeCode}\n`);
  } else {
    process.stdout.write([
      `Claude Code CLI not found: ${claudeCodeBin}`,
      "",
    ].join("\n"));
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stdout.write("Run setup in an interactive terminal to install Claude Code, or set CLAUDE_BIN to the absolute path of the Claude Code executable.\n\n");
    } else {
      const answer = await promptText("Install Claude Code now with `npm install -g @anthropic-ai/claude-code`? [y/N] ");
      if (/^y(es)?$/i.test(answer.trim())) {
        const installed = await installClaudeCode();
        if (!installed) return false;
        resolvedClaudeCode = process.env.CLAUDE_BIN
          ? resolveExecutable(process.env.CLAUDE_BIN)
          : resolveExecutable("claude");
        if (!resolvedClaudeCode) {
          process.stderr.write("Claude Code install finished, but `claude` is still not on PATH. Set CLAUDE_BIN and rerun setup.\n");
          return false;
        }
        process.stdout.write(`Claude Code CLI: ${resolvedClaudeCode}\n`);
      } else {
        process.stdout.write("Skipped Claude Code install. Install it later or set CLAUDE_BIN before running worker jobs.\n");
      }
    }
  }

  const keyFile = process.env.CC_SWITCH_API_KEY_FILE || resolve(homedir(), ".codex/secrets/cc_switch_api_key");
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    process.stdout.write("CC-Switch gateway auth: ANTHROPIC_AUTH_TOKEN is already set in the environment.\n");
  } else if (existsSync(keyFile)) {
    process.stdout.write(`CC-Switch gateway auth: using key file at ${keyFile}.\n`);
  } else {
    process.stdout.write("CC-Switch gateway auth: no token file found; launcher will use PROXY_MANAGED with the default local gateway.\n");
  }
  process.stdout.write("Run cc-switch-worker-mcp --doctor to verify the environment.\n");
  return Boolean(resolvedClaudeCode);
}

async function installClaudeCode() {
  const npmBin = resolveExecutable("npm");
  if (!npmBin) {
    process.stderr.write("npm was not found on PATH, so setup cannot install Claude Code automatically.\n");
    process.stderr.write("Install Node/npm first, then rerun setup.\n");
    return false;
  }

  process.stdout.write("Installing Claude Code with npm install -g @anthropic-ai/claude-code ...\n");
  const npmInvocation = npmInstallInvocation(npmBin);
  const child = spawn(npmInvocation.command, npmInvocation.args, {
    stdio: "inherit",
    env: process.env,
  });

  const exitCode = await new Promise((resolveExit) => {
    child.once("error", (error) => {
      process.stderr.write(`Failed to start npm: ${error.message}\n`);
      resolveExit(1);
    });
    child.once("close", (code) => resolveExit(code ?? 1));
  });

  if (exitCode !== 0) {
    process.stderr.write(`Claude Code install failed with exit code ${exitCode}.\n`);
    return false;
  }
  return true;
}

function npmInstallInvocation(npmBin) {
  if (platform() === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm install -g @anthropic-ai/claude-code"],
    };
  }
  return { command: npmBin, args: ["install", "-g", "@anthropic-ai/claude-code"] };
}

async function callTool(params) {
  cleanupExpiredJobs();
  const name = params.name;
  const args = params.arguments ?? {};

  if (name === "cc_switch_implement_in_workspace") {
    const result = await runImplementation(args, { sync: true });
    return toolResult(result);
  }

  if (name === "cc_switch_start_implementation") {
    const prepared = prepareImplementation(args, { sync: false });
    if (!prepared.args.allow_parallel) {
      const duplicate = findActiveDuplicateJob(prepared);
      if (duplicate) return toolResult(alreadyRunningResult(duplicate, prepared));
    }
    const jobId = `ccsw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const jobDir = resolveJobDirectory(jobId);
    mkdirSync(jobDir, { recursive: true });
    const job = createJob(jobId, jobDir, prepared);
    jobs.set(jobId, job);
    writeJobRestoreData(job);
    writeJobStatus(job);
    runJobInBackground(prepared, job);
    return toolResult(startedJobResult(job, prepared));
  }

  if (name === "cc_switch_get_job") {
    const job = getJob(args.job_id);
    if (!job) {
      return toolResult({ status: "not_found", job_id: args.job_id });
    }
    return toolResult(serializeJob(job, outputOptions(args)));
  }

  if (name === "cc_switch_list_jobs") {
    return toolResult(listJobs(args));
  }

  if (name === "cc_switch_diagnose_job") {
    const job = getJob(args.job_id);
    if (!job) {
      return toolResult({ status: "not_found", job_id: args.job_id });
    }
    return toolResult(diagnoseJob(job, outputOptions(args)));
  }

  if (name === "cc_switch_tail_job") {
    const job = getJob(args.job_id);
    if (!job) {
      return toolResult({ status: "not_found", job_id: args.job_id });
    }
    return toolResult({
      ...progressForJob(job),
      worker: workerStatus(job, outputOptions(args)),
      job_dir: job.job_dir,
    });
  }

  if (name === "cc_switch_wait_for_job") {
    const result = await waitForJob(args);
    return toolResult(result);
  }

  if (name === "cc_switch_cancel_job") {
    const job = getJob(args.job_id);
    if (!job) {
      return toolResult({ status: "not_found", job_id: args.job_id });
    }
    if (job.status !== "running") {
      return toolResult({ status: "not_running", job_id: job.id, current_status: job.status });
    }
    job.cancel_requested = true;
    job.status = "cancel_requested";
    job.updated_at = new Date().toISOString();
    if (job.child) {
      terminateChildProcess(job.child);
    } else if (job.restored_from_disk && job.process_pid && processPidAlive(job.process_pid)) {
      try {
        terminateProcessByPid(job.process_pid);
      } catch (error) {
        job.last_error_kind = "cancel_signal_failed";
        job.error = errorResult(error);
      }
    }
    writeJobStatus(job);
    return toolResult({ status: "cancel_requested", job_id: job.id });
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function runImplementation(rawArgs, options = {}) {
  return runImplementationPrepared(prepareImplementation(rawArgs, options));
}

function getJob(jobId) {
  resolveJobDirectory(jobId);
  const existing = jobs.get(jobId);
  if (existing) return refreshRestoredJobState(existing);
  const restored = restoreJob(jobId);
  if (!restored) return null;
  jobs.set(jobId, restored);
  return restored;
}

function listJobs(args = {}) {
  const limit = Math.min(Math.floor(positiveNumber(args.limit, 20, "limit")), 100);
  const statusFilter = args.status ?? "all";
  if (!["all", "running", "completed", "partial", "failed", "orphaned", "cancel_requested"].includes(statusFilter)) {
    throw new Error("status must be one of: all, running, completed, partial, failed, orphaned, cancel_requested");
  }
  const includeHealth = args.include_health !== false;
  const allIds = allKnownJobIds();
  const items = [];
  for (const id of allIds) {
    const job = jobs.get(id);
    const item = job
      ? compactJobListItem(job, { includeHealth })
      : compactJobListItemFromStatus(id, readJobStatusData(id), { includeHealth });
    if (!item) continue;
    if (statusFilter !== "all" && item.status !== statusFilter) continue;
    items.push(item);
  }
  items.sort((a, b) => parseTimeMs(b.updated_at) - parseTimeMs(a.updated_at));
  return {
    status: "ok",
    job_root: JOB_ROOT,
    total_known_jobs: allIds.length,
    returned: Math.min(items.length, limit),
    filter_status: statusFilter,
    jobs: items.slice(0, limit),
  };
}

function allKnownJobIds() {
  return new Set([...jobs.keys(), ...jobIdsFromDisk()]);
}

function jobIdsFromDisk() {
  try {
    if (!existsSync(JOB_ROOT)) return [];
    return readdirSync(JOB_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidJobId(entry.name))
      .filter((entry) => existsSync(join(resolveJobDirectory(entry.name), "status.json")))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isValidJobId(jobId) {
  return typeof jobId === "string" && JOB_ID_PATTERN.test(jobId);
}

function resolveJobDirectory(jobId) {
  if (!isValidJobId(jobId)) throw new Error("Invalid job_id. Expected a server-generated CC-Switch job identifier.");
  const root = resolve(JOB_ROOT);
  const jobDir = resolve(root, jobId);
  if (jobDir === root || !isInside(root, jobDir)) throw new Error("Invalid job_id path.");
  return jobDir;
}

function cleanupExpiredJobs(now = Date.now()) {
  if (now - lastJobCleanupAt < 60_000) return;
  lastJobCleanupAt = now;
  for (const jobId of jobIdsFromDisk()) {
    const liveJob = jobs.get(jobId);
    if (liveJob && ["running", "cancel_requested"].includes(liveJob.status)) continue;
    const jobDir = resolveJobDirectory(jobId);
    const data = readJobStatusData(jobId);
    if (data && persistedJobCanHaveLiveProcess(data.status) && persistedProcessAlive(data, now)) continue;
    let updatedAt = parseTimeMs(data?.updated_at);
    if (updatedAt == null) {
      try {
        updatedAt = statSync(jobDir).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - updatedAt <= JOB_TTL_MS) continue;
    rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jobs.delete(jobId);
  }
}

function summarizeJobRoot() {
  try {
    const ids = jobIdsFromDisk();
    const statusCounts = {};
    let staleRunningJobs = 0;
    let unreadableJobs = 0;
    const activeByTaskHash = new Map();
    const newestJobs = [];
    for (const id of ids) {
      const data = readJobStatusData(id);
      if (!data) {
        unreadableJobs++;
        statusCounts.unreadable = (statusCounts.unreadable ?? 0) + 1;
        newestJobs.push({ job_id: id, status: "unreadable", updated_at: null });
        continue;
      }
      const processAlive = persistedProcessAlive(data);
      const status = normalizedPersistedJobStatus(data, { processAlive });
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      if (persistedJobCanHaveLiveProcess(data.status) && data.process_pid && !processAlive) {
        staleRunningJobs++;
      }
      if (status === "running" && data.task_hash && data.process_pid && processAlive) {
        const group = activeByTaskHash.get(data.task_hash) ?? [];
        group.push(id);
        activeByTaskHash.set(data.task_hash, group);
      }
      newestJobs.push({
      job_id: id,
        status,
        phase: data.phase ?? null,
        health_state: data.health?.state ?? null,
        updated_at: data.updated_at ?? null,
        started_at: data.started_at ?? null,
        process_pid: data.process_pid ?? null,
      });
    }
    newestJobs.sort((a, b) => parseTimeMs(b.updated_at) - parseTimeMs(a.updated_at));
    const duplicateGroups = [...activeByTaskHash.values()].filter((group) => group.length > 1);
    return {
      ok: true,
      job_root: JOB_ROOT,
      total_jobs: ids.length,
      unreadable_jobs: unreadableJobs,
      stale_running_jobs: staleRunningJobs,
      active_duplicate_groups: duplicateGroups.length,
      active_duplicate_job_ids: duplicateGroups.flat().slice(0, 20),
      status_counts: statusCounts,
      newest_jobs: newestJobs.slice(0, 5),
    };
  } catch (error) {
    return {
      ok: false,
      job_root: JOB_ROOT,
      total_jobs: 0,
      unreadable_jobs: 0,
      stale_running_jobs: 0,
      active_duplicate_groups: 0,
      active_duplicate_job_ids: [],
      status_counts: {},
      newest_jobs: [],
      error: error.message,
    };
  }
}

function readJobStatusData(jobId) {
  try {
    return JSON.parse(readFileSync(join(resolveJobDirectory(jobId), "status.json"), "utf8"));
  } catch {
    return null;
  }
}

function findActiveDuplicateJob(prepared) {
  if (!prepared?.task_hash) return null;
  for (const id of allKnownJobIds()) {
    const job = getJob(id);
    if (!job || !["running", "cancel_requested"].includes(job.status)) continue;
    if (job.restored_from_disk && !job.process_alive) continue;
    if (job.task_hash !== prepared.task_hash) continue;
    return job;
  }
  return null;
}

function alreadyRunningResult(job, prepared) {
  const progress = progressForJob(job);
  const worker = workerStatus(job, {});
  return {
    status: "already_running",
    job_id: job.id,
    existing_job_id: job.id,
    task_hash: prepared.task_hash,
    message: "An active CC-Switch worker job with the same cwd, task, allowed paths, forbidden paths, checks, required skills, use_case, and worker_profile is already running. Pass allow_parallel=true only when you intentionally want duplicate parallel execution.",
    progress,
    diagnosis: buildJobDiagnosis(job, progress, worker),
    job_dir: job.job_dir,
  };
}

function compactJobListItem(job, { includeHealth = true } = {}) {
  refreshRestoredJobState(job);
  const idle = idleStatus(job);
  const health = includeHealth ? healthForJob(job, idle) : null;
  const result = job.result ?? {};
  return {
    job_id: job.id,
    status: job.status,
    phase: job.phase ?? null,
    health_state: health?.state ?? null,
    started_at: job.started_at,
    updated_at: job.persisted_updated_at ?? job.updated_at,
    restored_at: job.restored_from_disk ? job.updated_at : null,
    elapsed_ms: Date.now() - job.started_ms,
    cwd: job.cwd,
    use_case: job.use_case,
    worker_profile: job.worker_profile,
    task_hash: job.task_hash ?? null,
    timeout_ms: job.timeout_ms ?? null,
    timeout_source: job.timeout_source ?? null,
    model: job.model ?? null,
    reasoning_effort: job.reasoning_effort ?? null,
    max_budget_usd: job.max_budget_usd ?? null,
    total_cost_usd: result.worker?.total_cost_usd ?? job.claude_result?.total_cost_usd ?? null,
    process_alive: Boolean(job.process_alive),
    process_pid: job.process_pid ?? null,
    restored_from_disk: Boolean(job.restored_from_disk),
    change_count: result.change_count ?? arrayOfStrings(result.files_changed).length,
    failure_reason: result.failure_reason ?? null,
    last_error_kind: job.last_error_kind ?? null,
    last_event_summary: job.last_event_summary ?? null,
    permission_denials: includeHealth ? (health?.permission_denials ?? 0) : undefined,
  };
}

function compactJobListItemFromStatus(jobId, data, { includeHealth = true } = {}) {
  if (!data || typeof data !== "object") {
    return {
      job_id: jobId,
      status: "unreadable",
      phase: null,
      health_state: null,
      started_at: null,
      updated_at: null,
      restored_at: null,
      elapsed_ms: null,
      cwd: null,
      use_case: null,
      worker_profile: null,
      task_hash: null,
      timeout_ms: null,
      timeout_source: null,
      process_alive: false,
      process_pid: null,
      restored_from_disk: true,
      change_count: 0,
      failure_reason: null,
      last_error_kind: "status_unreadable",
      last_event_summary: null,
      permission_denials: includeHealth ? 0 : undefined,
    };
  }
  const processAlive = persistedProcessAlive(data);
  const status = normalizedPersistedJobStatus(data, { processAlive });
  const changed = data.result?.change_count ?? arrayOfStrings(data.result?.files_changed).length;
  return {
    job_id: jobId,
    status,
    phase: status === "orphaned" ? "orphaned" : (data.phase ?? null),
    health_state: status === "orphaned" ? "orphaned_after_restart" : (data.health?.state ?? null),
    started_at: data.started_at ?? null,
    updated_at: data.updated_at ?? null,
    restored_at: null,
    elapsed_ms: data.elapsed_ms ?? null,
    cwd: data.cwd ?? null,
    use_case: data.use_case ?? null,
    worker_profile: data.worker_profile ?? null,
    task_hash: data.task_hash ?? null,
    timeout_ms: data.timeout_ms ?? null,
    timeout_source: data.timeout_source ?? null,
    model: data.model ?? null,
    reasoning_effort: data.reasoning_effort ?? null,
    max_budget_usd: data.max_budget_usd ?? null,
    total_cost_usd: data.result?.worker?.total_cost_usd ?? data.claude_result?.total_cost_usd ?? null,
    process_alive: Boolean(processAlive),
    process_pid: processAlive ? data.process_pid : null,
    restored_from_disk: true,
    change_count: changed,
    failure_reason: data.result?.failure_reason ?? null,
    last_error_kind: status === "orphaned" ? "orphaned_after_mcp_restart" : (data.last_error_kind ?? null),
    last_event_summary: data.last_event_summary ?? null,
    permission_denials: includeHealth ? (data.health?.permission_denials ?? null) : undefined,
  };
}

function normalizedPersistedJobStatus(data, { processAlive = false } = {}) {
  if (persistedJobCanHaveLiveProcess(data?.status) && !processAlive) return "orphaned";
  const resultStatus = data?.result?.status;
  if (typeof resultStatus === "string" && resultStatus.startsWith("partial_")) return "partial";
  const failureReason = data?.result?.failure_reason;
  if (failureReason === "caller_timeout_after_valid_changes" || failureReason === "cancelled_after_valid_changes") {
    return "partial";
  }
  return data?.status ?? "unknown";
}

function persistedJobCanHaveLiveProcess(status) {
  return status === "running" || status === "cancel_requested";
}

function persistedProcessAlive(data, now = Date.now()) {
  if (!persistedJobCanHaveLiveProcess(data?.status) || !data.process_pid || !processPidAlive(data.process_pid)) {
    return false;
  }
  const heartbeatMs = data.last_heartbeat_at_ms != null && Number.isFinite(Number(data.last_heartbeat_at_ms))
    ? Number(data.last_heartbeat_at_ms)
    : parseTimeMs(data.last_heartbeat_at ?? data.persisted_updated_at ?? data.updated_at);
  return heartbeatMs != null && now - heartbeatMs <= RESTORED_JOB_STALE_AFTER_MS;
}

function diagnoseJob(job, options = {}) {
  const progress = progressForJob(job);
  const worker = workerStatus(job, options);
  const diagnosis = buildJobDiagnosis(job, progress, worker);
  return {
    status: "ok",
    job_id: job.id,
    job_status: job.status,
    diagnosis,
    progress,
    worker,
    result: resultForOutput(job.result, options),
    error: errorForOutput(job.error, options),
    job_dir: job.job_dir,
  };
}

function buildJobDiagnosis(job, progress, worker) {
  const findings = [];
  const health = progress.health ?? {};
  const policy = progress.policy_so_far ?? job.result?.policy ?? null;
  const permissionDenials = worker.tool_activity?.permission_denials ?? 0;

  if (job.status === "orphaned") {
    addFinding(findings, "error", "orphaned_after_restart", "The persisted job was active, but its recorded worker process is no longer alive.", {
      process_pid: job.process_pid ?? null,
      restored_from_disk: Boolean(job.restored_from_disk),
    });
  }
  if (job.status === "running" && !job.process_alive) {
    addFinding(findings, "error", "running_without_process", "The job is marked running, but no live worker process is attached.", {
      process_pid: job.process_pid ?? null,
    });
  }
  if (health.state === "waiting_for_first_output") {
    addFinding(findings, "warning", "waiting_for_first_output", "The worker process is alive but has not emitted stdout/stderr or stream-json events yet.", {
      idle_seconds: progress.idle_seconds,
      heartbeat_count: health.heartbeat_count,
    });
  }
  if (health.state === "api_retry_quiet") {
    addFinding(findings, "warning", "api_retry_quiet", "The latest stream evidence looks like an API retry and the job has been quiet past the idle threshold.", {
      last_event_summary: job.last_event_summary ?? null,
    });
  }
  if (health.state === "pending_tool_quiet") {
    addFinding(findings, "warning", "pending_tool_quiet", "Claude Code appears to have started a tool call and has not produced an inferred tool result yet.", {
      pending_tool_use: health.pending_tool_use,
      pending_tool_duration_ms: health.pending_tool_duration_ms,
    });
  }
  if (health.state === "possible_permission_block") {
    addFinding(findings, "warning", "possible_permission_block", "A permission denial was logged and the job has been quiet past the idle threshold.", {
      last_permission_denial: health.last_permission_denial,
    });
  }
  if (health.timeout_elapsed) {
    addFinding(findings, "error", "timeout_elapsed", "The configured worker timeout has elapsed or fired.", {
      timeout_ms: health.timeout_ms,
      timeout_source: health.timeout_source,
      timeout_deadline_at: health.timeout_deadline_at,
    });
  }
  if (heartbeatStale(job, health)) {
    addFinding(findings, "warning", "heartbeat_stale", "The MCP heartbeat for this running job is older than expected.", {
      heartbeat_age_ms: health.heartbeat_age_ms,
      heartbeat_interval_ms: DEFAULT_HEARTBEAT_INTERVAL_MS,
    });
  }
  if (permissionDenials > 0) {
    addFinding(findings, "info", "permission_denials_logged", "The permission hook logged one or more deny decisions.", {
      permission_denials: permissionDenials,
      last_permission_denial: worker.tool_activity?.last_permission_denial ?? null,
    });
  }
  if (job.result?.failure_reason) {
    addFinding(findings, "error", job.result.failure_reason, "The terminal worker result recorded a failure reason.", {
      failure_reason: job.result.failure_reason,
      result_status: job.result.status ?? null,
    });
  }
  if (policy?.forbidden_changed?.length > 0) {
    addFinding(findings, "error", "forbidden_paths_changed", "The job touched paths that are forbidden by policy.", {
      forbidden_changed: policy.forbidden_changed,
    });
  }
  if (policy?.outside_allowed?.length > 0) {
    addFinding(findings, "error", "outside_allowed_dirs_changed", "The job touched paths outside allowed_dirs.", {
      outside_allowed: policy.outside_allowed,
    });
  }
  if (job.last_error_kind) {
    addFinding(findings, job.last_error_kind === "process_spawn_error" ? "error" : "info", job.last_error_kind, "The job recorded a last_error_kind value.", {
      last_error_kind: job.last_error_kind,
    });
  }
  if (findings.length === 0) {
    addFinding(findings, "info", "no_local_issue_detected", "No local MCP-level problem is visible from the persisted status, health, policy, and hook summaries.", {});
  }
  findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return {
    summary: findings[0]?.message ?? null,
    highest_severity: findings[0]?.severity ?? "info",
    health_state: health.state ?? null,
    findings,
    inspection_targets: inspectionTargetsForFindings(findings),
  };
}

function addFinding(findings, severity, code, message, evidence) {
  findings.push({ severity, code, message, evidence });
}

function severityRank(severity) {
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  if (severity === "info") return 1;
  return 0;
}

function heartbeatStale(job, health) {
  if (job.status !== "running" || !job.process_alive) return false;
  if (typeof health.heartbeat_age_ms !== "number") return false;
  return health.heartbeat_age_ms > DEFAULT_HEARTBEAT_INTERVAL_MS * 4;
}

function inspectionTargetsForFindings(findings) {
  const codes = new Set(findings.map((finding) => finding.code));
  const targets = [];
  if (codes.has("permission_denials_logged") || codes.has("possible_permission_block")) {
    targets.push("cc_switch_diagnose_job include_events=true shows compact hook entries from tool-events.jsonl");
  }
  if (codes.has("waiting_for_first_output") || codes.has("api_retry_quiet") || codes.has("process_spawn_error")) {
    targets.push("cc_switch_diagnose_job include_logs=true shows stdout/stderr tails without per-file diffs");
  }
  if (codes.has("forbidden_paths_changed") || codes.has("outside_allowed_dirs_changed") || codes.has("no_code_changed") || codes.has("checks_failed")) {
    targets.push("cc_switch_get_job include_diff=true is useful only after terminal status for review");
  }
  if (targets.length === 0) targets.push("default compact status is sufficient for this local diagnosis");
  return targets;
}

function restoreJob(jobId) {
  const jobDir = resolveJobDirectory(jobId);
  const statusPath = join(jobDir, "status.json");
  if (!existsSync(statusPath)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch (error) {
    return {
      id: jobId,
      status: "failed",
      started_at: null,
      started_ms: Date.now(),
      updated_at: new Date().toISOString(),
      phase: "restore_failed",
      phase_message: "Persisted job status could not be parsed.",
      job_dir: jobDir,
      stdout: readTextIfExists(join(jobDir, "stdout.log")),
      stderr: readTextIfExists(join(jobDir, "stderr.log")),
      child: null,
      process_alive: false,
      process_pid: null,
      restored_from_disk: true,
      restore_error: error.message,
      error: errorResult(error),
    };
  }

  const processAlive = persistedProcessAlive(data);
  const orphaned = persistedJobCanHaveLiveProcess(data.status) && !processAlive;
  const restoredStatus = normalizedPersistedJobStatus(data, { processAlive });
  const job = {
    id: jobId,
    status: restoredStatus,
    started_at: data.started_at ?? null,
    started_ms: restoreStartedMs(data),
    persisted_updated_at: data.updated_at ?? null,
    updated_at: new Date().toISOString(),
    cwd: data.cwd ?? null,
    before: null,
    ignored_dirs: new Set([...DEFAULT_IGNORED_DIRS, ...arrayOfStrings(data.ignored_dirs)]),
    allowedRoots: arrayOfStrings(data.allowedRoots).length > 0
      ? arrayOfStrings(data.allowedRoots)
      : (data.cwd ? [data.cwd] : []),
    forbiddenPaths: arrayOfStrings(data.forbiddenPaths),
    checks: arrayOfStrings(data.checks),
    required_skills: arrayOfStrings(data.required_skills),
    allow_docs_only: Boolean(data.allow_docs_only),
    use_case: data.use_case ?? null,
    worker_profile: data.worker_profile ?? null,
    model: data.model ?? null,
    thinking: data.thinking ?? null,
    reasoning_effort: data.reasoning_effort ?? null,
    max_budget_usd: data.max_budget_usd ?? null,
    budget_source: data.budget_source ?? null,
    enable_tool_search: Boolean(data.enable_tool_search),
    preset_requires_review: Boolean(data.preset_requires_review),
    verification_profile: data.verification_profile ?? null,
    permission_mode: data.permission_mode ?? null,
    safety_mode: data.safety_mode ?? "safe",
    timeout_ms: data.timeout_ms ?? null,
    timeout_source: data.timeout_source ?? null,
    process_started_at_ms: data.process_started_at_ms ?? null,
    process_started_at: data.process_started_at ?? null,
    timeout_deadline_at_ms: data.timeout_deadline_at_ms ?? null,
    timeout_deadline_at: data.timeout_deadline_at ?? null,
    timeout_fired_at: data.timeout_fired_at ?? null,
    last_heartbeat_at_ms: data.last_heartbeat_at_ms ?? null,
    last_heartbeat_at: data.last_heartbeat_at ?? null,
    heartbeat_count: data.heartbeat_count ?? 0,
    task_hash: data.task_hash ?? null,
    allow_parallel: Boolean(data.allow_parallel),
    claude_settings_active: Boolean(data.claude_settings_active),
    claude_settings_path: data.claude_settings_path ?? null,
    phase: orphaned ? "orphaned" : (data.phase ?? restoredStatus ?? "restored"),
    phase_message: orphaned
      ? "MCP restored this job from disk, but the recorded worker process is no longer alive. Treat artifacts as review-only."
      : (data.phase_message ?? "MCP restored this job from disk."),
    last_output_at_ms: data.last_output_at_ms ?? parseTimeMs(data.last_output_at),
    last_output_at: data.last_output_at ?? null,
    idle_after_ms: data.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS,
    job_dir: jobDir,
    stdout: readTextIfExists(join(jobDir, "stdout.log")),
    stderr: readTextIfExists(join(jobDir, "stderr.log")),
    child: null,
    process_alive: processAlive,
    process_pid: processAlive ? data.process_pid : null,
    output_format: data.output_format ?? null,
    claude_args_preview: data.claude_args_preview ?? null,
    stream_events: Array.isArray(data.recent_events) ? data.recent_events : [],
    last_event_at_ms: data.last_event_at_ms ?? parseTimeMs(data.last_event_at),
    last_event_at: data.last_event_at ?? null,
    last_event_type: data.last_event_type ?? null,
    last_event_summary: data.last_event_summary ?? null,
    last_stream_kind: data.last_stream_kind ?? null,
    pending_tool_use: data.pending_tool_use ?? null,
    streaming_tool_input: data.streaming_tool_input ?? null,
    last_tool_input_at: data.last_tool_input_at ?? null,
    last_tool_input_completed_at: data.last_tool_input_completed_at ?? null,
    last_tool_result_inferred: Boolean(data.last_tool_result_inferred),
    last_tool_use_at: data.last_tool_use_at ?? null,
    last_tool_result_at: data.last_tool_result_at ?? null,
    last_tool_name: data.last_tool_name ?? null,
    last_successful_tool: data.last_successful_tool ?? null,
    successful_tool_count: data.successful_tool_count ?? 0,
    last_failed_tool: data.last_failed_tool ?? null,
    claude_result: data.claude_result ?? null,
    last_error_kind: orphaned ? "orphaned_after_mcp_restart" : (data.last_error_kind ?? null),
    tool_calls_since_last_change: data.tool_calls_since_last_change ?? 0,
    last_observed_change_count: data.last_observed_change_count ?? 0,
    cancel_requested: Boolean(data.cancel_requested),
    result: data.result ?? null,
    error: orphaned
      ? { message: "Worker process was not recoverable after MCP restart.", data: null }
      : (data.error ?? null),
    restored_from_disk: true,
  };
  if (orphaned) writeJobStatus(job);
  return job;
}

function refreshRestoredJobState(job) {
  if (!job?.restored_from_disk || !persistedJobCanHaveLiveProcess(job.status)) return job;
  const processAlive = persistedProcessAlive(job);
  job.process_alive = processAlive;
  if (processAlive) return job;

  job.status = "orphaned";
  job.phase = "orphaned";
  job.phase_message = "MCP restored this job from disk, but the recorded worker process is no longer alive. Treat artifacts as review-only.";
  job.last_error_kind = "orphaned_after_mcp_restart";
  job.error = { message: "Worker process was not recoverable after MCP restart.", data: null };
  job.process_pid = null;
  job.updated_at = new Date().toISOString();
  writeJobStatus(job);
  return job;
}

function createJob(jobId, jobDir, prepared) {
  const now = new Date().toISOString();
  return {
    id: jobId,
    status: "running",
    started_at: now,
    started_ms: Date.now(),
    persisted_updated_at: null,
    updated_at: now,
    cwd: prepared.cwd,
    before: prepared.before,
    ignored_dirs: prepared.args.ignored_dirs,
    allowedRoots: prepared.allowedRoots,
    forbiddenPaths: prepared.forbiddenPaths,
    checks: prepared.args.checks,
    required_skills: prepared.args.required_skills,
    allow_docs_only: prepared.args.allow_docs_only,
    use_case: prepared.args.use_case,
    worker_profile: prepared.args.worker_profile,
    model: prepared.args.model,
    thinking: prepared.args.thinking,
    reasoning_effort: prepared.args.reasoning_effort,
    max_budget_usd: prepared.args.max_budget_usd,
    budget_source: prepared.args.budget_source,
    enable_tool_search: prepared.args.enable_tool_search,
    preset_requires_review: prepared.args.preset_requires_review,
    verification_profile: prepared.args.verification_profile,
    permission_mode: prepared.args.permission_mode,
    safety_mode: prepared.args.safety_mode,
    timeout_ms: prepared.args.timeout_ms,
    timeout_source: prepared.args.timeout_source,
    process_started_at_ms: null,
    process_started_at: null,
    timeout_deadline_at_ms: null,
    timeout_deadline_at: null,
    timeout_fired_at: null,
    last_heartbeat_at_ms: null,
    last_heartbeat_at: null,
    heartbeat_count: 0,
    task_hash: prepared.task_hash,
    allow_parallel: prepared.args.allow_parallel,
    claude_settings_active: Boolean(prepared.claudeSettings),
    claude_settings_path: null,
    phase: "queued",
    phase_message: "Worker job accepted and waiting to start.",
    last_output_at_ms: null,
    last_output_at: null,
    idle_after_ms: prepared.args.idle_after_ms,
    job_dir: jobDir,
    stdout: "",
    stderr: "",
    child: null,
    process_alive: false,
    process_pid: null,
    output_format: prepared.args.output_format,
    claude_args_preview: previewClaudeArgs(buildClaudeCcSwitchInvocation({
      prompt: "<worker-prompt>",
      cwd: prepared.cwd,
      permission_mode: prepared.args.permission_mode,
      model: prepared.args.model,
      reasoning_effort: prepared.args.reasoning_effort,
      max_budget_usd: prepared.args.max_budget_usd,
      output_format: prepared.args.output_format,
      claude_settings_arg: prepared.claudeSettings ? "<claude-settings>" : null,
    }).args),
    stream_events: [],
    last_event_at_ms: null,
    last_event_at: null,
    last_event_type: null,
    last_event_summary: null,
    last_stream_kind: null,
    pending_tool_use: null,
    streaming_tool_input: null,
    last_tool_input_at: null,
    last_tool_input_completed_at: null,
    last_tool_result_inferred: false,
    last_tool_use_at: null,
    last_tool_result_at: null,
    last_tool_name: null,
    last_successful_tool: null,
    successful_tool_count: 0,
    last_failed_tool: null,
    claude_result: null,
    last_error_kind: null,
    tool_calls_since_last_change: 0,
    last_observed_change_count: 0,
    cancel_requested: false,
    result: null,
    error: null,
  };
}

function runJobInBackground(prepared, job) {
  runImplementationPrepared(prepared, job)
    .then((result) => {
      job.status = terminalJobStatus(result.status);
      job.result = result;
      finishJobProcess(job);
    })
    .catch((error) => {
      job.status = "failed";
      job.error = errorResult(error);
      finishJobProcess(job);
    });
}

function finishJobProcess(job) {
  job.updated_at = new Date().toISOString();
  job.child = null;
  job.process_alive = false;
  writeJobStatus(job);
}

function startedJobResult(job, prepared) {
  return {
    status: "started",
    job_id: job.id,
    started_at: job.started_at,
    job_dir: job.job_dir,
    use_case: job.use_case,
    worker_profile: job.worker_profile,
    model: job.model,
    thinking: job.thinking,
    reasoning_effort: job.reasoning_effort,
    max_budget_usd: job.max_budget_usd,
    budget_source: job.budget_source,
    enable_tool_search: job.enable_tool_search,
    preset_requires_review: job.preset_requires_review,
    verification_profile: job.verification_profile,
    permission_mode: job.permission_mode,
    safety_mode: job.safety_mode,
    timeout_ms: job.timeout_ms,
    timeout_source: job.timeout_source,
    timeout_deadline_at: job.timeout_deadline_at,
    task_hash: job.task_hash,
    allow_parallel: Boolean(job.allow_parallel),
    required_skills: job.required_skills,
    claude_settings_active: Boolean(job.claude_settings_active),
    claude_settings_path: job.claude_settings_path ?? null,
    phase: job.phase,
    phase_message: job.phase_message,
    output_format: job.output_format,
  };
}

function prepareImplementation(rawArgs, options = {}) {
  const args = normalizeArgs(rawArgs, options);
  const cwd = assertInside(resolve(args.cwd), resolve(args.cwd), "cwd");
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }

  const allowedRoots = normalizeRoots(cwd, args.allowed_dirs);
  const forbiddenPaths = normalizeForbidden(cwd, args.forbidden_paths);
  const before = snapshotWorkspace(cwd, args.ignored_dirs, forbiddenPaths);

  const workerPrompt = buildWorkerPrompt(args, allowedRoots, forbiddenPaths);
  const claudeSettings = buildClaudeSettings(args, cwd);
  const task_hash = taskFingerprint({ args, cwd, allowedRoots, forbiddenPaths });
  return { args, cwd, allowedRoots, forbiddenPaths, before, workerPrompt, claudeSettings, task_hash };
}

function taskFingerprint({ args, cwd, allowedRoots, forbiddenPaths }) {
  const payload = {
    cwd: normalizeFingerprintPath(cwd),
    task: args.task.trim(),
    allowed_roots: allowedRoots.map(normalizeFingerprintPath).sort(),
    forbidden_paths: forbiddenPaths.map(normalizeFingerprintPath).sort(),
    checks: [...args.checks].sort(),
    required_skills: [...args.required_skills].sort(),
    use_case: args.use_case,
    worker_profile: args.worker_profile,
    model: args.model,
    thinking: args.thinking,
    reasoning_effort: args.reasoning_effort,
    max_budget_usd: args.max_budget_usd,
    enable_tool_search: args.enable_tool_search,
    permission_mode: args.permission_mode,
    safety_mode: args.safety_mode,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

function normalizeFingerprintPath(path) {
  const resolved = resolve(path);
  return platform() === "win32" ? resolved.toLowerCase() : resolved;
}

async function runImplementationPrepared(prepared, job = null) {
  const { args, cwd, allowedRoots, forbiddenPaths, before, workerPrompt, claudeSettings } = prepared;
  setJobPhase(job, "model_running", modelRunningMessage(args));
  const worker = await runClaudeCcSwitch({
    cwd,
    prompt: workerPrompt,
    timeout_ms: args.timeout_ms,
    claude_cc_switch_bin: args.claude_cc_switch_bin,
    permission_mode: args.permission_mode,
    model: args.model,
    reasoning_effort: args.reasoning_effort,
    thinking: args.thinking,
    max_budget_usd: args.max_budget_usd,
    enable_tool_search: args.enable_tool_search,
    output_format: args.output_format,
    claude_settings: claudeSettings,
    required_skills: args.required_skills,
    job,
  });

  setJobPhase(job, "snapshotting", "Worker finished model execution; scanning workspace changes.");
  const after = snapshotWorkspace(cwd, args.ignored_dirs, forbiddenPaths);
  const changes = diffSnapshots(before, after);
  const changedFiles = changes.map((change) => change.path).sort();
  const policy = evaluatePolicy({
    cwd,
    changedFiles,
    allowedRoots,
    forbiddenPaths,
    allow_docs_only: args.allow_docs_only,
  });

  const checks = [];
  if (changedFiles.length > 0 && policy.ok && args.checks.length > 0) {
    setJobPhase(job, "checking", "Workspace changed; running requested validation checks.");
    for (const check of args.checks) {
      checks.push(await runCheck(cwd, check, args.check_timeout_ms));
    }
  }

  const checkFailures = checks.filter((check) => check.exit_code !== 0 || check.timed_out);
  const gitInfo = await gitSummary(cwd);
  const outcome = classifyOutcome({ changedFiles, policy, checkFailures, worker, presetRequiresReview: args.preset_requires_review });
  setJobPhase(job, terminalJobStatus(outcome.status), outcome.status === "changed_files"
    ? "Worker completed with accepted file changes."
    : outcome.status === "partial_caller_timeout"
      ? "Caller timeout stopped the worker after it produced policy-compliant changes. Treat as partial and review before trusting."
      : outcome.status === "partial_cancelled"
        ? "Cancellation stopped the worker after it produced policy-compliant changes. Treat as partial and review before trusting."
        : outcome.status === "partial_worker_limit"
          ? "Claude Code reached a budget or turn limit after valid changes. Treat as partial and review tool side effects before trusting."
          : "Worker finished, but the success contract was not satisfied.");

  const { fileDiffs, diffAvailable } = computeFileDiffs(before, after, changes);
  const reviewSummary = buildReviewSummary({
    changedFiles,
    diffAvailable,
    policy,
    checks,
    failureReason: outcome.failure_reason,
    requiresReview: outcome.requires_review,
    job,
  });

  return {
    status: outcome.status,
    cwd,
    files_changed: changedFiles,
    change_count: changedFiles.length,
    file_diffs: fileDiffs,
    diff_available: diffAvailable,
    policy,
    partial: outcome.partial,
    requires_review: outcome.requires_review,
    review_hint: outcome.review_hint,
    review_summary: reviewSummary,
    use_case: args.use_case,
    worker_profile: args.worker_profile,
    model: args.model,
    thinking: args.thinking,
    reasoning_effort: args.reasoning_effort,
    max_budget_usd: args.max_budget_usd,
    budget_source: args.budget_source,
    enable_tool_search: args.enable_tool_search,
    preset_requires_review: args.preset_requires_review,
    verification_profile: args.verification_profile,
    required_skills: args.required_skills,
    permission_mode: args.permission_mode,
    safety_mode: args.safety_mode,
    timeout_ms: args.timeout_ms,
    timeout_source: args.timeout_source,
    claude_settings_active: Boolean(claudeSettings),
    output_format: args.output_format,
    checks_run: checks,
    worker: {
      exit_code: worker.exit_code,
      signal: worker.signal,
      timed_out: worker.timed_out,
      cancelled: worker.cancelled,
      spawn_error: worker.spawn_error,
      claude_args_preview: worker.claude_args_preview,
      output_format: worker.output_format,
      events_seen: worker.events_seen,
      last_event_type: worker.last_event_type,
      last_event_summary: worker.last_event_summary,
      final_result_subtype: worker.claude_result?.subtype ?? null,
      final_result_is_error: worker.claude_result?.is_error ?? null,
      final_text_present: worker.claude_result?.final_text_present ?? null,
      limit_reason: worker.claude_result?.limit_reason ?? null,
      total_cost_usd: worker.claude_result?.total_cost_usd ?? null,
      num_turns: worker.claude_result?.num_turns ?? null,
      models_used: worker.claude_result?.models_used ?? [],
      successful_tool_count: worker.successful_tool_count ?? 0,
      last_successful_tool: worker.last_successful_tool ?? null,
      stdout_tail: tail(worker.stdout),
      stderr_tail: tail(worker.stderr),
    },
    git: gitInfo,
    failure_reason: outcome.failure_reason,
    completed_at: new Date().toISOString(),
  };
}

function normalizeArgs(args, options = {}) {
  if (!args.cwd || typeof args.cwd !== "string") {
    throw new Error("cwd is required");
  }
  if (!args.task || typeof args.task !== "string" || args.task.trim().length === 0) {
    throw new Error("task is required");
  }
  const task = args.task.trim();
  const useCase = normalizeUseCase(args.use_case);
  const preset = USE_CASES[useCase];
  const worker_profile = normalizeWorkerProfile(args.worker_profile);
  const profile = WORKER_PROFILES[worker_profile];
  const model = typeof args.model === "string" && args.model.length > 0
    ? args.model
    : preset.model;
  const thinking = normalizeThinking(args.thinking ?? preset.thinking);
  const reasoning_effort = normalizeReasoningEffort(args.reasoning_effort ?? preset.reasoning_effort);
  const max_budget_usd = normalizeOptionalNumber(
    args.max_budget_usd,
    preset.max_budget_usd ?? null,
    "max_budget_usd",
  );
  const budget_source = args.max_budget_usd != null
    ? "caller"
    : max_budget_usd == null
      ? "none"
      : `use_case:${useCase}`;
  const enable_tool_search = Boolean(args.enable_tool_search ?? false);
  const output_format = normalizeOutputFormat(args.output_format ?? preset.output_format);
  const verification_profile = normalizeVerificationProfile(args.verification_profile ?? preset.verification_profile);
  const allow_docs_only = Boolean(args.allow_docs_only ?? preset.allow_docs_only ?? false);
  const allow_parallel = Boolean(args.allow_parallel ?? false);
  const preset_requires_review = Boolean(preset.requires_review ?? false);
  const timeoutDefault = options.sync
    ? DEFAULT_SYNC_TIMEOUT_MS
    : preset.default_timeout_ms ?? null;
  const timeout_ms = normalizeOptionalNumber(
    args.timeout_ms,
    timeoutDefault
  );
  const timeout_source = args.timeout_ms != null
    ? "caller"
    : options.sync
      ? "sync_default"
      : timeoutDefault == null
        ? "none"
        : `use_case:${useCase}`;
  const idle_after_ms = positiveNumber(
    args.idle_after_ms,
    preset.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS,
    "idle_after_ms"
  );
  const allowed_dirs = arrayOfStrings(args.allowed_dirs);
  const forbidden_paths = [...new Set([...DEFAULT_FORBIDDEN_PATHS, ...arrayOfStrings(args.forbidden_paths)])];
  const permission_mode = args.permission_mode || profile.permission_mode;
  const safety_mode = normalizeSafetyMode(args.safety_mode);
  const required_skills = normalizeRequiredSkills(args.required_skills);

  if (permission_mode === "bypassPermissions" && worker_profile !== "scoped_patch") {
    throw new Error("permission_mode bypassPermissions requires worker_profile: scoped_patch.");
  }
  if (permission_mode === "bypassPermissions") {
    throw new Error("bypassPermissions is disabled by this MCP build; use worker_profile scoped_patch with dontAsk policy settings, or run in a real sandbox before re-enabling it.");
  }
  if (profile.requires_allowed_dirs && allowed_dirs.length === 0) {
    throw new Error("allowed_dirs is required when worker_profile is scoped_patch; pass a narrow file or directory scope.");
  }

  return {
    cwd: args.cwd,
    task,
    use_case: useCase,
    worker_profile,
    allowed_dirs,
    forbidden_paths,
    checks: arrayOfStrings(args.checks),
    required_skills,
    ignored_dirs: new Set([...DEFAULT_IGNORED_DIRS, ...arrayOfStrings(args.ignored_dirs)]),
    timeout_ms,
    timeout_source,
    check_timeout_ms: positiveNumber(args.check_timeout_ms, DEFAULT_CHECK_TIMEOUT_MS, "check_timeout_ms"),
    idle_after_ms,
    allow_docs_only,
    allow_parallel,
    claude_cc_switch_bin: args.claude_cc_switch_bin || process.env.CLAUDE_CC_SWITCH_BIN || DEFAULT_CLAUDE_CC_SWITCH,
    permission_mode,
    safety_mode,
    model,
    thinking,
    reasoning_effort,
    max_budget_usd,
    budget_source,
    enable_tool_search,
    preset_requires_review,
    verification_profile,
    output_format,
  };
}

function normalizeSafetyMode(value) {
  if (value == null || value === "") return "safe";
  if (value === "permissive" || value === "safe") return value;
  throw new Error("safety_mode must be permissive or safe");
}

function normalizeRequiredSkills(value) {
  const unique = [];
  const seen = new Set();
  for (const skill of arrayOfStrings(value)) {
    if (
      skill.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(skill)
      || skill.includes("..")
    ) {
      throw new Error(`Invalid required skill: ${skill}. Use a Claude Code skill name containing only letters, numbers, dots, underscores, colons, or hyphens.`);
    }
    if (!seen.has(skill)) {
      seen.add(skill);
      unique.push(skill);
    }
  }
  return unique;
}

function buildWorkerPrompt(args, allowedRoots, forbiddenPaths) {
  const useCase = USE_CASES[args.use_case] ?? USE_CASES.auto;
  const profile = WORKER_PROFILES[args.worker_profile] ?? WORKER_PROFILES.implementation;
  const allowed = allowedRoots.map((root) => relative(args.cwd, root) || ".").join(", ");
  const forbidden = forbiddenPaths.map((path) => relative(args.cwd, path)).join(", ");
  const checks = args.checks.length > 0 ? args.checks.join(" && ") : "none requested";
  const modelTarget = args.model || "current CC-Switch route (no explicit override)";
  const requiredSkills = args.required_skills.length > 0
    ? [
        "Before implementation, invoke every required Claude Code skill listed below using the Skill tool. Treat each skill as mandatory task guidance, while the host task boundary and permissions remain authoritative.",
        ...args.required_skills.map((skill) => `Required skill: /${skill}`),
      ]
    : ["Required Claude Code skills: none assigned by the host agent."];
  return [
    "You are a pure execution coding worker. Your success condition is real workspace code changes.",
    "The host agent decides task boundaries. Execute this one clearly scoped implementation task yourself.",
    "Do not spawn subagents or use Task unless the caller explicitly asks for nested worker delegation.",
    "Do not write plans, reports, or documentation unless the task explicitly asks for documentation.",
    "Do not stop after analysis. Edit files directly.",
    "Use Read for focused file inspection. For locating context in large files or codebases, prefer safe read-only Bash such as rg, grep, wc -l, sed -n, ls, find, git status, git diff, or git show over paging through huge files with repeated Read calls. Do not use Bash to write files.",
    "Prefer Edit or MultiEdit for file changes; do not use shell redirection, heredoc, or script-generated rewrites for normal edits.",
    "If a tool or permission is blocked, report the blocker and stop instead of retrying in place.",
    "After editing, list changed files exactly and run requested checks exactly as provided when possible. Do not retry blocked checks with command variants.",
    `Workspace: ${args.cwd}`,
    `Allowed paths: ${allowed}`,
    `Forbidden paths: ${forbidden || "none"}`,
    `Checks requested by caller: ${checks}`,
    `CC-Switch use case: ${args.use_case}`,
    `Worker profile: ${args.worker_profile}`,
    ...requiredSkills,
    profile.prompt,
    `CC-Switch model target: ${modelTarget}`,
    `Thinking mode: ${args.thinking}; reasoning effort: ${args.reasoning_effort}`,
    `Claude Code budget limit request: ${args.max_budget_usd == null ? "none" : `$${args.max_budget_usd}`}; enforcement may occur after a model or tool turn; tool search: ${args.enable_tool_search ? "enabled" : "disabled"}`,
    `Verification profile: ${args.verification_profile}`,
    `Use-case guidance: ${useCase.prompt}`,
    verificationGuidance(args.verification_profile),
    "After editing, give a concise summary of files changed and tests/checks run.",
    "",
    "Task:",
    args.task,
  ].join("\n");
}

function buildClaudeSettings(args, cwd) {
  if (args.permission_mode !== "dontAsk" && args.safety_mode !== "safe" && args.required_skills.length === 0) return null;
  const bashAllow = args.safety_mode === "safe"
    ? []
    : ["Bash", "Bash(*)"];
  const allow = [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "NotebookRead",
    "NotebookEdit",
    ...bashAllow,
    ...args.checks.map((check) => `Bash(${check})`),
    ...args.required_skills.map((skill) => `Skill(${skill})`),
  ];
  const deny = [
    ...DANGEROUS_BASH_DENY_RULES,
    ...args.forbidden_paths.flatMap((path) => [
      `Read(${permissionPathPattern(path)})`,
      `Edit(${permissionPathPattern(path)})`,
      `Write(${permissionPathPattern(path)})`,
    ]),
  ];
  return {
    permissions: {
      defaultMode: args.permission_mode,
      allow,
      deny,
      additionalDirectories: [cwd],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SELF_SCRIPT)} --permission-hook`,
            },
          ],
        },
      ],
      PostToolUse: [toolActivityHook()],
      PostToolUseFailure: [toolActivityHook()],
      PostToolBatch: [toolActivityHook()],
      PermissionRequest: [toolActivityHook()],
      PermissionDenied: [toolActivityHook()],
      Stop: [toolActivityHook()],
      StopFailure: [toolActivityHook()],
    },
  };
}

function toolActivityHook() {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(SELF_SCRIPT)} --permission-hook`,
      },
    ],
  };
}

function permissionPathPattern(path) {
  const normalized = normalizeRel(path);
  if (normalized.startsWith("/") || normalized.startsWith("~")) return normalized;
  return normalized.startsWith("./") ? normalized : `./${normalized}`;
}

async function runPermissionHook() {
  const input = JSON.parse(await readStdin());
  const config = JSON.parse(process.env.CC_SWITCH_WORKER_HOOK_CONFIG ?? "{}");
  const hookEventName = input.hook_event_name ?? input.event ?? "PreToolUse";
  const decision = hookEventName === "PreToolUse"
    ? permissionDecision(input, config)
    : null;
  appendToolActivity(input, config, decision);
  if (hookEventName !== "PreToolUse") return;
  if (!decision) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  })}\n`);
}

function permissionDecision(input, config) {
  const tool = input.tool_name;
  const toolInput = input.tool_input ?? {};
  const cwdDecision = toolWorkingDirectoryDecision(toolInput, config);
  if (cwdDecision) return cwdDecision;
  if (tool === "Bash") return bashPermissionDecision(toolInput.command ?? "", config);
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    return filePermissionDecision(toolInput, config, { write: true });
  }
  if (tool === "Read" || tool === "NotebookRead") {
    return filePermissionDecision(toolInput, config, { write: false });
  }
  if (tool === "Glob" || tool === "Grep") {
    return searchPermissionDecision(toolInput, config);
  }
  return null;
}

function toolWorkingDirectoryDecision(toolInput, config) {
  const requested = toolInput.cwd ?? toolInput.working_directory ?? null;
  if (!requested) return null;
  const workspace = policyPath(config.cwd ?? process.cwd());
  const candidate = policyPath(resolve(workspace, requested));
  if (!isInside(workspace, candidate)) return denyPermission(`Tool cwd resolves outside workspace: ${requested}`);
  if (pathIsSensitive(candidate, workspace)) return denyPermission(`Tool cwd targets a sensitive path: ${requested}`);
  return null;
}

function searchPermissionDecision(toolInput, config) {
  const requested = toolInput.path ?? toolInput.directory ?? toolInput.root ?? config.cwd ?? process.cwd();
  const workspace = policyPath(config.cwd ?? process.cwd());
  const candidate = policyPath(resolve(workspace, requested));
  if (!isInside(workspace, candidate)) return denyPermission(`Search resolves outside workspace: ${requested}`);
  if (pathIsSensitive(candidate, workspace)) return denyPermission(`Search targets a sensitive path: ${requested}`);
  const forbidden = (config.forbidden_paths ?? []).some((path) => {
    const resolvedPath = policyPath(path);
    return isInside(resolvedPath, candidate) || isInside(candidate, resolvedPath);
  });
  if (forbidden) return denyPermission(`Search overlaps a forbidden path: ${requested}`);
  return null;
}

function bashPermissionDecision(command, config) {
  const normalized = command.trim();
  if (!normalized) return denyPermission("Empty Bash command blocked by worker policy.");
  if ((config.checks ?? []).includes(normalized)) return allowPermission();
  if (isDangerousCommand(normalized)) return denyPermission(`Bash command blocked by worker policy: ${normalized}`);
  if (config.safety_mode !== "safe") return allowPermission();
  if (isSafeReadOnlyCommand(normalized)) {
    const pathDecision = bashReadPathDecision(normalized, config);
    if (pathDecision) return pathDecision;
    return allowPermission();
  }
  if (config.worker_profile === "scoped_patch") {
    return denyPermission(`Bash command is not an approved check for scoped_patch: ${normalized}`);
  }
  return null;
}

function isSafeReadOnlyCommand(command) {
  if (hasShellWriteOrChaining(command)) return false;
  const tokens = splitShellWords(command);
  const name = tokens[0] ?? "";
  if (name === "sed" && !isSafeSedReadOnlyCommand(tokens)) return false;
  if (name === "rg" && rgUsesPreprocessor(tokens)) return false;
  if (/^find\b/.test(command) && /(\s|^)-(delete|exec|execdir|ok|okdir|fprintf|fprint|fprint0|fls)(\s|$)/.test(command)) return false;
  if (/^rg(\s|$)/.test(command)) return true;
  if (/^grep(\s|$)/.test(command)) return true;
  if (/^wc(\s|$)/.test(command)) return true;
  if (name === "sed") return true;
  if (/^ls(\s|$)/.test(command)) return true;
  if (/^find\s+/.test(command)) return true;
  if (/^git\s+(status|diff|show)\b/.test(command)) return true;
  return false;
}

function rgUsesPreprocessor(tokens) {
  return tokens.some((token) => token === "--pre" || token.startsWith("--pre=") || token === "--pre-glob" || token.startsWith("--pre-glob="));
}

function isSafeSedReadOnlyCommand(tokens) {
  let suppressPrint = false;
  let scriptSeen = false;
  const scripts = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--") continue;
    if (token === "-n" || token === "--quiet" || token === "--silent") {
      suppressPrint = true;
      continue;
    }
    if (token === "-i" || token === "--in-place" || token.startsWith("-i") || token.startsWith("--in-place=")) return false;
    if (token === "-f" || token === "--file" || token.startsWith("-f") || token.startsWith("--file=")) return false;
    if (token === "-e" || token === "--expression") {
      if (index + 1 >= tokens.length) return false;
      scripts.push(tokens[index + 1]);
      scriptSeen = true;
      index++;
      continue;
    }
    if (token.startsWith("-e") && token.length > 2) {
      scripts.push(token.slice(2));
      scriptSeen = true;
      continue;
    }
    if (token.startsWith("--expression=")) {
      scripts.push(token.slice("--expression=".length));
      scriptSeen = true;
      continue;
    }
    if (isOptionToken(token)) continue;
    if (!scriptSeen) {
      scripts.push(token);
      scriptSeen = true;
    }
  }
  return suppressPrint && scripts.length > 0 && scripts.every((script) => !sedScriptCanReadWriteOrExecute(script));
}

function sedScriptCanReadWriteOrExecute(script) {
  for (const fragment of script.split(/[;\n]/)) {
    const command = stripSedAddress(fragment);
    if (!command) continue;
    if (/^[rRwWeE]/.test(command)) return true;
    if (sedSubstitutionHasUnsafeFlag(command)) return true;
  }
  return false;
}

function stripSedAddress(fragment) {
  let rest = fragment.trim();
  for (let count = 0; count < 2; count++) {
    const next = rest.replace(/^((?:\d+|\$)(?:[,+~]\d+)?|\/(?:\\.|[^/])*\/|\\.(?:\\.|[^\\])*\\.)(\s*)/, "");
    if (next === rest) break;
    rest = next.trimStart();
    if (rest.startsWith(",")) rest = rest.slice(1).trimStart();
    else break;
  }
  if (rest.startsWith("!")) rest = rest.slice(1).trimStart();
  rest = rest.replace(/^\{+\s*/, "");
  return rest;
}

function sedSubstitutionHasUnsafeFlag(command) {
  if (!command.startsWith("s") || command.length < 2) return false;
  const delimiter = command[1];
  if (/\s/.test(delimiter)) return false;
  let index = 2;
  for (let part = 0; part < 2; part++) {
    index = skipSedDelimitedPart(command, index, delimiter);
    if (index < 0 || index >= command.length || command[index] !== delimiter) return false;
    index++;
  }
  const flags = command.slice(index).trim();
  return /[eEwW]/.test(flags);
}

function skipSedDelimitedPart(command, index, delimiter) {
  let escaped = false;
  for (; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === delimiter) return index;
  }
  return -1;
}

function hasShellWriteOrChaining(command) {
  return /(^|[^\\])(;|&&|\|\||\||>|<|`|\$\()/.test(command);
}

function bashReadPathDecision(command, config) {
  for (const token of bashPathTokens(command)) {
    if (!token) continue;
    const abs = policyPath(resolve(config.cwd ?? process.cwd(), gitObjectPath(token)));
    const workspace = policyPath(config.cwd ?? process.cwd());
    if (!isInside(workspace, abs)) return denyPermission(`Bash command resolves outside workspace: ${token}`);
    const forbidden = (config.forbidden_paths ?? []).some((path) => {
      const resolvedPath = policyPath(path);
      return isInside(resolvedPath, abs) || isInside(abs, resolvedPath);
    });
    if (forbidden) return denyPermission(`Bash command targets forbidden path: ${token}`);
    if (Array.isArray(config.allowed_dirs) && config.allowed_dirs.length > 0) {
      const allowed = config.allowed_dirs.some((path) => isInside(policyPath(path), abs));
      if (!allowed) return denyPermission(`Bash command targets path outside allowed_dirs: ${token}`);
    }
  }
  return null;
}

function bashPathTokens(command) {
  const tokens = splitShellWords(command);
  const name = tokens[0] ?? "";
  if (name === "rg") return rgPathArgs(tokens);
  if (name === "grep") return grepPathArgs(tokens);
  if (name === "sed") return sedPathArgs(tokens);
  if (name === "wc") return wcPathArgs(tokens);
  if (name === "ls") return positionalArgs(tokens, 1, optionSpec({
    value: ["--block-size", "--color", "--format", "--hide", "--indicator-style", "--quoting-style", "--sort", "--time", "--time-style", "-I", "-w"],
  }));
  if (name === "find") return findPathArgs(tokens);
  if (name === "git") return gitPathArgs(tokens);
  return [];
}

function positionalArgs(tokens, start = 1, spec = optionSpec()) {
  const paths = [];
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token === "--") continue;
    const optionPath = pathFromInlineOption(token, spec);
    if (optionPath) paths.push(optionPath);
    if (isOptionToken(token)) {
      const option = optionName(token);
      if (spec.path.has(option) && !optionHasInlineValue(token) && index + 1 < tokens.length) {
        paths.push(tokens[index + 1]);
        index++;
      } else if (spec.pattern.has(option) || spec.value.has(option)) {
        if (!optionHasInlineValue(token) && index + 1 < tokens.length) index++;
      }
      continue;
    }
    paths.push(token);
  }
  return paths;
}

function rgPathArgs(tokens) {
  const state = collectPatternCommandPaths(tokens, {
    pattern: ["-e", "--regexp"],
    path: ["-f", "--file", "--ignore-file"],
    pathPattern: ["-f", "--file"],
    value: [
      "-g",
      "--glob",
      "-A",
      "--after-context",
      "-B",
      "--before-context",
      "-C",
      "--context",
      "-m",
      "--max-count",
      "--max-depth",
      "--colors",
      "--encoding",
      "--engine",
      "--sort",
      "--sortr",
      "--type",
      "-t",
      "--type-not",
      "-T",
    ],
  });
  if (state.paths.length > 0) return state.paths;
  if (state.patternSeen || state.filesMode) return ["."];
  return [];
}

function grepPathArgs(tokens) {
  const state = collectPatternCommandPaths(tokens, {
    pattern: ["-e", "--regexp"],
    path: ["-f", "--file", "--exclude-from"],
    pathPattern: ["-f", "--file"],
    value: [
      "-A",
      "--after-context",
      "-B",
      "--before-context",
      "-C",
      "--context",
      "-m",
      "--max-count",
      "-d",
      "--directories",
      "-D",
      "--devices",
      "--exclude",
      "--exclude-dir",
      "--include",
      "--label",
    ],
  });
  if (state.paths.length > 0) return state.paths;
  if (state.patternSeen) return ["."];
  return [];
}

function sedPathArgs(tokens) {
  const paths = [];
  let sawPattern = false;
  const spec = optionSpec({
    pattern: ["-e", "--expression"],
    path: ["-f", "--file"],
    value: ["-l", "--line-length", "-u", "--unbuffered", "-s", "--separate"],
  });
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token === "--") continue;
    const optionPath = pathFromInlineOption(token, spec);
    if (optionPath) paths.push(optionPath);
    if (isOptionToken(token)) {
      const option = optionName(token);
      if (optionPath && spec.path.has(option)) sawPattern = true;
      if (spec.path.has(option) && !optionHasInlineValue(token) && index + 1 < tokens.length) {
        paths.push(tokens[index + 1]);
        index++;
        sawPattern = true;
      } else if (spec.pattern.has(option)) {
        sawPattern = true;
        if (!optionHasInlineValue(token) && index + 1 < tokens.length) index++;
      } else if (spec.value.has(option) && !optionHasInlineValue(token) && index + 1 < tokens.length) {
        index++;
      }
      continue;
    }
    if (!sawPattern) {
      sawPattern = true;
      continue;
    }
    paths.push(token);
  }
  return paths;
}

function wcPathArgs(tokens) {
  return positionalArgs(tokens, 1, optionSpec({
    path: ["--files0-from"],
  }));
}

function findPathArgs(tokens) {
  const paths = [];
  const pathExpressionOptions = new Set([
    "-anewer",
    "-cnewer",
    "-newer",
    "-samefile",
  ]);
  const expressionOptions = new Set([
    "-amin",
    "-anewer",
    "-atime",
    "-cmin",
    "-cnewer",
    "-ctime",
    "-empty",
    "-false",
    "-fstype",
    "-gid",
    "-group",
    "-ilname",
    "-iname",
    "-inum",
    "-ipath",
    "-iregex",
    "-iwholename",
    "-links",
    "-lname",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mtime",
    "-name",
    "-newer",
    "-nogroup",
    "-nouser",
    "-path",
    "-perm",
    "-regex",
    "-samefile",
    "-size",
    "-true",
    "-type",
    "-uid",
    "-user",
    "-wholename",
    "-xtype",
  ]);
  const expressionOptionsWithValues = new Set([
    "-amin",
    "-anewer",
    "-atime",
    "-cmin",
    "-cnewer",
    "-ctime",
    "-fstype",
    "-gid",
    "-group",
    "-ilname",
    "-iname",
    "-inum",
    "-ipath",
    "-iregex",
    "-iwholename",
    "-links",
    "-lname",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mtime",
    "-name",
    "-newer",
    "-path",
    "-perm",
    "-regex",
    "-samefile",
    "-size",
    "-type",
    "-uid",
    "-user",
    "-wholename",
    "-xtype",
  ]);
  let inExpression = false;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token === "--") continue;
    if (isFindOperator(token)) continue;
    if (pathExpressionOptions.has(token)) {
      inExpression = true;
      if (index + 1 < tokens.length) {
        paths.push(tokens[index + 1]);
        index++;
      }
      continue;
    }
    if (expressionOptions.has(token)) {
      inExpression = true;
      if (expressionOptionsWithValues.has(token) && index + 1 < tokens.length) index++;
      continue;
    }
    if (isOptionToken(token)) {
      inExpression = true;
      if (index + 1 < tokens.length && !isOptionToken(tokens[index + 1])) index++;
      continue;
    }
    if (!inExpression) {
      paths.push(token);
    }
  }
  return paths.length > 0 ? paths : ["."];
}

function collectPatternCommandPaths(tokens, specValues = {}) {
  const spec = optionSpec(specValues);
  let patternSeen = false;
  let filesMode = false;
  const paths = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token === "--") continue;
    const optionPath = pathFromInlineOption(token, spec);
    if (optionPath) paths.push(optionPath);
    if (isOptionToken(token)) {
      if (token === "--files") filesMode = true;
      const option = optionName(token);
      if (optionPath && spec.pathPattern.has(option)) patternSeen = true;
      if (spec.path.has(option) && !optionHasInlineValue(token) && index + 1 < tokens.length) {
        const value = tokens[index + 1];
        index++;
        paths.push(value);
        if (spec.pathPattern.has(option)) patternSeen = true;
      } else if (spec.pattern.has(option)) {
        if (!optionHasInlineValue(token) && index + 1 < tokens.length) index++;
        patternSeen = true;
      } else if (spec.value.has(option) && !optionHasInlineValue(token) && index + 1 < tokens.length) {
        index++;
      }
      continue;
    }
    if (filesMode) {
      paths.push(token);
      continue;
    }
    if (!patternSeen) {
      patternSeen = true;
      continue;
    }
    paths.push(token);
  }
  return { paths, patternSeen, filesMode };
}

function gitPathArgs(tokens) {
  const subcommand = tokens[1] ?? "";
  if (!["status", "diff", "show"].includes(subcommand)) return [];
  const paths = [];
  let afterSeparator = false;
  for (let index = 2; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--") {
      afterSeparator = true;
      continue;
    }
    if (isOptionToken(token)) {
      if (gitOptionConsumesValue(token) && index + 1 < tokens.length) index++;
      continue;
    }
    if (afterSeparator || looksLikePathToken(token) || /^[^:]+:.+/.test(token)) {
      paths.push(token);
    }
  }
  if (paths.length === 0) return ["."];
  return paths;
}

function optionSpec({ pattern = [], path = [], pathPattern = [], value = [] } = {}) {
  return {
    pattern: new Set(pattern),
    path: new Set(path),
    pathPattern: new Set(pathPattern),
    value: new Set(value),
  };
}

function splitShellWords(command) {
  const words = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function isOptionToken(token) {
  return /^-[A-Za-z-]/.test(token);
}

function optionName(token) {
  if (token.startsWith("--")) {
    const equal = token.indexOf("=");
    return equal >= 0 ? token.slice(0, equal) : token;
  }
  if (/^-[A-Za-z]/.test(token)) return token.slice(0, 2);
  return token;
}

function pathFromInlineOption(token, spec) {
  const shortOption = optionName(token);
  if (!token.startsWith("--") && spec.path.has(shortOption) && token.startsWith(shortOption) && token.length > shortOption.length) {
    return token.slice(shortOption.length);
  }
  const equal = token.indexOf("=");
  if (equal < 0) return null;
  const option = token.slice(0, equal);
  if (spec.path.has(option)) return token.slice(equal + 1);
  return null;
}

function optionHasInlineValue(token) {
  if (token.startsWith("--")) return token.includes("=");
  return /^-[A-Za-z].+/.test(token) && token.length > 2;
}

function gitOptionConsumesValue(token) {
  const option = optionName(token);
  return [
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--format",
    "--diff-filter",
    "--find-renames",
    "--find-copies",
    "--stat",
    "--stat-width",
    "--stat-name-width",
    "--stat-count",
    "--ignore-matching-lines",
  ].includes(option);
}

function isFindOperator(token) {
  return ["!", "-not", "-a", "-and", "-o", "-or", "(", ")"].includes(token);
}

function looksLikePathToken(token) {
  if (!token || token.includes("*") || token.includes("?")) return false;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~")) return true;
  if (token.startsWith(".")) return true;
  if (token.includes("/") || token.includes("\\")) return true;
  if (/\.[A-Za-z0-9_-]+$/.test(token)) return true;
  return false;
}

function gitObjectPath(token) {
  const match = token.match(/^[^:]+:(.+)$/);
  return match ? match[1] : token;
}

function filePermissionDecision(toolInput, config, { write }) {
  const file = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path ?? null;
  if (!file) return null;
  if (write && config.worker_profile === "review") {
    return denyPermission(`Write blocked by read-only review profile: ${file}`);
  }
  const abs = policyPath(resolve(config.cwd ?? process.cwd(), file));
  const workspace = policyPath(config.cwd ?? process.cwd());
  if (!isInside(workspace, abs)) return denyPermission(`Access resolves outside workspace: ${file}`);
  if (pathIsSensitive(abs, workspace)) return denyPermission(`Access to sensitive path blocked: ${file}`);
  const forbidden = (config.forbidden_paths ?? []).some((path) => isInside(policyPath(path), abs));
  if (forbidden) return denyPermission(`Access to forbidden path blocked: ${file}`);
  if (write && Array.isArray(config.allowed_dirs) && config.allowed_dirs.length > 0) {
    const allowed = config.allowed_dirs.some((path) => isInside(policyPath(path), abs));
    if (!allowed) return denyPermission(`Write outside allowed_dirs blocked: ${file}`);
  }
  return null;
}

function pathIsSensitive(candidate, workspace) {
  const rel = normalizeRel(relative(workspace, candidate));
  return rel.split("/").some((name) => isSensitiveFileName(name));
}

function isDangerousCommand(command) {
  return /(^|\s)(sudo|curl|wget|chmod|chown)\b/.test(command)
    || /\brm\s+-[^\n;]*r/.test(command)
    || /^git\s+push\b/.test(command)
    || /^(npm|pnpm|yarn)\s+install\b/.test(command);
}

function allowPermission() {
  return { decision: "allow", reason: "Allowed by CC-Switch worker policy." };
}

function denyPermission(reason) {
  return { decision: "deny", reason };
}

function appendToolActivity(input, config, decision = null) {
  if (!config.tool_events_path) return;
  const event = summarizeHookInput(input, config, decision);
  if (!event) return;
  try {
    writeFileSync(config.tool_events_path, appendBounded(
      readTextIfExists(config.tool_events_path),
      `${JSON.stringify(event)}\n`,
    ));
  } catch {
    // Hook logging must never block Claude Code tool execution.
  }
}

function summarizeHookInput(input, config = {}, decision = null) {
  if (!input || typeof input !== "object") return null;
  const event = input.hook_event_name ?? input.event ?? "unknown";
  const tool = input.tool_name ?? input.tool?.name ?? null;
  const summary = {
    at: new Date().toISOString(),
    event,
    tool_name: tool,
  };
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  if (tool === "Bash") {
    summary.command = summarizeCommand(toolInput.command);
  } else {
    const path = firstString(toolInput.file_path, toolInput.path, toolInput.notebook_path);
    if (path) summary.path = displayPath(path, config.cwd);
    const pattern = firstString(toolInput.pattern, toolInput.regex);
    if (pattern) summary.pattern = truncateValue(pattern, 120);
  }
  const response = input.tool_response && typeof input.tool_response === "object" ? input.tool_response : null;
  if (response) {
    if (typeof response.duration_ms === "number") summary.duration_ms = response.duration_ms;
    if (typeof response.exit_code === "number") summary.exit_code = response.exit_code;
    if (typeof response.success === "boolean") summary.success = response.success;
  }
  if (typeof input.duration_ms === "number") summary.duration_ms = input.duration_ms;
  if (typeof input.error === "string") summary.error = truncateValue(redactSecrets(input.error), 240);
  if (input.error && typeof input.error.message === "string") summary.error = truncateValue(redactSecrets(input.error.message), 240);
  if (decision) {
    summary.permission_decision = decision.decision;
    summary.permission_reason = truncateValue(decision.reason, 240);
  }
  return summary;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

function displayPath(path, cwd) {
  const abs = resolve(cwd ?? process.cwd(), path);
  const rel = cwd ? normalizeRel(relative(cwd, abs)) : path;
  return rel && !rel.startsWith("..") ? rel : path;
}

function summarizeCommand(command) {
  if (typeof command !== "string") return null;
  return truncateValue(redactSecrets(command).replace(/\s+/g, " ").trim(), 240);
}

function truncateValue(value, max) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function redactSecrets(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/(["']?(?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|Bearer\s+[^\s,;]+|[^\s,;]+)/gi, "$1<redacted>")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "<redacted>");
}

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolvePromise(data));
    process.stdin.on("error", rejectPromise);
  });
}

function promptText(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePromise) => {
    rl.question(question, (answer) => {
      rl.close();
      resolvePromise(answer);
    });
  });
}

function promptSecret(question) {
  return new Promise((resolvePromise) => {
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write(question);
    let value = "";
    const onKeypress = (str, key) => {
      if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolvePromise(value);
        return;
      }
      if (key?.name === "backspace" || key?.name === "delete") {
        value = value.slice(0, -1);
        return;
      }
      if (key?.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
      if (typeof str === "string" && !key?.ctrl && !key?.meta) {
        value += str;
      }
    };
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
    };
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
  });
}

function verificationGuidance(profile) {
  const map = {
    smoke: "Verification guidance: make the smallest reasonable validation effort. Prefer caller-provided checks; otherwise report what could not be verified.",
    standard: "Verification guidance: run caller-provided checks and inspect related code paths before declaring success.",
    debug: "Verification guidance: reproduce or inspect the failure path first, then validate the minimal fix with the caller-provided checks.",
    review: "Verification guidance: treat output as review-worthy. Keep a clear changed-files summary and avoid expanding scope beyond allowed paths.",
    docs: "Verification guidance: validate links, filenames, and affected docs structure where practical.",
  };
  return map[profile] ?? map.standard;
}

function modelRunningMessage(args) {
  if (args.thinking === "enabled" && args.reasoning_effort === "max") {
    return "CC-Switch worker is running with strong reasoning. Claude Code may stay quiet for a long time before emitting logs or edits.";
  }
  if (args.thinking === "enabled") {
    return "CC-Switch worker is running with thinking mode enabled. Quiet periods are possible and not proof of failure.";
  }
  return "Worker process is running in non-thinking mode.";
}

function setJobPhase(job, phase, message) {
  if (!job) return;
  job.phase = phase;
  job.phase_message = message;
  job.updated_at = new Date().toISOString();
  writeJobStatus(job);
}

async function runClaudeCcSwitch({ cwd, prompt, timeout_ms, claude_cc_switch_bin, permission_mode, model, reasoning_effort, thinking, max_budget_usd, enable_tool_search, output_format, claude_settings, required_skills, job }) {
  const resolvedClaudeCcSwitchBin = resolveExecutable(claude_cc_switch_bin);
  if (!resolvedClaudeCcSwitchBin) {
    throw new Error(`CC-Switch launcher executable not found: ${claude_cc_switch_bin}. Install or build a Claude-Code-compatible launcher, put it on PATH, or set CLAUDE_CC_SWITCH_BIN.`);
  }
  const skillScopeRoot = stageRequiredSkills(required_skills, job);
  const effectiveClaudeSettings = addSettingsDirectory(claude_settings, skillScopeRoot);
  const claudeSettingsArg = prepareClaudeSettingsArg(effectiveClaudeSettings, job);
  const invocation = buildClaudeCcSwitchInvocation({
    prompt,
    cwd,
    permission_mode,
    model,
    reasoning_effort,
    max_budget_usd,
    output_format,
    claude_settings_arg: claudeSettingsArg,
    skill_scope_root: skillScopeRoot,
  });
  if (job) {
    job.claude_args_preview = previewClaudeArgs(invocation.args, prompt);
    writeJobStatus(job);
  }
  const extraEnv = {
    CLAUDE_CODE_EFFORT_LEVEL: reasoning_effort || DEFAULT_REASONING_EFFORT,
    CC_SWITCH_THINKING_MODE: thinking,
  };
  if (enable_tool_search) extraEnv.ENABLE_TOOL_SEARCH = "true";
  if (effectiveClaudeSettings) {
    extraEnv.CC_SWITCH_WORKER_HOOK_CONFIG = JSON.stringify({
      cwd,
      allowed_dirs: job?.allowedRoots ?? [],
      forbidden_paths: job?.forbiddenPaths ?? [],
      checks: job?.checks ?? [],
      worker_profile: job?.worker_profile ?? null,
      safety_mode: job?.safety_mode ?? "safe",
      tool_events_path: job?.job_dir ? join(job.job_dir, "tool-events.jsonl") : null,
    });
  }
  const processInvocation = nodeScriptInvocation(resolvedClaudeCcSwitchBin, invocation.args);
  try {
    return await runProcess(processInvocation.command, processInvocation.args, {
      cwd,
      timeout_ms,
      job,
      stream_name: "worker",
      invocation_preview: previewClaudeArgs(processInvocation.previewArgs, prompt),
      stdin_text: invocation.stdin_text,
      parse_stream_json: output_format === "stream-json",
      output_format,
      env: extraEnv,
      unset_env: enable_tool_search ? [] : ["ENABLE_TOOL_SEARCH"],
    });
  } finally {
    if (skillScopeRoot) {
      rmSync(skillScopeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

function stageRequiredSkills(requiredSkills, job) {
  if (!Array.isArray(requiredSkills) || requiredSkills.length === 0) return null;
  mkdirSync(JOB_ROOT, { recursive: true });
  const installedSkillsRoot = resolve(
    process.env.CC_SWITCH_WORKER_SKILLS_ROOT || join(homedir(), ".claude", "skills")
  );
  const scopeRoot = job?.job_dir
    ? join(job.job_dir, "skill-scope")
    : mkdtempSync(join(JOB_ROOT, "skill-scope-"));
  const targetRoot = join(scopeRoot, ".claude", "skills");
  mkdirSync(targetRoot, { recursive: true });
  try {
    for (const skill of requiredSkills) {
      const source = join(installedSkillsRoot, skill);
      const skillFile = join(source, "SKILL.md");
      if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
        throw new Error(`Required Claude Code skill is not installed: ${skill}. Expected ${skillFile}`);
      }
      cpSync(source, join(targetRoot, skill), { recursive: true, errorOnExist: true });
    }
    return scopeRoot;
  } catch (error) {
    rmSync(scopeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}

function addSettingsDirectory(claudeSettings, directory) {
  if (!claudeSettings || !directory) return claudeSettings;
  const settings = structuredClone(claudeSettings);
  const current = arrayOfStrings(settings.permissions?.additionalDirectories);
  settings.permissions.additionalDirectories = [...new Set([...current, directory])];
  return settings;
}

function prepareClaudeSettingsArg(claudeSettings, job) {
  if (!claudeSettings) return null;
  if (!job?.job_dir) return JSON.stringify(claudeSettings);
  const settingsPath = join(job.job_dir, "claude-settings.json");
  writeFileSync(settingsPath, JSON.stringify(claudeSettings, null, 2));
  job.claude_settings_path = settingsPath;
  return settingsPath;
}

function nodeScriptInvocation(command, args) {
  if (/\.(mjs|cjs|js)$/i.test(command)) {
    return {
      command: process.execPath,
      args: [command, ...args],
      previewArgs: [command, ...args],
    };
  }
  return { command, args, previewArgs: args };
}

function buildClaudeCcSwitchInvocation({ prompt, cwd, permission_mode, model, reasoning_effort = null, max_budget_usd = null, output_format, claude_settings_arg = null, skill_scope_root = null }) {
  const args = [
    "-p",
    "--bare",
    "--input-format",
    "text",
  ];
  if (output_format === "stream-json") {
    args.push("--verbose");
  }
  args.push(
    "--permission-mode",
    permission_mode,
    "--output-format",
    output_format,
  );
  if (cwd) {
    args.push("--add-dir", cwd);
  }
  if (skill_scope_root) {
    args.push("--add-dir", skill_scope_root);
  }
  if (claude_settings_arg) {
    args.push("--settings", claude_settings_arg);
  }
  if (output_format === "stream-json") {
    args.push("--include-partial-messages");
  }
  if (model) args.push("--model", model);
  if (reasoning_effort) args.push("--effort", reasoning_effort);
  if (max_budget_usd != null) args.push("--max-budget-usd", String(max_budget_usd));
  return { args, stdin_text: prompt };
}

function previewClaudeArgs(args, prompt = "<worker-prompt>") {
  const preview = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--settings" && i + 1 < args.length) {
      preview.push(args[i], "<claude-settings>");
      i++;
      continue;
    }
    preview.push(args[i] === prompt ? "<worker-prompt>" : args[i]);
  }
  return preview;
}

async function runCheck(cwd, command, timeout_ms) {
  const direct = directCheckInvocation(command);
  const invocation = direct ?? checkShellInvocation(command);
  const result = await runProcess(invocation.command, invocation.args, { cwd, timeout_ms });
  return {
    command,
    exit_code: result.exit_code,
    signal: result.signal,
    timed_out: result.timed_out,
    spawn_error: result.spawn_error,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
  };
}

function directCheckInvocation(command) {
  const tokens = splitShellWords(command);
  if (tokens.length === 0) return null;
  const exe = tokens[0];
  if (exe !== "node" && !/[\\/]node(?:\.exe)?$/i.test(exe)) return null;
  const hasEval = tokens.includes("-e") || tokens.includes("--eval");
  if (!hasEval) return null;
  const resolved = exe === "node" ? (resolveExecutable("node") || "node") : exe;
  return {
    command: resolved,
    args: tokens.slice(1),
  };
}

function runProcess(command, args, { cwd, timeout_ms = null, job = null, stream_name = "process", env = null, unset_env = [], invocation_preview = null, stdin_text = null, parse_stream_json = false, output_format = "text" }) {
  return new Promise((resolvePromise) => {
    const processEnv = minimalSubprocessEnvironment(env);
    for (const name of unset_env) delete processEnv[name];
    const child = spawn(command, args, {
      cwd,
      stdio: [stdin_text == null ? "ignore" : "pipe", "pipe", "pipe"],
      env: processEnv,
    });
    const processStarted = new Date();
    if (job) {
      job.child = child;
      job.process_alive = true;
      job.process_pid = child.pid ?? null;
      job.process_started_at_ms = processStarted.getTime();
      job.process_started_at = processStarted.toISOString();
      job.timeout_ms = timeout_ms;
      if (timeout_ms != null) {
        job.timeout_deadline_at_ms = processStarted.getTime() + timeout_ms;
        job.timeout_deadline_at = new Date(job.timeout_deadline_at_ms).toISOString();
      } else {
        job.timeout_deadline_at_ms = null;
        job.timeout_deadline_at = null;
      }
      job.last_heartbeat_at_ms = processStarted.getTime();
      job.last_heartbeat_at = processStarted.toISOString();
      job.updated_at = new Date().toISOString();
      writeJobStatus(job);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let eventsSeen = 0;
    let lastEventType = null;
    let lastEventSummary = null;
    let stdoutBuffer = "";
    let claudeResult = null;
    let settled = false;
    let spawnError = null;
    const heartbeat = startJobHeartbeat(job);
    const timer = timeout_ms == null ? null : setTimeout(() => {
      timedOut = true;
      const now = new Date();
      if (job) {
        job.timeout_fired_at = now.toISOString();
        job.last_error_kind = "caller_timeout";
      }
      setJobPhase(job, "caller_timeout", "Caller-provided timeout elapsed; stopping the worker process and reviewing artifacts.");
      terminateChildProcess(child);
    }, timeout_ms);
    if (stdin_text != null && child.stdin) {
      child.stdin.on("error", (error) => {
        if (error?.code !== "EPIPE") {
          const message = `${stream_name} stdin error: ${error.message}\n`;
          stderr = appendBounded(stderr, message);
          appendJobLog(job, "stderr", message);
        }
      });
      child.stdin.end(stdin_text);
    }

    const finish = ({ code = null, signal = null, error = null } = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (error) {
        spawnError = error;
        const message = `${stream_name} spawn error: ${error.message}\n`;
        stderr = appendBounded(stderr, message);
        appendJobLog(job, "stderr", message);
        if (job) {
          job.last_error_kind = "process_spawn_error";
          job.error = errorResult(error);
        }
      }
      if (stdoutBuffer.trim()) {
        try {
          const pendingEvent = JSON.parse(stdoutBuffer.trim());
          claudeResult = claudeResultMetadata(pendingEvent) ?? claudeResult;
          if (parse_stream_json) {
            eventsSeen++;
            lastEventType = pendingEvent.type ?? pendingEvent.event ?? null;
            lastEventSummary = summarizeClaudeEvent(pendingEvent);
            recordClaudeEvent(job, pendingEvent, lastEventSummary);
          }
        } catch {
          // Keep process and file evidence when Claude emits non-JSON diagnostics.
        }
      }
      if (job) {
        job.claude_result = claudeResult ?? job.claude_result ?? null;
        job.updated_at = new Date().toISOString();
        job.child = null;
        job.process_alive = false;
        writeJobStatus(job);
      }
      resolvePromise({
        exit_code: code,
        signal,
        timed_out: timedOut,
        cancelled: Boolean(job?.cancel_requested),
        spawn_error: spawnError ? spawnError.message : null,
        stdout,
        stderr,
        stream_name,
        claude_args_preview: job?.claude_args_preview ?? invocation_preview,
        output_format,
        events_seen: eventsSeen,
        last_event_type: lastEventType,
        last_event_summary: lastEventSummary,
        claude_result: claudeResult,
        successful_tool_count: job?.successful_tool_count ?? 0,
        last_successful_tool: job?.last_successful_tool ?? null,
      });
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      const safeText = redactSecrets(text);
      stdout = appendBounded(stdout, safeText);
      appendJobLog(job, "stdout", safeText);
      stdoutBuffer += text;
      if (parse_stream_json) {
        const parsed = consumeJsonLines(stdoutBuffer, (event) => {
          eventsSeen++;
          lastEventType = event.type ?? event.event ?? null;
          lastEventSummary = summarizeClaudeEvent(event);
          claudeResult = claudeResultMetadata(event) ?? claudeResult;
          recordClaudeEvent(job, event, lastEventSummary);
        });
        stdoutBuffer = parsed.remainder;
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = redactSecrets(chunk.toString("utf8"));
      stderr = appendBounded(stderr, text);
      appendJobLog(job, "stderr", text);
    });
    child.on("error", (error) => finish({ error }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}

function minimalSubprocessEnvironment(overrides = null) {
  const result = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (SUBPROCESS_ENV_ALLOWLIST.has(name) && value != null) result[name] = value;
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value != null) result[name] = String(value);
  }
  return result;
}

function startJobHeartbeat(job) {
  if (!job) return null;
  const timer = setInterval(() => {
    if (!job.process_alive || !["running", "cancel_requested"].includes(job.status)) return;
    const now = new Date();
    job.heartbeat_count = (job.heartbeat_count ?? 0) + 1;
    job.last_heartbeat_at_ms = now.getTime();
    job.last_heartbeat_at = now.toISOString();
    job.updated_at = job.last_heartbeat_at;
    writeJobStatus(job);
  }, DEFAULT_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function snapshotWorkspace(cwd, ignoredDirs, forbiddenPaths = []) {
  const files = new Map();
  walk(cwd, cwd, ignoredDirs, forbiddenPaths, files);
  return files;
}

function walk(root, current, ignoredDirs, forbiddenPaths, files) {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(current, entry.name);
    const rel = normalizeRel(relative(root, full));
    if (snapshotPathExcluded(full, rel, forbiddenPaths)) continue;
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      walk(root, full, ignoredDirs, forbiddenPaths, files);
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      files.set(rel, { kind: "large", size: stat.size, mtimeMs: stat.mtimeMs });
      continue;
    }
    try {
      const content = readFileSync(full);
      let contentStr;
      if (stat.size <= MAX_DIFF_CONTENT_BYTES) {
        contentStr = content.toString("utf8");
        if (isLikelyBinary(contentStr)) contentStr = undefined;
      }
      files.set(rel, {
        kind: "file",
        size: stat.size,
        hash: createHash("sha256").update(content).digest("hex"),
        content: contentStr,
      });
    } catch {
      // Ignore unreadable files. The policy layer still catches tracked git diffs where possible.
    }
  }
}

function diffSnapshots(before, after) {
  const changes = [];
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of names) {
    const a = before.get(name);
    const b = after.get(name);
    if (!a) changes.push({ path: name, type: "added" });
    else if (!b) changes.push({ path: name, type: "deleted" });
    else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ path: name, type: "modified" });
  }
  return changes;
}

function evaluatePolicy({ cwd, changedFiles, allowedRoots, forbiddenPaths, allow_docs_only }) {
  const outside_allowed = changedFiles.filter((file) => {
    const abs = resolve(cwd, file);
    return !allowedRoots.some((root) => isInside(root, abs));
  });
  const forbidden_changed = changedFiles.filter((file) => {
    const abs = resolve(cwd, file);
    return forbiddenPaths.some((forbidden) => abs === forbidden || isInside(forbidden, abs));
  });
  const docs_only = changedFiles.length > 0 && changedFiles.every(isDocPath);
  const ok = changedFiles.length > 0 && outside_allowed.length === 0 && forbidden_changed.length === 0;
  return {
    ok,
    outside_allowed,
    forbidden_changed,
    docs_only,
    allow_docs_only,
  };
}

async function gitSummary(cwd) {
  const isRepo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout_ms: 5000 });
  if (isRepo.exit_code !== 0) return { is_repo: false };
  const status = await runProcess("git", ["status", "--short"], { cwd, timeout_ms: 10000 });
  const stat = await runProcess("git", ["diff", "--stat"], { cwd, timeout_ms: 10000 });
  return {
    is_repo: true,
    status_short: status.stdout.trim(),
    diff_stat: stat.stdout.trim(),
  };
}

function failureReason({ changedFiles, policy, checkFailures, worker }) {
  if (worker.spawn_error) return "worker_spawn_error";
  if (policy.forbidden_changed.length > 0) return "changed_forbidden_paths";
  if (policy.outside_allowed.length > 0) return "changed_outside_allowed_dirs";
  if (checkFailures.length > 0) return "checks_failed";
  const limit = worker.claude_result?.limit_reason;
  if (limit && changedFiles.length === 0 && (worker.successful_tool_count ?? 0) > 0) return `${limit}_after_tool_success`;
  if (limit && changedFiles.length === 0) return `${limit}_no_valid_changes`;
  if (worker.cancelled && changedFiles.length === 0) return "worker_cancelled";
  if (worker.timed_out && changedFiles.length === 0) return "caller_timeout_no_valid_changes";
  if (worker.exit_code !== 0 && !worker.timed_out && !worker.cancelled) {
    return (worker.successful_tool_count ?? 0) > 0 && worker.claude_result?.final_text_present === false
      ? "worker_exited_after_tool_success_without_final_text"
      : "worker_exit_nonzero";
  }
  if (changedFiles.length === 0) return "no_code_changed";
  if (worker.cancelled) return "cancelled_after_valid_changes";
  if (worker.timed_out) return "caller_timeout_after_valid_changes";
  return null;
}

function classifyOutcome({ changedFiles, policy, checkFailures, worker, presetRequiresReview = false }) {
  const baseFailure = failureReason({ changedFiles, policy, checkFailures, worker });
  const validChanges = changedFiles.length > 0 && policy.ok && checkFailures.length === 0;
  const limit = worker.claude_result?.limit_reason;
  if (validChanges && limit) {
    return {
      status: "partial_worker_limit",
      partial: true,
      requires_review: true,
      review_hint: "Claude Code reached its budget or turn limit after policy-compliant changes. Tool side effects can occur before the terminal limit event; review the diff and rerun incomplete checks before accepting.",
      failure_reason: `${limit}_after_valid_changes`,
    };
  }
  if (validChanges && !worker.timed_out && worker.exit_code === 0 && !worker.cancelled) {
    return {
      status: "changed_files",
      partial: false,
      requires_review: presetRequiresReview,
      review_hint: presetRequiresReview
        ? "This use_case is review-worthy by default. Inspect the diff and validation output before accepting."
        : null,
      failure_reason: null,
    };
  }
  if (validChanges && worker.timed_out && !worker.cancelled) {
    return {
      status: "partial_caller_timeout",
      partial: true,
      requires_review: true,
      review_hint:
        "Caller-provided timeout stopped the worker after policy-compliant changes. Review the diff and check outputs before accepting; rerun checks if they did not complete.",
      failure_reason: "caller_timeout_after_valid_changes",
    };
  }
  if (validChanges && worker.cancelled) {
    return {
      status: "partial_cancelled",
      partial: true,
      requires_review: true,
      review_hint:
        "Cancellation stopped the worker after policy-compliant changes. Use MCP checks_run as the validation source, then inspect local changed files before accepting.",
      failure_reason: "cancelled_after_valid_changes",
    };
  }
  return {
    status: "failed",
    partial: changedFiles.length > 0,
    requires_review: changedFiles.length > 0,
    review_hint: changedFiles.length > 0
      ? "Worker produced changes, but policy or validation failed. Do not trust the patch until reviewed and repaired."
      : null,
    failure_reason: baseFailure,
  };
}

function isAcceptedResultStatus(status) {
  return status === "changed_files"
    || (typeof status === "string" && status.startsWith("partial_"));
}

function terminalJobStatus(resultStatus) {
  if (resultStatus === "changed_files") return "completed";
  if (typeof resultStatus === "string" && resultStatus.startsWith("partial_")) return "partial";
  return "failed";
}

function outputOptions(args = {}) {
  return {
    include_logs: Boolean(args.include_logs),
    include_events: Boolean(args.include_events),
    include_diff: Boolean(args.include_diff),
  };
}

function workerStatus(job, options = {}) {
  const worker = {
    output_format: job.output_format,
    last_error_kind: job.last_error_kind ?? null,
    final_result_subtype: job.claude_result?.subtype ?? null,
    final_text_present: job.claude_result?.final_text_present ?? null,
    limit_reason: job.claude_result?.limit_reason ?? null,
    total_cost_usd: job.claude_result?.total_cost_usd ?? null,
    num_turns: job.claude_result?.num_turns ?? null,
    models_used: job.claude_result?.models_used ?? [],
    successful_tool_count: job.successful_tool_count ?? 0,
    tool_activity: toolActivitySummary(job),
  };
  if (options.include_logs) {
    worker.claude_args_preview = job.claude_args_preview ?? null;
    worker.stdout_tail = tail(job.stdout ?? "");
    worker.stderr_tail = tail(job.stderr ?? "");
    worker.last_successful_tool = job.last_successful_tool ?? null;
    worker.last_failed_tool = job.last_failed_tool ?? null;
    worker.tool_calls_since_last_change = job.tool_calls_since_last_change ?? 0;
  }
  if (options.include_events) {
    worker.last_event_at = job.last_event_at;
    worker.last_event_type = job.last_event_type;
    worker.last_event_summary = job.last_event_summary;
    worker.recent_events = job.stream_events ?? [];
    worker.tool_events = readToolEvents(job).slice(-50);
  }
  return worker;
}

function toolActivitySummary(job) {
  const events = readToolEvents(job);
  const counts = {};
  for (const event of events) {
    const key = event.tool_name || event.event || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const last = events.at(-1) ?? null;
  const permissionDenials = events.filter((event) => event.permission_decision === "deny" || event.event === "PermissionDenied");
  const lastPermissionDenial = permissionDenials.at(-1) ?? null;
  return {
    total_events: events.length,
    last_event: last ? {
      event: last.event ?? null,
      tool_name: last.tool_name ?? null,
      path: last.path ?? null,
      command: last.command ?? null,
      exit_code: last.exit_code ?? null,
      success: last.success ?? null,
      permission_decision: last.permission_decision ?? null,
      permission_reason: last.permission_reason ?? null,
    } : null,
    counts,
    permission_denials: permissionDenials.length,
    last_permission_denial: lastPermissionDenial ? {
      at: lastPermissionDenial.at ?? null,
      tool_name: lastPermissionDenial.tool_name ?? null,
      command: lastPermissionDenial.command ?? null,
      path: lastPermissionDenial.path ?? null,
      permission_reason: lastPermissionDenial.permission_reason ?? null,
    } : null,
  };
}

function readToolEvents(job) {
  if (!job?.job_dir) return [];
  const text = readTextIfExists(join(job.job_dir, "tool-events.jsonl"));
  if (!text.trim()) return [];
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore partial hook log lines.
    }
  }
  return events;
}

function resultForOutput(result, options = {}) {
  if (!result) return result;
  const output = { ...result };
  delete output.file_diffs;
  output.checks_run = checksForOutput(result.checks_run ?? [], options);
  if (result.worker) {
    output.worker = {
      exit_code: result.worker.exit_code,
      signal: result.worker.signal,
      timed_out: result.worker.timed_out,
      cancelled: result.worker.cancelled,
      spawn_error: result.worker.spawn_error,
      output_format: result.worker.output_format,
      events_seen: result.worker.events_seen,
      last_event_type: result.worker.last_event_type,
      last_event_summary: result.worker.last_event_summary,
      final_result_subtype: result.worker.final_result_subtype,
      final_result_is_error: result.worker.final_result_is_error,
      final_text_present: result.worker.final_text_present,
      limit_reason: result.worker.limit_reason,
      total_cost_usd: result.worker.total_cost_usd,
      num_turns: result.worker.num_turns,
      models_used: result.worker.models_used,
      successful_tool_count: result.worker.successful_tool_count,
      last_successful_tool: result.worker.last_successful_tool,
    };
    if (options.include_logs) {
      output.worker.claude_args_preview = result.worker.claude_args_preview;
      output.worker.stdout_tail = result.worker.stdout_tail;
      output.worker.stderr_tail = result.worker.stderr_tail;
    }
  }
  if (options.include_diff) {
    output.file_diffs = result.file_diffs ?? [];
  }
  return stripLargeEvidence(output, options);
}

function errorForOutput(error, options = {}) {
  return stripLargeEvidence(error, options);
}

function stripLargeEvidence(value, options = {}) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripLargeEvidence(item, options));
  const stripped = {};
  for (const [key, item] of Object.entries(value)) {
    if (!options.include_logs && (key === "stdout_tail" || key === "stderr_tail")) continue;
    if (!options.include_events && key === "recent_events") continue;
    if (!options.include_diff && key === "file_diffs") continue;
    stripped[key] = stripLargeEvidence(item, options);
  }
  return stripped;
}

function checksForOutput(checks, options = {}) {
  if (!Array.isArray(checks)) return [];
  return checks.map((check) => {
    if (options.include_logs) return check;
    return {
      command: check.command,
      exit_code: check.exit_code,
      signal: check.signal ?? null,
      timed_out: check.timed_out,
      spawn_error: check.spawn_error ?? null,
    };
  });
}

function serializeJob(job, options = {}) {
  return {
    id: job.id,
    status: job.status,
    started_at: job.started_at,
    updated_at: job.updated_at,
    elapsed_ms: Date.now() - job.started_ms,
    use_case: job.use_case,
    worker_profile: job.worker_profile,
    preset_requires_review: job.preset_requires_review,
    permission_mode: job.permission_mode,
    task_hash: job.task_hash ?? null,
    timeout_ms: job.timeout_ms ?? null,
    timeout_source: job.timeout_source ?? null,
    timeout_deadline_at: job.timeout_deadline_at ?? null,
    restored_from_disk: Boolean(job.restored_from_disk),
    progress: progressForJob(job),
    worker: workerStatus(job, options),
    result: resultForOutput(job.result, options),
    error: errorForOutput(job.error, options),
    job_dir: job.job_dir,
  };
}

async function waitForJob(args) {
  const job = getJob(args.job_id);
  if (!job) {
    return { status: "not_found", job_id: args.job_id };
  }
  const options = outputOptions(args);

  const waitRequested = args.max_wait_ms != null;
  const requestedMaxWaitMs = waitRequested
    ? positiveNumber(args.max_wait_ms, DEFAULT_FOREGROUND_WAIT_CAP_MS, "max_wait_ms")
    : 0;
  const maxWaitMs = Math.min(requestedMaxWaitMs, DEFAULT_FOREGROUND_WAIT_CAP_MS);
  const defaultPoll = 30 * 1000;
  const pollIntervalMs = positiveNumber(args.poll_interval_ms, defaultPoll, "poll_interval_ms");
  const started = Date.now();
  const observations = [];

  const initialProgress = progressForJob(job);
  observations.push(compactProgress(initialProgress));
  const initialDecision = waitDecision(job);
  if (initialDecision) {
    return {
      ...initialDecision,
      job_id: job.id,
      elapsed_wait_ms: Date.now() - started,
      progress: initialProgress,
      result: resultForOutput(job.result, options),
      error: errorForOutput(job.error, options),
      observations,
    };
  }

  while (maxWaitMs > 0 && Date.now() - started <= maxWaitMs) {
    const progress = progressForJob(job);
    observations.push(compactProgress(progress));
    const decision = waitDecision(job);
    if (decision) {
      return {
        status: decision.status,
        reason: decision.reason,
        job_id: job.id,
        elapsed_wait_ms: Date.now() - started,
        progress,
        result: resultForOutput(job.result, options),
        error: errorForOutput(job.error, options),
        observations,
      };
    }
    const remainingMs = maxWaitMs - (Date.now() - started);
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  const progress = progressForJob(job);
  const hitForegroundCap = requestedMaxWaitMs > maxWaitMs;
  return {
    status: "running",
    reason: !waitRequested
      ? "no_wait_requested"
      : hitForegroundCap ? "foreground_wait_cap_elapsed" : "max_wait_elapsed",
    job_id: job.id,
    elapsed_wait_ms: Date.now() - started,
    requested_max_wait_ms: requestedMaxWaitMs,
    effective_max_wait_ms: maxWaitMs,
    foreground_wait_cap_ms: DEFAULT_FOREGROUND_WAIT_CAP_MS,
    hit_foreground_cap: hitForegroundCap,
    progress,
    result: resultForOutput(job.result, options),
    error: errorForOutput(job.error, options),
    observations,
  };
}

function waitDecision(job) {
  if (job.status === "completed") {
    return {
      status: "completed",
      reason: "job_completed",
    };
  }
  if (job.status === "partial") {
    return {
      status: "partial",
      reason: "job_partial",
    };
  }
  if (job.status === "failed") {
    return {
      status: "failed",
      reason: "job_failed",
    };
  }
  if (job.status === "cancel_requested") {
    return {
      status: "cancel_requested",
      reason: "job_cancel_requested",
    };
  }
  if (job.status === "orphaned") {
    return {
      status: "orphaned",
      reason: "orphaned_after_mcp_restart",
    };
  }
  return null;
}

function compactProgress(progress) {
  return {
    at: new Date().toISOString(),
    status: progress.status,
    phase: progress.phase,
    health_state: progress.health?.state ?? null,
    change_count_so_far: progress.change_count_so_far ?? 0,
    last_error_kind: progress.last_error_kind,
  };
}

function positiveNumber(value, fallback, label) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return number;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function progressForJob(job) {
  refreshRestoredJobState(job);
  const idle = idleStatus(job);
  const base = {
    status: job.status,
    phase: job.phase ?? job.status,
    phase_message: job.phase_message ?? null,
    process_alive: Boolean(job.process_alive),
    process_pid: job.process_pid ?? null,
    last_stream_kind: job.last_stream_kind ?? null,
    last_error_kind: job.last_error_kind ?? null,
    elapsed_ms: Date.now() - job.started_ms,
    ...idle,
    health: healthForJob(job, idle),
  };
  const terminalProgress = terminalResultProgress(job, base);
  if (terminalProgress) return terminalProgress;
  if (!job.cwd || !job.before || !job.ignored_dirs) {
    return base;
  }
  const now = snapshotWorkspace(job.cwd, job.ignored_dirs);
  const changes = diffSnapshots(job.before, now);
  const changedFiles = changes.map((change) => change.path).sort();
  updateToolChangeCounters(job, changedFiles.length);
  const { diffAvailable } = computeFileDiffs(job.before, now, changes);
  const policySoFar = evaluatePolicy({
    cwd: job.cwd,
    changedFiles,
    allowedRoots: job.allowedRoots,
    forbiddenPaths: job.forbiddenPaths,
    allow_docs_only: job.allow_docs_only,
  });
  return {
    ...base,
    progress_source: "live_workspace_snapshot",
    changed_files_so_far: changedFiles,
    change_count_so_far: changedFiles.length,
    diff_available: diffAvailable,
    policy_so_far: policySoFar,
    last_change_at: lastChangeAt(job.cwd, changedFiles),
    review_summary: buildReviewSummary({
      changedFiles,
      diffAvailable,
      policy: policySoFar,
      checks: [],
      failureReason: null,
      requiresReview: changedFiles.length > 0 || !policySoFar.ok,
      job,
    }),
  };
}

function terminalResultProgress(job, base) {
  if (!job?.result) return null;
  if (job.status === "running" && job.process_alive) return null;
  const changedFiles = arrayOfStrings(job.result.files_changed).sort();
  const policy = job.result.policy ?? {
    ok: changedFiles.length > 0,
    outside_allowed: [],
    forbidden_changed: [],
    docs_only: changedFiles.length > 0 && changedFiles.every(isDocPath),
    allow_docs_only: Boolean(job.allow_docs_only),
  };
  const diffAvailable = Boolean(job.result.diff_available);
  const reviewSummary = job.result.review_summary ?? buildReviewSummary({
    changedFiles,
    diffAvailable,
    policy,
    checks: job.result.checks_run ?? [],
    failureReason: job.result.failure_reason ?? null,
    requiresReview: Boolean(job.result.requires_review),
    job,
  });
  return {
    ...base,
    progress_source: "persisted_result",
    restored_progress_warning: job.restored_from_disk
      ? "Progress uses the persisted terminal result instead of re-diffing the current workspace, so old jobs do not report later unrelated edits."
      : null,
    changed_files_so_far: changedFiles,
    change_count_so_far: changedFiles.length,
    diff_available: diffAvailable,
    policy_so_far: policy,
    last_change_at: job.result.completed_at ?? null,
    review_summary: reviewSummary,
  };
}

function healthForJob(job, idle = idleStatus(job)) {
  const now = Date.now();
  const timeout = timeoutStatus(job, now);
  const pending = pendingToolDuration(job, now);
  const toolEvents = readToolEvents(job);
  const permissionDenials = toolEvents.filter((event) => event.permission_decision === "deny" || event.event === "PermissionDenied");
  const lastPermissionDenial = permissionDenials.at(-1) ?? null;
  const quiet = idle.idle_ms >= (job.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS);
  const noOutputYet = !job.last_output_at;
  let state = job.status;
  if (job.status === "running") {
    if (timeout.timeout_elapsed) {
      state = "timeout_elapsed";
    } else if (lastPermissionDenial && quiet) {
      state = "possible_permission_block";
    } else if (isApiRetryState(job) && quiet) {
      state = "api_retry_quiet";
    } else if (job.pending_tool_use && pending.pending_tool_duration_ms >= (job.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS)) {
      state = "pending_tool_quiet";
    } else if (noOutputYet && quiet) {
      state = "waiting_for_first_output";
    } else if (quiet) {
      state = "quiet";
    } else {
      state = "active";
    }
  } else if (job.status === "orphaned") {
    state = "orphaned_after_restart";
  }
  return {
    state,
    quiet,
    no_output_yet: noOutputYet,
    idle_after_ms: job.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS,
    heartbeat_at: job.last_heartbeat_at ?? null,
    heartbeat_age_ms: job.last_heartbeat_at_ms ? Math.max(0, now - job.last_heartbeat_at_ms) : null,
    heartbeat_count: job.heartbeat_count ?? 0,
    ...timeout,
    pending_tool_use: job.pending_tool_use ?? null,
    pending_tool_duration_ms: pending.pending_tool_duration_ms,
    permission_denials: permissionDenials.length,
    last_permission_denial: lastPermissionDenial ? {
      at: lastPermissionDenial.at ?? null,
      tool_name: lastPermissionDenial.tool_name ?? null,
      command: lastPermissionDenial.command ?? null,
      path: lastPermissionDenial.path ?? null,
      permission_reason: lastPermissionDenial.permission_reason ?? null,
    } : null,
  };
}

function isApiRetryState(job) {
  return String(job.last_stream_kind ?? "").includes("api_retry")
    || String(job.last_event_type ?? "").includes("api_retry")
    || String(job.last_event_summary ?? "").includes("api_retry");
}

function timeoutStatus(job, now = Date.now()) {
  const timeoutMs = Number(job.timeout_ms);
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const persistedDeadline = job.timeout_deadline_at_ms;
  const processStarted = job.process_started_at_ms;
  const deadlineMs = persistedDeadline != null && Number.isFinite(Number(persistedDeadline))
    ? Number(job.timeout_deadline_at_ms)
    : (hasTimeout && processStarted != null && Number.isFinite(Number(processStarted))
      ? Number(processStarted) + timeoutMs
      : null);
  const remainingMs = deadlineMs == null ? null : deadlineMs - now;
  return {
    timeout_ms: hasTimeout ? timeoutMs : null,
    timeout_source: job.timeout_source ?? null,
    timeout_deadline_at: deadlineMs == null ? null : new Date(deadlineMs).toISOString(),
    timeout_remaining_ms: remainingMs == null ? null : Math.max(0, remainingMs),
    timeout_elapsed: Boolean(job.timeout_fired_at) || (remainingMs != null && remainingMs <= 0 && job.status === "running"),
  };
}

function pendingToolDuration(job, now = Date.now()) {
  if (!job?.pending_tool_use || !job.last_tool_use_at) {
    return {
      pending_tool_duration_ms: null,
      pending_tool_duration_seconds: null,
    };
  }
  const started = Date.parse(job.last_tool_use_at);
  if (!Number.isFinite(started)) {
    return {
      pending_tool_duration_ms: null,
      pending_tool_duration_seconds: null,
    };
  }
  const durationMs = Math.max(0, now - started);
  return {
    pending_tool_duration_ms: durationMs,
    pending_tool_duration_seconds: Math.floor(durationMs / 1000),
  };
}

function lastChangeAt(cwd, changedFiles) {
  let latest = 0;
  for (const file of changedFiles) {
    try {
      const mtime = statSync(resolve(cwd, file)).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch {
      // Deleted files have no mtime; ignore them for last_change_at.
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function updateToolChangeCounters(job, changeCount) {
  if (!job) return;
  const previous = job.last_observed_change_count ?? 0;
  if (changeCount > previous) {
    job.tool_calls_since_last_change = 0;
  }
  job.last_observed_change_count = changeCount;
}

function idleStatus(job) {
  const reference = job.last_output_at_ms ?? job.started_ms ?? Date.now();
  const idleMs = Date.now() - reference;
  return {
    last_output_at: job.last_output_at ?? null,
    idle_ms: idleMs,
    idle_seconds: Math.floor(idleMs / 1000),
  };
}

function recordClaudeEvent(job, event, summary) {
  if (!job) return;
  const now = new Date();
  const detail = classifyClaudeEvent(event);
  const eventType = detail.type ?? "unknown";
  const payload = event?.event && typeof event.event === "object" ? event.event : event;
  const nowIso = now.toISOString();
  if (job.pending_tool_use && isModelResumedAfterTool(detail)) {
    job.last_successful_tool = job.pending_tool_use;
    job.successful_tool_count = (job.successful_tool_count ?? 0) + 1;
    job.last_tool_result_at = nowIso;
    job.last_tool_result_inferred = true;
    job.pending_tool_use = null;
  }
  job.updated_at = now.toISOString();
  job.last_event_at_ms = now.getTime();
  job.last_event_at = now.toISOString();
  job.last_event_type = eventType;
  job.last_event_summary = summary;
  job.last_stream_kind = detail.kind;
  if (detail.kind === "tool_use") {
    job.streaming_tool_input = detail.tool_name ?? "unknown_tool";
    job.last_tool_input_at = nowIso;
    job.last_tool_name = detail.tool_name ?? job.last_tool_name ?? null;
    job.tool_calls_since_last_change = (job.tool_calls_since_last_change ?? 0) + 1;
  } else if (detail.kind === "tool_input_delta") {
    job.last_tool_input_at = nowIso;
  } else if (detail.kind === "content_block_stop" && job.streaming_tool_input != null) {
    job.pending_tool_use = job.streaming_tool_input;
    job.last_tool_name = job.streaming_tool_input;
    job.last_tool_use_at = nowIso;
    job.last_tool_input_completed_at = nowIso;
    job.last_tool_result_inferred = false;
    job.streaming_tool_input = null;
  } else if (detail.kind === "tool_result") {
    job.pending_tool_use = null;
    job.streaming_tool_input = null;
    job.last_tool_name = detail.tool_name ?? job.last_tool_name ?? null;
    job.last_tool_result_at = nowIso;
    job.last_tool_result_inferred = false;
    if (detail.is_error) {
      job.last_failed_tool = job.last_tool_name;
      job.last_error_kind = "tool_result_error";
    } else {
      job.last_successful_tool = job.last_tool_name;
      job.successful_tool_count = (job.successful_tool_count ?? 0) + 1;
    }
  } else if (detail.kind === "error_result") {
    job.last_error_kind = "model_result_error";
  } else if (payload?.type === "result") {
    job.pending_tool_use = null;
    job.streaming_tool_input = null;
  }
  job.claude_result = claudeResultMetadata(event) ?? job.claude_result ?? null;
  job.last_output_at_ms = now.getTime();
  job.last_output_at = now.toISOString();
  job.stream_events = [...(job.stream_events ?? []), compactClaudeEvent(event, summary)].slice(-MAX_STREAM_EVENTS);
  const phase = phaseFromClaudeEvent(event);
  if (phase) {
    job.phase = phase.phase;
    job.phase_message = phase.message;
  }
  writeJobStatus(job);
}

function isModelResumedAfterTool(detail) {
  return detail.kind === "message_start"
    || detail.kind === "thinking_delta"
    || detail.kind === "text_delta"
    || detail.kind === "tool_use";
}

function appendJobLog(job, stream, text) {
  if (!job) return;
  const safeText = redactSecrets(text);
  if (stream === "stdout") job.stdout = appendBounded(job.stdout ?? "", safeText);
  if (stream === "stderr") job.stderr = appendBounded(job.stderr ?? "", safeText);
  const now = new Date();
  job.updated_at = now.toISOString();
  job.last_output_at_ms = now.getTime();
  job.last_output_at = now.toISOString();
  if (job.job_dir) {
    const logPath = join(job.job_dir, `${stream}.log`);
    writeFileSync(logPath, appendBounded(readTextIfExists(logPath), safeText));
    writeJobStatus(job);
  }
}

function writeJobStatus(job) {
  if (!job?.job_dir) return;
  const idle = idleStatus(job);
  const safe = {
    id: job.id,
    status: job.status,
    server_version: SERVER_VERSION,
    started_at: job.started_at,
    updated_at: job.updated_at,
    elapsed_ms: Date.now() - job.started_ms,
    cwd: job.cwd,
    job_dir: job.job_dir,
    restored_from_disk: Boolean(job.restored_from_disk),
    use_case: job.use_case,
    worker_profile: job.worker_profile,
    model: job.model,
    thinking: job.thinking,
    reasoning_effort: job.reasoning_effort,
    max_budget_usd: job.max_budget_usd ?? null,
    budget_source: job.budget_source ?? null,
    enable_tool_search: Boolean(job.enable_tool_search),
    preset_requires_review: job.preset_requires_review,
    verification_profile: job.verification_profile,
    permission_mode: job.permission_mode,
    safety_mode: job.safety_mode,
    timeout_ms: job.timeout_ms ?? null,
    timeout_source: job.timeout_source ?? null,
    process_started_at_ms: job.process_started_at_ms ?? null,
    process_started_at: job.process_started_at ?? null,
    timeout_deadline_at_ms: job.timeout_deadline_at_ms ?? null,
    timeout_deadline_at: job.timeout_deadline_at ?? null,
    timeout_fired_at: job.timeout_fired_at ?? null,
    last_heartbeat_at_ms: job.last_heartbeat_at_ms ?? null,
    last_heartbeat_at: job.last_heartbeat_at ?? null,
    heartbeat_count: job.heartbeat_count ?? 0,
    claude_settings_active: job.claude_settings_active,
    claude_settings_path: job.claude_settings_path ?? null,
    phase: job.phase,
    phase_message: job.phase_message,
    process_alive: Boolean(job.process_alive),
    process_pid: job.process_pid ?? null,
    output_format: job.output_format,
    claude_args_preview: job.claude_args_preview ?? null,
    ignored_dirs: job.ignored_dirs instanceof Set ? [...job.ignored_dirs] : arrayOfStrings(job.ignored_dirs),
    allowedRoots: arrayOfStrings(job.allowedRoots),
    forbiddenPaths: arrayOfStrings(job.forbiddenPaths),
    checks: arrayOfStrings(job.checks),
    required_skills: arrayOfStrings(job.required_skills),
    allow_docs_only: Boolean(job.allow_docs_only),
    allow_parallel: Boolean(job.allow_parallel),
    task_hash: job.task_hash ?? null,
    idle_after_ms: job.idle_after_ms ?? DEFAULT_IDLE_AFTER_MS,
    last_output_at_ms: job.last_output_at_ms ?? null,
    last_event_at: job.last_event_at,
    last_event_at_ms: job.last_event_at_ms ?? null,
    last_event_type: job.last_event_type,
    last_event_summary: job.last_event_summary,
    last_stream_kind: job.last_stream_kind,
    pending_tool_use: job.pending_tool_use,
    streaming_tool_input: job.streaming_tool_input,
    last_tool_input_at: job.last_tool_input_at,
    last_tool_input_completed_at: job.last_tool_input_completed_at,
    last_tool_name: job.last_tool_name,
    last_tool_use_at: job.last_tool_use_at,
    last_tool_result_at: job.last_tool_result_at,
    last_tool_result_inferred: Boolean(job.last_tool_result_inferred),
    last_successful_tool: job.last_successful_tool,
    successful_tool_count: job.successful_tool_count ?? 0,
    last_failed_tool: job.last_failed_tool,
    claude_result: job.claude_result ?? null,
    last_error_kind: job.last_error_kind,
    tool_calls_since_last_change: job.tool_calls_since_last_change,
    ...pendingToolDuration(job),
    last_observed_change_count: job.last_observed_change_count,
    recent_events: job.stream_events ?? [],
    last_output_at: job.last_output_at,
    idle_seconds: idle.idle_seconds,
    health: healthForJob(job, idle),
    result: job.result,
    error: job.error,
    cancel_requested: job.cancel_requested,
  };
  writeFileSync(join(job.job_dir, "status.json"), JSON.stringify(safe, null, 2));
}

function writeJobRestoreData(job) {
  if (!job?.job_dir) return;
  writeFileSync(join(job.job_dir, "before-snapshot.json"), JSON.stringify(serializeSnapshot(job.before)));
}

function implementationSchema() {
  return {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Absolute workspace path where code should be edited." },
      task: {
        type: "string",
        description:
          "Self-contained implementation task. Must ask for real code changes. Include only the worker's bounded execution goal; keep planning, product decisions, and final review in the host agent. If this is a follow-up to a previous worker, include the previous job_id, terminal status, failure/check result, and current diff summary so the new worker does not rediscover context from scratch.",
      },
      use_case: {
        type: "string",
        enum: Object.keys(USE_CASES),
        description:
          "Task/cost preset. Defaults to auto: current CC-Switch route, reasoning_effort=high, thinking enabled, and a bounded API budget. fast_patch uses low effort and a smaller budget; complex_reasoning uses max effort and a larger budget.",
      },
      worker_profile: {
        type: "string",
        enum: Object.keys(WORKER_PROFILES),
        description:
          "Permission/output contract. Defaults to implementation. Use scoped_patch only with narrow allowed_dirs for tightly bounded patches; review is read-mostly; debug_loop is for reproduce/fix/check loops.",
      },
      allowed_dirs: {
        type: "array",
        items: { type: "string" },
        description: "Relative or absolute directories/files the worker is allowed to modify. Required for worker_profile=scoped_patch; keep it narrow.",
      },
      forbidden_paths: {
        type: "array",
        items: { type: "string" },
        description: "Relative or absolute paths that must not be modified.",
      },
      checks: {
        type: "array",
        items: { type: "string" },
        description: "Optional validation commands to run after successful edits, such as typecheck or tests. These commands are the authoritative verification record.",
      },
      required_skills: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional Claude Code skill names selected by the host agent for this worker task. Each skill is granted only for this invocation and explicitly required in the worker prompt, for example [\"tdd\"] or [\"diagnosing-bugs\", \"codebase-design\"]. Do not pass skills that are not installed for Claude Code.",
      },
      timeout_ms: {
        type: "number",
        description:
          `Caller-imposed stop time for the worker process. Sync calls default to ${DEFAULT_SYNC_TIMEOUT_MS}ms. Async fast_patch defaults to ${DEFAULT_FAST_PATCH_TIMEOUT_MS}ms, simple_agent_task to ${DEFAULT_SIMPLE_TASK_TIMEOUT_MS}ms, scaffold_or_tests to ${DEFAULT_SCAFFOLD_TIMEOUT_MS}ms; broader use cases still require an explicit caller timeout if desired.`,
      },
      check_timeout_ms: { type: "number", description: "Per-check timeout. Defaults to 10 minutes." },
      idle_after_ms: {
        type: "number",
        description: "Quiet-output threshold used by progress.health state labels. It does not cancel the worker; timeout_ms controls cancellation.",
      },
      allow_docs_only: { type: "boolean", description: "Deprecated compatibility field. Docs-only changes are reported, not rejected, in this build." },
      allow_parallel: {
        type: "boolean",
        description:
          "Async start safety valve. Defaults to false: if an active job with the same cwd, task, allowed paths, forbidden paths, checks, use_case, and worker_profile is already running, start returns already_running instead of launching a duplicate worker. Set allow_parallel=true only when duplicate parallel execution is intentional.",
      },
      model: { type: "string", description: "Optional model selector passed to claude-cc-switch. When omitted, CC-Switch keeps its current provider route. This selector and Claude result model identifiers do not prove the underlying provider model." },
      thinking: {
        type: "string",
        enum: ["enabled", "disabled"],
        description: "CC-Switch thinking-mode hint. Defaults from use_case.",
      },
      reasoning_effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description: "Claude Code effort level passed via --effort. Defaults from use_case.",
      },
      max_budget_usd: {
        type: "number",
        description: "Positive budget limit request passed to Claude Code via --max-budget-usd. Defaults from use_case. Enforcement can occur after a model or tool turn, so reported cost may exceed the request and limit results with changes are partial.",
      },
      enable_tool_search: {
        type: "boolean",
        description: "Allow inherited Claude ToolSearch behavior for this worker. Defaults to false so low-risk jobs do not spend a turn discovering tools before the task.",
      },
      verification_profile: {
        type: "string",
        enum: ["smoke", "standard", "debug", "review", "docs"],
        description:
          "Verification-loop hint inspired by Everything Claude Code. Defaults from use_case and is included in prompts/results; caller-provided checks still define actual commands.",
      },
      output_format: {
        type: "string",
        enum: ["stream-json", "json"],
        description:
          "Claude Code print output format. Defaults to stream-json and adds --verbose before --output-format plus --include-partial-messages. Use json only as fallback.",
      },
      permission_mode: {
        type: "string",
        enum: ["acceptEdits", "auto", "default", "dontAsk", "plan"],
        description: "Claude Code permission mode. Defaults from worker_profile. dontAsk uses per-worker allow/deny settings. safety_mode=safe also injects per-worker settings/hooks even with acceptEdits so checks can be allowed and unsafe Bash can be denied.",
      },
      safety_mode: {
        type: "string",
        enum: ["permissive", "safe"],
        description: "Bash policy for workers. Defaults to safe: inject settings/hooks, restrict Bash to read-only locator commands plus explicit checks, and keep all file/search tools inside the job workspace. permissive must be requested explicitly.",
      },
      claude_cc_switch_bin: { type: "string", description: "Path to claude-cc-switch executable." },
      ignored_dirs: {
        type: "array",
        items: { type: "string" },
        description: "Extra directory names to ignore while snapshotting.",
      },
    },
    required: ["cwd", "task"],
    additionalProperties: false,
  };
}

function jsonSchemaToZod(schema) {
  if (!schema || typeof schema !== "object") return z.object({});

  if (schema.type === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const shape = {};
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      let property = jsonSchemaToZod(propertySchema);
      if (!required.has(key)) property = property.optional();
      shape[key] = property;
    }
    let object = z.object(shape);
    if (schema.additionalProperties === false) object = object.strict();
    else object = object.passthrough();
    if (schema.description) object = object.describe(schema.description);
    return object;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.map(String);
    const enumSchema = values.length === 1
      ? z.literal(values[0])
      : z.enum(values);
    return schema.description ? enumSchema.describe(schema.description) : enumSchema;
  }

  let result;
  if (schema.type === "string") result = z.string();
  else if (schema.type === "number") result = z.number();
  else if (schema.type === "integer") result = z.number().int();
  else if (schema.type === "boolean") result = z.boolean();
  else if (schema.type === "array") result = z.array(jsonSchemaToZod(schema.items ?? {}));
  else result = z.unknown();

  return schema.description && typeof result.describe === "function"
    ? result.describe(schema.description)
    : result;
}

function normalizeUseCase(value) {
  if (typeof value !== "string" || value.length === 0) return "auto";
  if (!Object.hasOwn(USE_CASES, value)) {
    throw new Error(`Unknown use_case: ${value}. Valid values: ${Object.keys(USE_CASES).join(", ")}`);
  }
  return value;
}

function normalizeWorkerProfile(value) {
  if (typeof value !== "string" || value.length === 0) return "implementation";
  if (!Object.hasOwn(WORKER_PROFILES, value)) {
    throw new Error(`Unknown worker_profile: ${value}. Valid values: ${Object.keys(WORKER_PROFILES).join(", ")}`);
  }
  return value;
}

function normalizeThinking(value) {
  if (value === "enabled" || value === "disabled") return value;
  throw new Error("thinking must be one of: enabled, disabled");
}

function normalizeReasoningEffort(value) {
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) return value;
  throw new Error("reasoning_effort must be one of: low, medium, high, xhigh, max");
}

function normalizeOutputFormat(value) {
  if (value == null || value === "") return "stream-json";
  if (value === "stream-json" || value === "json") return value;
  throw new Error("output_format must be one of: stream-json, json");
}

function normalizeVerificationProfile(value) {
  if (value === "smoke" || value === "standard" || value === "debug" || value === "review" || value === "docs") return value;
  throw new Error("verification_profile must be one of: smoke, standard, debug, review, docs");
}

function normalizeOptionalNumber(value, fallback = null, label = "timeout_ms") {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number when provided`);
  }
  return number;
}

function normalizeRoots(cwd, roots) {
  const values = roots.length > 0 ? roots : ["."];
  return values.map((value) => {
    const abs = resolve(cwd, value);
    return assertInside(cwd, abs, "allowed_dirs");
  });
}

function normalizeForbidden(cwd, paths) {
  return paths.map((value) => assertInside(cwd, resolve(cwd, value), "forbidden_paths"));
}

function assertInside(root, candidate, label) {
  if (!isInside(root, candidate)) {
    throw new Error(`${label} escapes cwd: ${candidate}`);
  }
  return candidate;
}

function isInside(root, candidate) {
  const normalizedRoot = platform() === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const normalizedCandidate = platform() === "win32" ? resolve(candidate).toLowerCase() : resolve(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function policyPath(path) {
  const target = resolve(path);
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return target;
    ancestor = parent;
  }
  try {
    return resolve(realpathSync.native(ancestor), relative(ancestor, target));
  } catch {
    return target;
  }
}

function snapshotPathExcluded(full, rel, forbiddenPaths) {
  const names = normalizeRel(rel).split("/");
  if (names.some((name) => isSensitiveFileName(name))) return true;
  const candidate = policyPath(full);
  return forbiddenPaths.some((path) => {
    const forbidden = policyPath(path);
    return isInside(forbidden, candidate) || isInside(candidate, forbidden);
  });
}

function isSensitiveFileName(name) {
  const lower = String(name).toLowerCase();
  return lower === ".env"
    || lower.startsWith(".env.")
    || ["auth.json", "credentials.json", "cookies.json", ".npmrc", ".pypirc"].includes(lower)
    || /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore))$/.test(lower);
}

function isDocPath(path) {
  const lower = path.toLowerCase();
  return lower.startsWith("docs/")
    || lower.endsWith(".md")
    || lower.endsWith(".mdx")
    || lower.endsWith(".txt")
    || lower.endsWith(".rst")
    || lower.endsWith(".adoc");
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.length > 0);
}

function serializeSnapshot(snapshot) {
  if (!(snapshot instanceof Map)) return [];
  return [...snapshot.entries()].map(([path, metadata]) => [path, snapshotMetadata(metadata)]);
}

function deserializeSnapshot(value) {
  if (!Array.isArray(value)) return null;
  return new Map(value
    .filter((entry) => Array.isArray(entry) && entry.length === 2)
    .map(([path, metadata]) => [path, snapshotMetadata(metadata)]));
}

function snapshotMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return metadata;
  const { content: _content, ...safe } = metadata;
  return safe;
}

function readTextIfExists(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function readJsonIfExists(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

function parseTimeMs(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function restoreStartedMs(data) {
  if (typeof data.started_ms === "number" && Number.isFinite(data.started_ms)) return data.started_ms;
  if (typeof data.started_at === "string") {
    const ms = Date.parse(data.started_at);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof data.elapsed_ms === "number" && Number.isFinite(data.elapsed_ms)) return Date.now() - data.elapsed_ms;
  return Date.now();
}

function processPidAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : null;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = executableExtensions(command);
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(path) {
  try {
    accessSync(path, platform() === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableExtensions(command) {
  if (platform() !== "win32") return [""];
  if (/\.[^\\/]+$/.test(command)) return [""];
  return (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((ext) => ext.toLowerCase())
    .concat("");
}

function defaultClaudeBin() {
  if (platform() === "win32") return "claude";
  return resolve(homedir(), ".local/bin/claude");
}

function checkShellInvocation(command) {
  if (platform() === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  const shell = resolveExecutable("zsh") || resolveExecutable("bash") || resolveExecutable("sh") || "/bin/sh";
  return { command: shell, args: ["-lc", command] };
}

function normalizeRel(path) {
  return path.split(sep).join("/");
}

function isLikelyBinary(text) {
  return text.includes("\u0000");
}

function computeUnifiedDiff(a, b, path) {
  const aLines = a === "" ? [] : a.split("\n");
  const bLines = b === "" ? [] : b.split("\n");
  if (aLines.length === 0 && bLines.length === 0) return "";

  const m = aLines.length;
  const n = bLines.length;

  if (m > MAX_DIFF_LINES || n > MAX_DIFF_LINES) {
    const out = [`--- ${path}`, `+++ ${path}`];
    if (m === 0) {
      out.push(`@@ -0,0 +1,${n} @@`);
      return out.concat(bLines.map((l) => "+" + l)).join("\n");
    }
    if (n === 0) {
      out.push(`@@ -1,${m} +0,0 @@`);
      return out.concat(aLines.map((l) => "-" + l)).join("\n");
    }
    out.push(`@@ -1,${m} +1,${n} @@ (large diff, ${m} -> ${n} lines)`);
    const sample = [];
    const maxSample = Math.min(m, n, 6);
    for (let i = 0; i < maxSample; i++) {
      if (aLines[i] === bLines[i]) {
        sample.push(" " + aLines[i]);
      } else {
        sample.push("-" + aLines[i]);
        sample.push("+" + bLines[i]);
      }
    }
    if (Math.abs(m - n) > 0 || m > maxSample) {
      sample.push(` ... ${m} lines -> ${n} lines, too large for per-line diff`);
    }
    return out.concat(sample).join("\n");
  }

  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const ai = aLines[i - 1];
    const dpi = dp[i];
    const dpi_1 = dp[i - 1];
    for (let j = 1; j <= n; j++) {
      dpi[j] = ai === bLines[j - 1] ? dpi_1[j - 1] + 1 : Math.max(dpi_1[j], dpi[j - 1]);
    }
  }

  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      ops.push({ t: " ", l: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ t: "+", l: bLines[j - 1] });
      j--;
    } else {
      ops.push({ t: "-", l: aLines[i - 1] });
      i--;
    }
  }
  ops.reverse();

  const out = [`--- ${path}`, `+++ ${path}`];
  const ctx = 3;

  const regions = [];
  let p = 0;
  while (p < ops.length) {
    while (p < ops.length && ops[p].t === " ") p++;
    if (p >= ops.length) break;
    let q = p;
    while (q < ops.length && ops[q].t !== " ") q++;
    regions.push({ start: Math.max(0, p - ctx), end: Math.min(ops.length, q + ctx) });
    p = q;
  }

  const merged = [];
  for (const r of regions) {
    if (merged.length > 0 && r.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  for (const region of merged) {
    let oldLine = 1, newLine = 1;
    for (let k = 0; k < region.start; k++) {
      if (ops[k].t === " " || ops[k].t === "-") oldLine++;
      if (ops[k].t === " " || ops[k].t === "+") newLine++;
    }
    let oldCnt = 0, newCnt = 0;
    for (let k = region.start; k < region.end; k++) {
      if (ops[k].t === " " || ops[k].t === "-") oldCnt++;
      if (ops[k].t === " " || ops[k].t === "+") newCnt++;
    }
    out.push(`@@ -${oldLine},${oldCnt} +${newLine},${newCnt} @@`);
    for (let k = region.start; k < region.end; k++) {
      out.push(ops[k].t + ops[k].l);
    }
  }

  return out.join("\n");
}

function computeFileDiffs(before, after, changes) {
  const fileDiffs = [];
  for (const change of changes) {
    const { path, type } = change;
    const a = before.get(path);
    const b = after.get(path);

    if (type === "added") {
      if (b && b.content !== undefined) {
        fileDiffs.push({
          path,
          type: "added",
          unified_diff: computeUnifiedDiff("", b.content, path),
        });
      } else {
        fileDiffs.push({ path, type: "added", summary: "Binary, large, or unreadable file; diff not computed" });
      }
    } else if (type === "deleted") {
      if (a && a.content !== undefined) {
        fileDiffs.push({
          path,
          type: "deleted",
          unified_diff: computeUnifiedDiff(a.content, "", path),
        });
      } else {
        fileDiffs.push({ path, type: "deleted", summary: "Binary, large, or unreadable file; content not available" });
      }
    } else if (type === "modified") {
      if (a && a.content !== undefined && b && b.content !== undefined) {
        fileDiffs.push({
          path,
          type: "modified",
          unified_diff: computeUnifiedDiff(a.content, b.content, path),
        });
      } else {
        fileDiffs.push({ path, type: "modified", summary: "Large/binary/unreadable file; diff not computed" });
      }
    }
  }
  const diffAvailable = fileDiffs.some((f) => f.unified_diff !== undefined);
  return { fileDiffs, diffAvailable };
}

function buildReviewSummary({ changedFiles, diffAvailable, policy, checks, failureReason, requiresReview, job = null }) {
  const checksPassed = checks.filter((c) => c.exit_code === 0 && !c.timed_out);
  const summary = {
    files_changed: changedFiles.sort(),
    change_count: changedFiles.length,
    policy_ok: policy.ok,
    outside_allowed: policy.outside_allowed ?? [],
    forbidden_changed: policy.forbidden_changed ?? [],
    checks_passed: checksPassed.length,
    checks_count: checks.length,
    requires_review: requiresReview,
    diff_available: diffAvailable,
    failure_reason: failureReason,
    last_error_kind: job?.last_error_kind ?? null,
  };
  return summary;
}

function appendBounded(current, addition) {
  const next = current + addition;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
}

function tail(value) {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(-MAX_OUTPUT_CHARS) : value;
}

function toolResult(value) {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? { server_version: SERVER_VERSION, ...value }
    : { server_version: SERVER_VERSION, value };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function toolErrorResult(error) {
  const payload = {
    server_version: SERVER_VERSION,
    status: "error",
    error: {
      message: error.message,
      data: error.data ?? null,
    },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(error) {
  return {
    message: error.message,
    data: error.data ?? null,
  };
}


