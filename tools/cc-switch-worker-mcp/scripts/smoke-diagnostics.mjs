import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { JOB_ROOT } from "../src/core/config.mjs";

const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const runningJobId = `ccsw_diag_running_${suffix}`;
const orphanJobId = `ccsw_diag_orphan_${suffix}`;
const cancelOrphanJobId = `ccsw_diag_cancel_orphan_${suffix}`;
const failedJobId = `ccsw_diag_failed_${suffix}`;
const partialCompatJobId = `ccsw_diag_partial_${suffix}`;
const jobIds = [runningJobId, orphanJobId, cancelOrphanJobId, failedJobId, partialCompatJobId];
const cwd = join(tmpdir(), `cc-switch-worker-diagnostics-${suffix}`);
const runningPlaceholder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "ignore",
});

mkdirSync(cwd, { recursive: true });
mkdirSync(JOB_ROOT, { recursive: true });
for (const jobId of jobIds) mkdirSync(join(JOB_ROOT, jobId), { recursive: true });

const old = new Date(Date.now() - 5_000).toISOString();
writeStatus(runningJobId, {
  id: runningJobId,
  status: "running",
  started_at: new Date(Date.now() - 20_000).toISOString(),
  updated_at: old,
  cwd,
  use_case: "fast_patch",
  worker_profile: "scoped_patch",
  permission_mode: "dontAsk",
  phase: "model_running",
  phase_message: "diagnostics smoke running",
  process_alive: true,
  process_pid: runningPlaceholder.pid,
  output_format: "stream-json",
  idle_after_ms: 50,
  last_output_at: old,
  last_output_at_ms: Date.parse(old),
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: [],
  allow_docs_only: false,
});
writeFileSync(join(JOB_ROOT, runningJobId, "tool-events.jsonl"), `${JSON.stringify({
  at: old,
  event: "PreToolUse",
  tool_name: "Bash",
  command: "cat src/index.js",
  permission_decision: "deny",
  permission_reason: "Bash command is not an approved check for scoped_patch: cat src/index.js",
})}\n`);

writeStatus(orphanJobId, {
  id: orphanJobId,
  status: "running",
  started_at: new Date(Date.now() - 30_000).toISOString(),
  updated_at: old,
  cwd,
  use_case: "auto",
  worker_profile: "implementation",
  permission_mode: "dontAsk",
  phase: "model_running",
  process_alive: true,
  process_pid: 99999999,
  output_format: "stream-json",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: [],
  allow_docs_only: false,
});

writeStatus(cancelOrphanJobId, {
  id: cancelOrphanJobId,
  status: "cancel_requested",
  cancel_requested: true,
  started_at: new Date(Date.now() - 35_000).toISOString(),
  updated_at: old,
  cwd,
  use_case: "fast_patch",
  worker_profile: "scoped_patch",
  permission_mode: "dontAsk",
  phase: "cancel_requested",
  process_alive: false,
  process_pid: 99999998,
  output_format: "stream-json",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: [],
  allow_docs_only: false,
});

writeStatus(failedJobId, {
  id: failedJobId,
  status: "failed",
  started_at: new Date(Date.now() - 40_000).toISOString(),
  updated_at: old,
  cwd,
  use_case: "fast_patch",
  worker_profile: "scoped_patch",
  permission_mode: "dontAsk",
  phase: "failed",
  process_alive: false,
  output_format: "stream-json",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: ["node --check index.js"],
  allow_docs_only: false,
  result: {
    status: "failed",
    files_changed: [],
    change_count: 0,
    diff_available: false,
    failure_reason: "checks_failed",
    checks_run: [
      { command: "node --check index.js", exit_code: 1, timed_out: false },
    ],
    worker: { exit_code: 0, timed_out: false, cancelled: false },
  },
});

writeStatus(partialCompatJobId, {
  id: partialCompatJobId,
  status: "completed",
  started_at: new Date(Date.now() - 50_000).toISOString(),
  updated_at: old,
  cwd,
  use_case: "fast_patch",
  worker_profile: "scoped_patch",
  permission_mode: "dontAsk",
  phase: "completed",
  process_alive: false,
  output_format: "json",
  ignored_dirs: [".git", "node_modules"],
  allowedRoots: [cwd],
  forbiddenPaths: [],
  checks: [],
  allow_docs_only: false,
  result: {
    status: "partial_cancelled",
    files_changed: ["sample.js"],
    change_count: 1,
    diff_available: true,
    partial: true,
    requires_review: true,
    failure_reason: "cancelled_after_valid_changes",
    policy: {
      ok: true,
      outside_allowed: [],
      forbidden_changed: [],
      docs_only: false,
      allow_docs_only: false,
    },
  },
});

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

try {
  send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  await waitForResponseId(1, 5000);
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  send(2, "tools/call", {
    name: "cc_switch_list_jobs",
    arguments: { limit: 20, status: "all" },
  });
  send(3, "tools/call", {
    name: "cc_switch_diagnose_job",
    arguments: { job_id: runningJobId, include_events: true },
  });
  send(4, "tools/call", {
    name: "cc_switch_diagnose_job",
    arguments: { job_id: orphanJobId },
  });
  send(5, "tools/call", {
    name: "cc_switch_diagnose_job",
    arguments: { job_id: failedJobId },
  });
  send(6, "tools/call", {
    name: "cc_switch_diagnose_job",
    arguments: { job_id: cancelOrphanJobId },
  });
  send(7, "tools/call", {
    name: "cc_switch_list_jobs",
    arguments: { limit: 20, status: "partial", include_health: false },
  });
  send(8, "tools/call", {
    name: "cc_switch_list_jobs",
    arguments: { limit: 20, status: "completed", include_health: false },
  });

  const listJobs = parseToolPayload(await waitForResponseId(2, 5000));
  const runningDiag = parseToolPayload(await waitForResponseId(3, 5000));
  const orphanDiag = parseToolPayload(await waitForResponseId(4, 5000));
  const failedDiag = parseToolPayload(await waitForResponseId(5, 5000));
  const cancelOrphanDiag = parseToolPayload(await waitForResponseId(6, 5000));
  const partialList = parseToolPayload(await waitForResponseId(7, 5000));
  const completedList = parseToolPayload(await waitForResponseId(8, 5000));
  const doctor = runDoctor();

  const failures = [];
  const listedIds = new Set(listJobs.jobs?.map((job) => job.job_id) ?? []);
  if (!jobIds.every((jobId) => listedIds.has(jobId))) {
    failures.push({ name: "list includes synthetic jobs", actual: listJobs.jobs?.map((job) => job.job_id) });
  }
  if (runningDiag.diagnosis?.health_state !== "possible_permission_block") {
    failures.push({ name: "running permission diagnosis", actual: runningDiag.diagnosis });
  }
  if (!hasFinding(runningDiag, "permission_denials_logged")) {
    failures.push({ name: "permission denial finding", actual: runningDiag.diagnosis?.findings });
  }
  if (orphanDiag.job_status !== "orphaned" || !hasFinding(orphanDiag, "orphaned_after_restart")) {
    failures.push({ name: "orphan diagnosis", actual: orphanDiag.diagnosis });
  }
  if (cancelOrphanDiag.job_status !== "orphaned" || !hasFinding(cancelOrphanDiag, "orphaned_after_restart")) {
    failures.push({ name: "cancel-requested orphan diagnosis", actual: cancelOrphanDiag.diagnosis });
  }
  const cancelOrphanListJob = listJobs.jobs?.find((job) => job.job_id === cancelOrphanJobId);
  if (cancelOrphanListJob?.status !== "orphaned") {
    failures.push({ name: "list normalizes dead cancel-requested job", actual: cancelOrphanListJob });
  }
  if (!hasFinding(failedDiag, "checks_failed")) {
    failures.push({ name: "terminal failure diagnosis", actual: failedDiag.diagnosis });
  }
  const partialIds = new Set(partialList.jobs?.map((job) => job.job_id) ?? []);
  if (!partialIds.has(partialCompatJobId)) {
    failures.push({ name: "partial filter includes compatibility job", actual: partialList.jobs });
  }
  const completedIds = new Set(completedList.jobs?.map((job) => job.job_id) ?? []);
  if (completedIds.has(partialCompatJobId)) {
    failures.push({ name: "completed filter excludes compatibility partial job", actual: completedList.jobs });
  }
  if (doctor.status !== 0) {
    failures.push({ name: "doctor exits cleanly", actual: { status: doctor.status, stderr: doctor.stderr } });
  }
  const doctorCompatJob = doctor.payload?.job_root_summary?.newest_jobs?.find((job) => job.job_id === partialCompatJobId);
  const doctorCancelOrphanJob = doctor.payload?.job_root_summary?.newest_jobs?.find((job) => job.job_id === cancelOrphanJobId);
  if (doctorCompatJob?.status !== "partial") {
    failures.push({
      name: "doctor summary normalizes compatibility partial job",
      expected: "partial",
      actual: doctorCompatJob ?? doctor.payload?.job_root_summary?.newest_jobs,
    });
  }
  if (doctorCancelOrphanJob?.status !== "orphaned") {
    failures.push({
      name: "doctor summary normalizes dead cancel-requested job",
      expected: "orphaned",
      actual: doctorCancelOrphanJob ?? doctor.payload?.job_root_summary?.newest_jobs,
    });
  }

  console.log(JSON.stringify({
    listed_synthetic_jobs: jobIds.filter((jobId) => listedIds.has(jobId)).length,
    running_health: runningDiag.diagnosis?.health_state,
    orphan_status: orphanDiag.job_status,
    cancel_orphan_status: cancelOrphanDiag.job_status,
    failed_findings: failedDiag.diagnosis?.findings?.map((finding) => finding.code) ?? [],
    partial_filter_has_compat_job: partialIds.has(partialCompatJobId),
    completed_filter_has_compat_job: completedIds.has(partialCompatJobId),
    doctor_summary_compat_status: doctorCompatJob?.status ?? null,
    doctor_summary_cancel_orphan_status: doctorCancelOrphanJob?.status ?? null,
    failures,
  }, null, 2));
  if (stderr) process.stderr.write(stderr);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  runningPlaceholder.kill("SIGTERM");
  await waitForServerClose();
  for (const jobId of jobIds) {
    const jobDir = join(JOB_ROOT, jobId);
    if (isInside(JOB_ROOT, jobDir)) rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function writeStatus(jobId, data) {
  writeFileSync(join(JOB_ROOT, jobId, "status.json"), JSON.stringify(data, null, 2));
}

function hasFinding(payload, code) {
  return (payload.diagnosis?.findings ?? []).some((finding) => finding.code === code);
}

function send(id, method, params = {}) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}

function parseToolPayload(response) {
  const text = response.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

function runDoctor() {
  const result = spawnSync("node", ["src/cc-switch-worker-mcp.mjs", "--doctor"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10000,
  });
  let payload = null;
  if (result.stdout.trim()) {
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      payload = null;
    }
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    payload,
  };
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

function isInside(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function waitForServerClose() {
  if (server.exitCode != null || server.signalCode != null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 1000);
    timer.unref?.();
    server.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}
