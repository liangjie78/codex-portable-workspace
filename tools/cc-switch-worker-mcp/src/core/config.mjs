import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const SERVER_VERSION = "0.4.5-rc.1";
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SELF_SCRIPT = resolve(process.argv[1] ?? "cc-switch-worker-mcp.mjs");
export const DEFAULT_CLAUDE_CC_SWITCH = resolve(PACKAGE_ROOT, "bin/claude-cc-switch.mjs");
export const DEFAULT_SYNC_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_FOREGROUND_WAIT_CAP_MS = 10 * 60 * 1000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = positiveEnvNumber("CC_SWITCH_WORKER_HEARTBEAT_INTERVAL_MS", 15 * 1000);
export const DEFAULT_FAST_PATCH_TIMEOUT_MS = 120 * 1000;
export const DEFAULT_SIMPLE_TASK_TIMEOUT_MS = 180 * 1000;
export const DEFAULT_SCAFFOLD_TIMEOUT_MS = 300 * 1000;
export const DEEP_THINKING_IDLE_AFTER_MS = 90 * 1000;
export const DEFAULT_IDLE_AFTER_MS = 45 * 1000;
export const DEFAULT_QUIET_AFTER_TOOL_USE_WITHOUT_RESULT_MS = 4 * 60 * 1000;
export const DEFAULT_QUIET_AFTER_FILE_CHANGE_MS = 10 * 60 * 1000;
export const DEFAULT_NO_CHANGES_AFTER_LONG_RUN_MS = 12 * 60 * 1000;
export const DEFAULT_REASONING_EFFORT = "max";
export const MAX_OUTPUT_CHARS = 20000;
export const MAX_STREAM_EVENTS = 200;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DIFF_CONTENT_BYTES = 1024 * 1024;
export const MAX_DIFF_LINES = 2000;
export const JOB_ROOT = resolve(tmpdir(), "cc-switch-worker", "jobs");

export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

export const DEFAULT_FORBIDDEN_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".pypirc",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

export const DANGEROUS_BASH_DENY_RULES = [
  "Bash(rm -rf *)",
  "Bash(sudo *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(chmod *)",
  "Bash(chown *)",
  "Bash(git push*)",
  "Bash(npm install*)",
  "Bash(pnpm install*)",
  "Bash(yarn install*)",
];

export const WORKER_PROFILES = {
  implementation: {
    permission_mode: "dontAsk",
    requires_allowed_dirs: false,
    prompt:
      "Worker profile: implementation. You may inspect and edit within the workspace scope, but keep changes focused and verify with requested checks.",
  },
  scoped_patch: {
    permission_mode: "dontAsk",
    requires_allowed_dirs: true,
    prompt:
      "Worker profile: scoped_patch. Make only the requested narrow patch. Use Bash when it is the efficient way to inspect, transform, or validate within scope; use Edit/MultiEdit when they are clearer. MCP still checks final changed files against allowed_dirs/forbidden_paths.",
  },
  review: {
    permission_mode: "dontAsk",
    requires_allowed_dirs: false,
    read_only: true,
    prompt:
      "Worker profile: review. Prefer read-only inspection and report findings; do not edit unless the task explicitly requests a code change.",
  },
  debug_loop: {
    permission_mode: "dontAsk",
    requires_allowed_dirs: false,
    prompt:
      "Worker profile: debug_loop. Reproduce or inspect the failure path, make the smallest fix, and run requested checks.",
  },
};

export const USE_CASES = {
  auto: {
    model: null,
    thinking: "enabled",
    reasoning_effort: "max",
    default_timeout_ms: null,
    idle_after_ms: DEFAULT_IDLE_AFTER_MS,
    verification_profile: "smoke",
    output_format: "stream-json",
    prompt:
      "Use the fast default CC-Switch route first for ordinary implementation. Escalate in-task depth only when the code change is cross-file, ambiguous, or failure-prone.",
  },
  fast_patch: {
    model: null,
    thinking: "disabled",
    reasoning_effort: "high",
    default_timeout_ms: DEFAULT_FAST_PATCH_TIMEOUT_MS,
    idle_after_ms: DEFAULT_IDLE_AFTER_MS,
    verification_profile: "smoke",
    output_format: "stream-json",
    prompt:
      "Optimize for a quick, focused patch. Keep context tight, avoid broad refactors, and make the smallest correct code change.",
  },
  simple_agent_task: {
    model: null,
    thinking: "enabled",
    reasoning_effort: "high",
    default_timeout_ms: DEFAULT_SIMPLE_TASK_TIMEOUT_MS,
    idle_after_ms: DEFAULT_IDLE_AFTER_MS,
    verification_profile: "standard",
    output_format: "stream-json",
    prompt:
      "Handle a straightforward agentic coding task with fast execution. Use tools as needed, but keep the action loop short and concrete.",
  },
  scaffold_or_tests: {
    model: null,
    thinking: "enabled",
    reasoning_effort: "high",
    default_timeout_ms: DEFAULT_SCAFFOLD_TIMEOUT_MS,
    idle_after_ms: DEFAULT_IDLE_AFTER_MS,
    verification_profile: "standard",
    output_format: "stream-json",
    prompt:
      "Focus on scaffolding, integration glue, CRUD-style code, or tests. Follow existing project patterns closely and run the caller's checks when provided.",
  },
  debug_loop: {
    model: null,
    thinking: "enabled",
    reasoning_effort: "max",
    default_timeout_ms: null,
    idle_after_ms: DEEP_THINKING_IDLE_AFTER_MS,
    requires_review: true,
    verification_profile: "debug",
    output_format: "stream-json",
    prompt:
      "Run a structured debugging loop: reproduce or inspect the failure, identify the likely cause before editing, make the smallest targeted fix, then run the requested validation checks. Avoid broad rewrites.",
  },
  agentic_coding: {
    model: null,
    thinking: "enabled",
    reasoning_effort: "max",
    default_timeout_ms: null,
    idle_after_ms: DEEP_THINKING_IDLE_AFTER_MS,
    requires_review: true,
    verification_profile: "standard",
    output_format: "stream-json",
    prompt:
      "Use the stronger default CC-Switch route for agentic coding: inspect the real workspace, reason across files, edit directly, and verify with checks. Complex agentic output should be reviewed before acceptance.",
  },
  complex_reasoning: {
    model: null,
    thinking: "enabled",
    reasoning_effort: "max",
    default_timeout_ms: null,
    idle_after_ms: DEEP_THINKING_IDLE_AFTER_MS,
    requires_review: true,
    verification_profile: "review",
    output_format: "stream-json",
    prompt:
      "Use maximum reasoning for complex code, architecture, STEM-like logic, or failure analysis. Prefer correctness over speed, avoid sweeping rewrites unless requested, and mark output as review-worthy.",
  },
  long_context_codebase: {
    model: null,
    thinking: "enabled",
    reasoning_effort: "max",
    default_timeout_ms: null,
    idle_after_ms: DEEP_THINKING_IDLE_AFTER_MS,
    requires_review: true,
    verification_profile: "review",
    output_format: "stream-json",
    prompt:
      "Lean into long context for broad codebase work. Gather enough surrounding context, but keep edits narrow, summarize large findings before editing, and require review for cross-file changes.",
  },
  docs_generation: {
    model: null,
    thinking: "enabled",
    reasoning_effort: "high",
    default_timeout_ms: null,
    idle_after_ms: DEEP_THINKING_IDLE_AFTER_MS,
    allow_docs_only: true,
    verification_profile: "docs",
    output_format: "stream-json",
    prompt:
      "Use agent/document generation strengths. Documentation-only changes are acceptable when the task asks for documentation.",
  },
};

function positiveEnvNumber(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
