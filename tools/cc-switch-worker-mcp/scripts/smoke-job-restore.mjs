import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JOB_ROOT, USE_CASES } from "../src/core/config.mjs";

const jobId = "ccsw_restore_smoke";
const runningJobId = "ccsw_running_no_wait_smoke";
const jobDir = join(JOB_ROOT, jobId);
const runningJobDir = join(JOB_ROOT, runningJobId);
const cwd = join(tmpdir(), "cc-switch-worker-restore-smoke");

rmSync(jobDir, { recursive: true, force: true });
rmSync(runningJobDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
mkdirSync(jobDir, { recursive: true });
mkdirSync(runningJobDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
const runningPlaceholder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "ignore",
});

writeFileSync(join(cwd, "sample.js"), "export const value = 2;\n");
writeFileSync(join(jobDir, "before-snapshot.json"), JSON.stringify([
  [
    "sample.js",
    {
      kind: "file",
      size: 24,
      hash: "smoke-before",
      content: "export const value = 1;\n",
    },
  ],
]));
writeFileSync(join(jobDir, "status.json"), JSON.stringify({
  id: jobId,
  status: "running",
  started_at: new Date(Date.now() - 60_000).toISOString(),
  updated_at: new Date(Date.now() - 30_000).toISOString(),
  cwd,
  use_case: "auto",
  worker_profile: "implementation",
  permission_mode: "acceptEdits",
  phase: "model_running",
  phase_message: "restore smoke",
  process_alive: true,
  process_pid: 99999999,
  output_format: "stream-json",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: [],
  allow_docs_only: false,
  result: {
    status: "failed",
    files_changed: ["sample.js"],
    file_diffs: [
      {
        path: "sample.js",
        type: "modified",
        unified_diff: "--- a/sample.js\n+++ b/sample.js\n",
      },
    ],
    checks_run: [
      {
        command: "node --check sample.js",
        exit_code: 1,
        timed_out: false,
        stdout_tail: "large stdout should be hidden by default",
        stderr_tail: "large stderr should be hidden by default",
      },
    ],
    worker: {
      exit_code: 1,
      timed_out: false,
      cancelled: false,
      stdout_tail: "large worker stdout should be hidden by default",
      stderr_tail: "large worker stderr should be hidden by default",
    },
  },
}, null, 2));
writeFileSync(join(runningJobDir, "before-snapshot.json"), JSON.stringify([
  [
    "sample.js",
    {
      kind: "file",
      size: 24,
      hash: "smoke-before",
      content: "export const value = 1;\n",
    },
  ],
]));
writeFileSync(join(runningJobDir, "status.json"), JSON.stringify({
  id: runningJobId,
  status: "running",
  started_at: new Date(Date.now() - 60_000).toISOString(),
  updated_at: new Date(Date.now() - 30_000).toISOString(),
  cwd,
  use_case: "auto",
  worker_profile: "implementation",
  permission_mode: "acceptEdits",
  phase: "model_running",
  phase_message: "running no-wait smoke",
  process_alive: true,
  process_pid: runningPlaceholder.pid,
  output_format: "stream-json",
  pending_tool_use: "Read",
  last_tool_use_at: new Date(Date.now() - 120_000).toISOString(),
  last_tool_name: "Read",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: [],
  allow_docs_only: false,
}, null, 2));

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let stderr = "";
createInterface({ input: server.stdout }).on("line", (line) => {
  if (line.trim()) responses.push(JSON.parse(line));
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} });
await waitForResponseId(1, 5000);
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
send(2, "tools/call", {
  name: "cc_switch_get_job",
  arguments: { job_id: jobId },
});
send(3, "tools/call", {
  name: "cc_switch_wait_for_job",
  arguments: { job_id: jobId, max_wait_ms: 10 },
});
send(4, "tools/call", {
  name: "cc_switch_wait_for_job",
  arguments: { job_id: jobId },
});
send(5, "tools/call", {
  name: "cc_switch_wait_for_job",
  arguments: { job_id: runningJobId },
});
send(6, "tools/call", {
  name: "cc_switch_get_job",
  arguments: { job_id: jobId, include_logs: true, include_events: true, include_diff: true },
});

const getJobResponse = await waitForResponseId(2, 5000);
const getJob = parseToolPayload(getJobResponse);
const waitJob = parseToolPayload(await waitForResponseId(3, 5000));
const noWaitJob = parseToolPayload(await waitForResponseId(4, 5000));
const runningNoWaitJob = parseToolPayload(await waitForResponseId(5, 5000));
const verboseGetJob = parseToolPayload(await waitForResponseId(6, 5000));
server.kill("SIGTERM");
runningPlaceholder.kill("SIGTERM");
rmSync(jobDir, { recursive: true, force: true });
rmSync(runningJobDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });

console.log(JSON.stringify({
  get_status: getJob.status,
  get_has_structured_content: getJobResponse.result?.structuredContent?.server_version != null,
  wait_status: waitJob.status,
  wait_reason: waitJob.reason,
  no_wait_status: noWaitJob.status,
  no_wait_reason: noWaitJob.reason,
  running_no_wait_status: runningNoWaitJob.status,
  running_no_wait_reason: runningNoWaitJob.reason,
  restored_progress_source: getJob.progress?.progress_source ?? null,
  restored_health_state: getJob.progress?.health?.state ?? null,
  running_health_state: runningNoWaitJob.progress?.health?.state ?? null,
  default_get_has_logs: hasKeyDeep(getJob, "stdout_tail") || hasKeyDeep(getJob, "stderr_tail"),
  default_get_has_events: hasKeyDeep(getJob, "recent_events"),
  default_get_has_diffs: hasKeyDeep(getJob, "file_diffs"),
  default_get_has_poll_hint: hasKeyDeep(getJob, "recommended_poll_after_ms") || hasKeyDeep(getJob, "next_poll"),
  default_get_has_tool_debug: hasKeyDeep(getJob, "pending_tool_duration_seconds") || hasKeyDeep(getJob, "tool_calls_since_last_change"),
  verbose_get_has_logs: hasKeyDeep(verboseGetJob, "stdout_tail") && hasKeyDeep(verboseGetJob, "stderr_tail"),
  verbose_get_has_events: hasKeyDeep(verboseGetJob, "recent_events"),
  verbose_get_has_diffs: hasKeyDeep(verboseGetJob, "file_diffs"),
  changed_files: getJob.progress?.changed_files_so_far ?? [],
  auto_reasoning_effort: USE_CASES.auto.reasoning_effort,
}, null, 2));

if (stderr) process.stderr.write(stderr);
if (
  getJob.status !== "orphaned"
  || getJobResponse.result?.structuredContent?.server_version == null
  || hasKeyDeep(getJob, "observed_state")
  || waitJob.status !== "orphaned"
  || waitJob.reason !== "orphaned_after_mcp_restart"
  || noWaitJob.status !== "orphaned"
  || noWaitJob.reason !== "orphaned_after_mcp_restart"
  || runningNoWaitJob.status !== "running"
  || runningNoWaitJob.reason !== "no_wait_requested"
  || getJob.progress?.progress_source !== "persisted_result"
  || getJob.progress?.health?.state !== "orphaned_after_restart"
  || runningNoWaitJob.progress?.health?.state !== "pending_tool_quiet"
  || hasKeyDeep(getJob, "stdout_tail")
  || hasKeyDeep(getJob, "stderr_tail")
  || hasKeyDeep(getJob, "recent_events")
  || hasKeyDeep(getJob, "file_diffs")
  || hasKeyDeep(getJob, "recommended_poll_after_ms")
  || hasKeyDeep(getJob, "next_poll")
  || hasKeyDeep(getJob, "pending_tool_duration_seconds")
  || hasKeyDeep(getJob, "tool_calls_since_last_change")
  || !hasKeyDeep(verboseGetJob, "stdout_tail")
  || !hasKeyDeep(verboseGetJob, "stderr_tail")
  || !hasKeyDeep(verboseGetJob, "recent_events")
  || !hasKeyDeep(verboseGetJob, "file_diffs")
  || !getJob.progress?.changed_files_so_far?.includes("sample.js")
  || USE_CASES.auto.reasoning_effort !== "max"
) {
  process.exitCode = 1;
}

function send(id, method, params = {}) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}

function parseToolPayload(response) {
  const text = response.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

function hasKeyDeep(value, key) {
  if (value == null || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  if (Array.isArray(value)) return value.some((item) => hasKeyDeep(item, key));
  return Object.values(value).some((item) => hasKeyDeep(item, key));
}

function waitForResponseId(id, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      const response = responses.find((item) => item.id === id);
      if (response) {
        clearInterval(interval);
        resolvePromise(response);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        server.kill("SIGTERM");
        reject(new Error(`Timed out waiting for response ${id}`));
      }
    }, 50);
  });
}
