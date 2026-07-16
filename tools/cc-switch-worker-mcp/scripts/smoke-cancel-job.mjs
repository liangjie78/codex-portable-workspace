import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JOB_ROOT } from "../src/core/config.mjs";

const root = mkdtempSync(join(tmpdir(), "cc-switch-worker-cancel-"));
const cwd = join(root, "workspace");
const fakeClaude = join(root, "fake-claude.mjs");
const childPidPath = join(root, "child.pid");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "index.js"), "export const value = 1;\n");
writeFileSync(fakeClaude, [
  "#!/usr/bin/env node",
  "import { writeFileSync } from 'node:fs';",
  `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
  "setInterval(() => {}, 1000);",
  "",
].join("\n"));
chmodSync(fakeClaude, 0o755);

const server = spawn(process.execPath, ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CLAUDE_BIN: fakeClaude,
  },
});

const responses = [];
let stderr = "";
let nextId = 1;
let jobDir = null;
let childPid = null;
createInterface({ input: server.stdout }).on("line", (line) => {
  if (line.trim()) responses.push(JSON.parse(line));
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  const initializeId = send("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  await waitForResponseId(initializeId, 5000);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const commonArgs = {
    cwd,
    task: "cancel smoke worker",
    use_case: "fast_patch",
    worker_profile: "scoped_patch",
    allowed_dirs: ["."],
    claude_cc_switch_bin: resolve("bin/claude-cc-switch.mjs"),
    timeout_ms: 60000,
  };

  const blankTask = await callTool("cc_switch_start_implementation", { ...commonArgs, task: "   " });
  const invalidIdle = await callTool("cc_switch_start_implementation", { ...commonArgs, idle_after_ms: 0 });
  const invalidCheckTimeout = await callTool("cc_switch_start_implementation", { ...commonArgs, check_timeout_ms: 0 });
  const started = await callTool("cc_switch_start_implementation", commonArgs);
  jobDir = started.payload.job_dir ?? null;
  await waitFor(() => existsSync(childPidPath), 5000, "fake Claude PID file");
  childPid = Number(readFileSync(childPidPath, "utf8"));

  const cancelled = await callTool("cc_switch_cancel_job", { job_id: started.payload.job_id });
  const terminal = await waitForTerminalJob(started.payload.job_id, 5000);
  await waitFor(() => !processPidAlive(childPid), 5000, "cancelled Claude process exit");

  const failures = [];
  if (!blankTask.response.result?.isError || blankTask.payload.status !== "error") {
    failures.push({ name: "blank task rejected", actual: blankTask.payload });
  }
  if (!invalidIdle.response.result?.isError || invalidIdle.payload.status !== "error") {
    failures.push({ name: "non-positive idle_after_ms rejected", actual: invalidIdle.payload });
  }
  if (!invalidCheckTimeout.response.result?.isError || invalidCheckTimeout.payload.status !== "error") {
    failures.push({ name: "non-positive check_timeout_ms rejected", actual: invalidCheckTimeout.payload });
  }
  if (started.payload.status !== "started") {
    failures.push({ name: "worker started", actual: started.payload });
  }
  if (cancelled.payload.status !== "cancel_requested") {
    failures.push({ name: "cancel requested", actual: cancelled.payload });
  }
  if (terminal.status !== "failed" || terminal.result?.failure_reason !== "worker_cancelled") {
    failures.push({ name: "cancel reaches terminal status", actual: terminal });
  }
  if (processPidAlive(childPid)) {
    failures.push({ name: "launcher forwards cancellation to Claude child", child_pid: childPid });
  }

  console.log(JSON.stringify({
    blank_task_status: blankTask.payload.status,
    invalid_idle_status: invalidIdle.payload.status,
    invalid_check_timeout_status: invalidCheckTimeout.payload.status,
    start_status: started.payload.status,
    cancel_status: cancelled.payload.status,
    terminal_status: terminal.status,
    terminal_failure_reason: terminal.result?.failure_reason ?? null,
    child_process_alive: processPidAlive(childPid),
    failures,
  }, null, 2));
  if (stderr) process.stderr.write(stderr);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  if (childPid && processPidAlive(childPid)) {
    try {
      process.kill(childPid, "SIGKILL");
    } catch {
      // The child can exit during cleanup.
    }
  }
  server.kill("SIGTERM");
  await waitForServerClose();
  if (jobDir && isInside(JOB_ROOT, jobDir)) {
    rmSync(jobDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function send(method, params = {}) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return id;
}

async function callTool(name, args) {
  const id = send("tools/call", { name, arguments: args });
  const response = await waitForResponseId(id, 5000);
  return { response, payload: parseToolPayload(response) };
}

async function waitForTerminalJob(jobId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const { payload } = await callTool("cc_switch_get_job", { job_id: jobId });
    if (!["running", "cancel_requested"].includes(payload.status)) return payload;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for terminal job ${jobId}`);
}

function parseToolPayload(response) {
  return JSON.parse(response.result?.content?.[0]?.text ?? "{}");
}

function waitForResponseId(id, timeoutMs) {
  return waitFor(
    () => responses.find((item) => item.id === id),
    timeoutMs,
    `response ${id}`,
  );
}

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const result = check();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function processPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isInside(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function waitForServerClose() {
  if (server.exitCode != null || server.signalCode != null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 6000);
    timer.unref?.();
    server.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}
