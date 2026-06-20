import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JOB_ROOT } from "../src/core/config.mjs";

const root = mkdtempSync(join(tmpdir(), "cc-switch-worker-partial-status-"));
const cwd = join(root, "workspace");
const fakeLauncher = join(root, "fake-claude-cc-switch.mjs");

mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: "module" }, null, 2));
writeFileSync(join(cwd, "index.js"), "export const value = 1;\n");
writeFileSync(fakeLauncher, [
  "#!/usr/bin/env node",
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "writeFileSync(join(process.cwd(), 'index.js'), 'export const value = 2;\\n');",
  "setTimeout(() => {}, 60000);",
  "",
].join("\n"));
chmodSync(fakeLauncher, 0o755);

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let stderr = "";
const jobDirsToRemove = [];

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
    name: "cc_switch_start_implementation",
    arguments: {
      cwd,
      task: "partial status smoke: change index.js, then run long enough to trigger caller timeout",
      use_case: "fast_patch",
      worker_profile: "scoped_patch",
      allowed_dirs: ["index.js"],
      checks: ["node --check index.js"],
      claude_cc_switch_bin: fakeLauncher,
      timeout_ms: 500,
      check_timeout_ms: 5000,
    },
  });
  const started = parseToolPayload(await waitForResponseId(2, 5000));
  if (started.job_dir) jobDirsToRemove.push(started.job_dir);

  send(3, "tools/call", {
    name: "cc_switch_wait_for_job",
    arguments: { job_id: started.job_id, max_wait_ms: 5000, poll_interval_ms: 50, include_logs: true },
  });
  const waited = parseToolPayload(await waitForResponseId(3, 7000));

  send(4, "tools/call", {
    name: "cc_switch_list_jobs",
    arguments: { status: "partial", limit: 20 },
  });
  const partialList = parseToolPayload(await waitForResponseId(4, 5000));

  const statusText = readFileSync(join(started.job_dir, "status.json"), "utf8");
  const persisted = JSON.parse(statusText);
  const failures = [];

  if (waited.status !== "partial" || waited.reason !== "job_partial") {
    failures.push({ name: "wait reports partial", actual: waited.status, reason: waited.reason });
  }
  if (waited.result?.status !== "partial_caller_timeout" || waited.result?.failure_reason !== "caller_timeout_after_valid_changes") {
    failures.push({ name: "result remains explicit partial timeout", actual: waited.result });
  }
  if (persisted.status !== "partial" || persisted.phase !== "partial") {
    failures.push({ name: "persisted job status is partial", actual: { status: persisted.status, phase: persisted.phase } });
  }
  if (!(partialList.jobs ?? []).some((job) => job.job_id === started.job_id && job.status === "partial")) {
    failures.push({ name: "list status filter finds partial job", actual: partialList.jobs });
  }
  if (!waited.result?.checks_run?.some((check) => check.command === "node --check index.js" && check.exit_code === 0)) {
    failures.push({ name: "checks run after partial valid change", actual: waited.result?.checks_run });
  }

  console.log(JSON.stringify({
    waited_status: waited.status,
    result_status: waited.result?.status ?? null,
    failure_reason: waited.result?.failure_reason ?? null,
    persisted_status: persisted.status,
    partial_list_count: partialList.jobs?.length ?? 0,
    failures,
  }, null, 2));
  if (stderr) process.stderr.write(stderr);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await waitForServerClose();
  for (const jobDir of jobDirsToRemove) {
    if (isInside(JOB_ROOT, jobDir)) rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function send(id, method, params = {}) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
}

function parseToolPayload(response) {
  const text = response.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
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
