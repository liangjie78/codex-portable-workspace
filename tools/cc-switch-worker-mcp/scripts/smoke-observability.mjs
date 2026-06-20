import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_FAST_PATCH_TIMEOUT_MS, JOB_ROOT } from "../src/core/config.mjs";

const root = mkdtempSync(join(tmpdir(), "cc-switch-worker-observability-"));
const cwd = join(root, "workspace");
const fakeLauncher = join(root, "fake-claude-cc-switch.mjs");
writeFileSync(fakeLauncher, [
  "#!/usr/bin/env node",
  "let prompt = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { prompt += chunk; });",
  "process.stdin.on('end', () => {",
  "  if (prompt.includes('sleep without output')) {",
  "    setTimeout(() => process.exit(0), 450);",
  "  } else {",
  "    process.exit(0);",
  "  }",
  "});",
  "",
].join("\n"));
chmodSync(fakeLauncher, 0o755);
writeFileSync(join(root, "placeholder.txt"), "root\n");
writeFileSync(join(root, "workspace-marker.txt"), "root\n");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "index.js"), "export const value = 1;\n");

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CC_SWITCH_WORKER_HEARTBEAT_INTERVAL_MS: "100",
  },
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
      task: "sleep without output; do not edit files",
      use_case: "fast_patch",
      worker_profile: "scoped_patch",
      allowed_dirs: ["."],
      claude_cc_switch_bin: fakeLauncher,
      timeout_ms: 1000,
      idle_after_ms: 100,
    },
  });
  const startJob = parseToolPayload(await waitForResponseId(2, 15000));
  if (startJob.job_dir) jobDirsToRemove.push(startJob.job_dir);
  await sleep(260);
  send(3, "tools/call", {
    name: "cc_switch_get_job",
    arguments: { job_id: startJob.job_id },
  });
  const runningJob = parseToolPayload(await waitForResponseId(3, 15000));
  send(4, "tools/call", {
    name: "cc_switch_wait_for_job",
    arguments: { job_id: startJob.job_id, max_wait_ms: 2000, poll_interval_ms: 100 },
  });
  const finishedJob = parseToolPayload(await waitForResponseId(4, 15000));

  send(5, "tools/call", {
    name: "cc_switch_start_implementation",
    arguments: {
      cwd,
      task: "quick no-op for default timeout check",
      use_case: "fast_patch",
      worker_profile: "scoped_patch",
      allowed_dirs: ["."],
      claude_cc_switch_bin: fakeLauncher,
    },
  });
  const defaultTimeoutJob = parseToolPayload(await waitForResponseId(5, 15000));
  if (defaultTimeoutJob.job_dir) jobDirsToRemove.push(defaultTimeoutJob.job_dir);

  const failures = [];
  if (startJob.status !== "started") failures.push({ name: "start status", actual: startJob.status });
  if (runningJob.progress?.health?.heartbeat_count < 1) {
    failures.push({ name: "heartbeat count", actual: runningJob.progress?.health });
  }
  if (runningJob.progress?.health?.state !== "waiting_for_first_output") {
    failures.push({ name: "no-output health state", actual: runningJob.progress?.health });
  }
  if (runningJob.progress?.health?.timeout_remaining_ms == null) {
    failures.push({ name: "timeout remaining visible", actual: runningJob.progress?.health });
  }
  if (finishedJob.status !== "failed" || finishedJob.result?.failure_reason !== "no_code_changed") {
    failures.push({ name: "no-change terminal state", actual: { status: finishedJob.status, reason: finishedJob.result?.failure_reason } });
  }
  if (defaultTimeoutJob.timeout_ms !== DEFAULT_FAST_PATCH_TIMEOUT_MS || defaultTimeoutJob.timeout_source !== "use_case:fast_patch") {
    failures.push({
      name: "fast_patch default timeout",
      expected: { timeout_ms: DEFAULT_FAST_PATCH_TIMEOUT_MS, timeout_source: "use_case:fast_patch" },
      actual: { timeout_ms: defaultTimeoutJob.timeout_ms, timeout_source: defaultTimeoutJob.timeout_source },
    });
  }

  console.log(JSON.stringify({
    heartbeat_count: runningJob.progress?.health?.heartbeat_count ?? null,
    health_state: runningJob.progress?.health?.state ?? null,
    timeout_source: defaultTimeoutJob.timeout_source,
    finished_status: finishedJob.status,
    failures,
  }, null, 2));
  if (stderr) process.stderr.write(stderr);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await waitForServerClose();
  for (const jobDir of jobDirsToRemove) {
    if (isInside(JOB_ROOT, jobDir)) {
      rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
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

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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
