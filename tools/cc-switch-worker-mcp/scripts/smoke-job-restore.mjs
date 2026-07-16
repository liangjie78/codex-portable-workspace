import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { JOB_ROOT, USE_CASES } from "../src/core/config.mjs";

const jobId = "ccsw_restore_000001";
const runningJobId = "ccsw_running_000002";
const staleRunningJobId = "ccsw_stale_000003";
const expiredJobId = "ccsw_expired_000004";
const escapeLeaf = `ccsw_escape_${process.pid.toString(36).padStart(6, "0").slice(-6)}`;
const jobDir = join(JOB_ROOT, jobId);
const runningJobDir = join(JOB_ROOT, runningJobId);
const staleRunningJobDir = join(JOB_ROOT, staleRunningJobId);
const expiredJobDir = join(JOB_ROOT, expiredJobId);
const escapeJobDir = join(dirname(JOB_ROOT), escapeLeaf);
const cwd = join(tmpdir(), "cc-switch-worker-restore-smoke");

rmSync(jobDir, { recursive: true, force: true });
rmSync(runningJobDir, { recursive: true, force: true });
rmSync(staleRunningJobDir, { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });
mkdirSync(jobDir, { recursive: true });
mkdirSync(runningJobDir, { recursive: true });
mkdirSync(staleRunningJobDir, { recursive: true });
mkdirSync(expiredJobDir, { recursive: true });
mkdirSync(escapeJobDir, { recursive: true });
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
writeFileSync(join(staleRunningJobDir, "before-snapshot.json"), JSON.stringify([]));
writeFileSync(join(staleRunningJobDir, "status.json"), JSON.stringify({
  id: staleRunningJobId,
  status: "running",
  started_at: new Date(Date.now() - 86_500_000).toISOString(),
  updated_at: new Date().toISOString(),
  last_heartbeat_at: new Date(Date.now() - 86_400_000).toISOString(),
  cwd,
  use_case: "auto",
  worker_profile: "implementation",
  permission_mode: "acceptEdits",
  phase: "model_running",
  phase_message: "stale running smoke",
  process_alive: true,
  process_pid: runningPlaceholder.pid,
  output_format: "stream-json",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: [],
  allow_docs_only: false,
}, null, 2));
writeFileSync(join(expiredJobDir, "status.json"), JSON.stringify({
  id: expiredJobId,
  status: "completed",
  started_at: new Date(Date.now() - 120_000).toISOString(),
  updated_at: new Date(Date.now() - 120_000).toISOString(),
  cwd,
}, null, 2));
writeFileSync(join(escapeJobDir, "status.json"), JSON.stringify({
  id: escapeLeaf,
  status: "completed",
  started_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  cwd,
}, null, 2));

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, CC_SWITCH_WORKER_JOB_TTL_MS: "60000" },
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
send(7, "tools/call", {
  name: "cc_switch_get_job",
  arguments: { job_id: staleRunningJobId },
});
const invalidJobIds = [
  `..\\${escapeLeaf}`,
  `../${escapeLeaf}`,
  `..//${escapeLeaf}`,
  escapeJobDir,
];
send(8, "tools/call", { name: "cc_switch_get_job", arguments: { job_id: invalidJobIds[0] } });
send(9, "tools/call", { name: "cc_switch_diagnose_job", arguments: { job_id: invalidJobIds[1] } });
send(10, "tools/call", { name: "cc_switch_tail_job", arguments: { job_id: invalidJobIds[2] } });
send(11, "tools/call", { name: "cc_switch_wait_for_job", arguments: { job_id: invalidJobIds[0], max_wait_ms: 1 } });
send(12, "tools/call", { name: "cc_switch_cancel_job", arguments: { job_id: invalidJobIds[1] } });
send(13, "tools/call", { name: "cc_switch_get_job", arguments: { job_id: invalidJobIds[3] } });
send(14, "tools/call", { name: "cc_switch_list_jobs", arguments: {} });

const getJobResponse = await waitForResponseId(2, 5000);
const getJob = parseToolPayload(getJobResponse);
const waitJob = parseToolPayload(await waitForResponseId(3, 5000));
const noWaitJob = parseToolPayload(await waitForResponseId(4, 5000));
const runningNoWaitJob = parseToolPayload(await waitForResponseId(5, 5000));
const verboseGetJob = parseToolPayload(await waitForResponseId(6, 5000));
const staleRestoredJob = parseToolPayload(await waitForResponseId(7, 5000));
const invalidResponses = [];
for (let id = 8; id <= 13; id++) invalidResponses.push(await waitForResponseId(id, 5000));
const afterCleanup = parseToolPayload(await waitForResponseId(14, 5000));
runningPlaceholder.kill("SIGTERM");
await waitForChildClose(runningPlaceholder);
send(15, "tools/call", {
  name: "cc_switch_get_job",
  arguments: { job_id: runningJobId },
});
const exitedRestoredJob = parseToolPayload(await waitForResponseId(15, 5000));
server.kill("SIGTERM");
rmSync(jobDir, { recursive: true, force: true });
rmSync(runningJobDir, { recursive: true, force: true });
rmSync(staleRunningJobDir, { recursive: true, force: true });
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
  stale_restored_status: staleRestoredJob.status,
  exited_restored_status: exitedRestoredJob.status,
  exited_restored_health_state: exitedRestoredJob.progress?.health?.state ?? null,
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
  invalid_job_ids_rejected: invalidResponses.map(isToolRejected),
  expired_job_removed: !existsSync(expiredJobDir),
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
  || staleRestoredJob.status !== "orphaned"
  || exitedRestoredJob.status !== "orphaned"
  || exitedRestoredJob.progress?.health?.state !== "orphaned_after_restart"
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
  || USE_CASES.auto.reasoning_effort !== "high"
  || invalidResponses.some((response) => !isToolRejected(response))
  || existsSync(expiredJobDir)
  || afterCleanup.jobs?.some((job) => job.job_id === expiredJobId)
) {
  process.exitCode = 1;
}
rmSync(expiredJobDir, { recursive: true, force: true });
rmSync(escapeJobDir, { recursive: true, force: true });

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

function isToolRejected(response) {
  return Boolean(response.error || response.result?.isError);
}

function waitForChildClose(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("close", resolvePromise));
}
