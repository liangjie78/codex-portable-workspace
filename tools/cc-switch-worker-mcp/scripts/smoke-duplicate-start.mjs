import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JOB_ROOT } from "../src/core/config.mjs";

const root = mkdtempSync(join(tmpdir(), "cc-switch-worker-duplicate-start-"));
const cwd = join(root, "workspace");
const fakeLauncher = join(root, "fake-claude-cc-switch.mjs");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "index.js"), "export const value = 1;\n");
writeFileSync(fakeLauncher, [
  "#!/usr/bin/env node",
  "setTimeout(() => process.exit(0), 60000);",
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

  const commonArgs = {
    cwd,
    task: "make the same duplicate-start smoke change",
    use_case: "fast_patch",
    worker_profile: "scoped_patch",
    allowed_dirs: ["."],
    claude_cc_switch_bin: fakeLauncher,
    timeout_ms: 60000,
  };

  send(2, "tools/call", {
    name: "cc_switch_start_implementation",
    arguments: commonArgs,
  });
  const first = parseToolPayload(await waitForResponseId(2, 5000));
  if (first.job_dir) jobDirsToRemove.push(first.job_dir);

  send(3, "tools/call", {
    name: "cc_switch_start_implementation",
    arguments: commonArgs,
  });
  const duplicate = parseToolPayload(await waitForResponseId(3, 5000));

  send(4, "tools/call", {
    name: "cc_switch_start_implementation",
    arguments: { ...commonArgs, allow_parallel: true },
  });
  const parallel = parseToolPayload(await waitForResponseId(4, 5000));
  if (parallel.job_dir) jobDirsToRemove.push(parallel.job_dir);

  send(5, "tools/call", {
    name: "cc_switch_list_jobs",
    arguments: { status: "running", limit: 20 },
  });
  const list = parseToolPayload(await waitForResponseId(5, 5000));

  const failures = [];
  if (first.status !== "started" || !first.task_hash) {
    failures.push({ name: "first job started with task_hash", actual: first });
  }
  if (duplicate.status !== "already_running" || duplicate.existing_job_id !== first.job_id || duplicate.task_hash !== first.task_hash) {
    failures.push({ name: "duplicate start blocked", actual: duplicate, first });
  }
  if (parallel.status !== "started" || parallel.job_id === first.job_id || parallel.task_hash !== first.task_hash) {
    failures.push({ name: "allow_parallel starts second job", actual: parallel, first });
  }
  const matchingRunning = (list.jobs ?? []).filter((job) => job.task_hash === first.task_hash);
  if (matchingRunning.length < 2) {
    failures.push({ name: "list shows parallel duplicate group", actual: list.jobs, task_hash: first.task_hash });
  }

  console.log(JSON.stringify({
    first_status: first.status,
    duplicate_status: duplicate.status,
    parallel_status: parallel.status,
    matching_running_jobs: matchingRunning.length,
    task_hash: first.task_hash,
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
