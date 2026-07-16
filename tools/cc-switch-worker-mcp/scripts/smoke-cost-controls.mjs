import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JOB_ROOT } from "../src/core/config.mjs";

const root = mkdtempSync(join(tmpdir(), "cc-switch-worker-cost-controls-"));
const cwd = join(root, "workspace");
const fakeLauncher = join(root, "fake-claude-cc-switch.mjs");
const fakeReadOnlyLauncher = join(root, "fake-read-only-claude-cc-switch.mjs");
const capturePath = join(root, "launcher-capture.json");
const secretFixture = ["sk", "test", "secret", "1234567890"].join("-");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "index.js"), "export const value = 1;\n");
writeFileSync(fakeLauncher, [
  "#!/usr/bin/env node",
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
  "  args: process.argv.slice(2),",
  "  enableToolSearch: process.env.ENABLE_TOOL_SEARCH ?? null,",
  "}));",
  "writeFileSync(join(process.cwd(), 'index.js'), 'export const value = 2;\\n');",
  "console.log(JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'ToolSearch' } }));",
  "console.log(JSON.stringify({ type: 'content_block_stop' }));",
  "console.log(JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_result', name: 'ToolSearch', is_error: false } }));",
  "process.stdout.write(JSON.stringify({",
  "  type: 'result',",
  "  subtype: 'error_max_budget_usd',",
  "  is_error: true,",
  "  result: '',",
  "  total_cost_usd: 0.397102,",
  "  num_turns: 2,",
  "  modelUsage: { 'gateway-reported-model-fixture': { costUSD: 0.397102 } },",
  "}));",
  "const secret = ['sk', 'test', 'secret', '1234567890'].join('-');",
  "console.error(`Authorization: Bearer ${secret}`);",
  "process.exit(1);",
  "",
].join("\n"));
chmodSync(fakeLauncher, 0o755);
writeFileSync(fakeReadOnlyLauncher, [
  "#!/usr/bin/env node",
  "console.log(JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__gbrain__get_page' } }));",
  "console.log(JSON.stringify({ type: 'content_block_stop' }));",
  "console.log(JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_result', name: 'mcp__gbrain__get_page', is_error: false } }));",
  "console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '', total_cost_usd: 0.01, num_turns: 1 }));",
  "process.exit(1);",
  "",
].join("\n"));
chmodSync(fakeReadOnlyLauncher, 0o755);

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ENABLE_TOOL_SEARCH: "true",
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
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  send(2, "tools/call", {
    name: "cc_switch_start_implementation",
    arguments: {
      cwd,
      task: "Apply one bounded low-risk patch.",
      use_case: "fast_patch",
      worker_profile: "scoped_patch",
      allowed_dirs: ["index.js"],
      claude_cc_switch_bin: fakeLauncher,
      timeout_ms: 5000,
    },
  });
  const started = parseToolPayload(await waitForResponseId(2, 5000));
  if (started.job_dir) jobDirsToRemove.push(started.job_dir);

  send(3, "tools/call", {
    name: "cc_switch_wait_for_job",
    arguments: { job_id: started.job_id, max_wait_ms: 5000, poll_interval_ms: 25, include_logs: true },
  });
  const waited = parseToolPayload(await waitForResponseId(3, 7000));
  const capture = existsSync(capturePath) ? JSON.parse(readFileSync(capturePath, "utf8")) : {};
  const args = capture.args ?? [];
  const failures = [];

  assertEqual(failures, "fast patch keeps CC-Switch route", started.model, null);
  assertEqual(failures, "fast patch effort", started.reasoning_effort, "low");
  assertEqual(failures, "fast patch budget", started.max_budget_usd, 0.05);
  assertEqual(failures, "budget source", started.budget_source, "use_case:fast_patch");
  assertEqual(failures, "tool search disabled by default", started.enable_tool_search, false);
  assertArgAbsent(failures, args, "--model");
  assertArgValue(failures, args, "--effort", "low");
  assertArgValue(failures, args, "--max-budget-usd", "0.05");
  assertEqual(failures, "inherited ToolSearch env removed", capture.enableToolSearch, null);
  assertEqual(failures, "job status", waited.status, "partial");
  assertEqual(failures, "result status", waited.result?.status, "partial_worker_limit");
  assertEqual(failures, "failure reason", waited.result?.failure_reason, "budget_exhausted_after_valid_changes");
  assertEqual(failures, "final result subtype", waited.result?.worker?.final_result_subtype, "error_max_budget_usd");
  assertEqual(failures, "observed cost", waited.result?.worker?.total_cost_usd, 0.397102);
  assertEqual(failures, "final text absent", waited.result?.worker?.final_text_present, false);
  if ((waited.result?.worker?.successful_tool_count ?? 0) < 1) {
    failures.push({ name: "successful tool execution retained", actual: waited.result?.worker });
  }
  if (!waited.result?.worker?.models_used?.includes("gateway-reported-model-fixture")) {
    failures.push({ name: "result-event model identifier retained", actual: waited.result?.worker?.models_used });
  }
  const persistedLogs = `${waited.result?.worker?.stdout_tail ?? ""}\n${waited.result?.worker?.stderr_tail ?? ""}`;
  if (persistedLogs.includes(secretFixture) || !persistedLogs.includes("<redacted>")) {
    failures.push({ name: "persisted worker logs redact secrets", actual: persistedLogs });
  }

  send(4, "tools/call", {
    name: "cc_switch_start_implementation",
    arguments: {
      cwd,
      task: "Run one read-only GBrain verification.",
      use_case: "simple_agent_task",
      worker_profile: "review",
      claude_cc_switch_bin: fakeReadOnlyLauncher,
      timeout_ms: 5000,
    },
  });
  const readOnlyStarted = parseToolPayload(await waitForResponseId(4, 5000));
  if (readOnlyStarted.job_dir) jobDirsToRemove.push(readOnlyStarted.job_dir);
  send(5, "tools/call", {
    name: "cc_switch_wait_for_job",
    arguments: { job_id: readOnlyStarted.job_id, max_wait_ms: 5000, poll_interval_ms: 25 },
  });
  const readOnlyWaited = parseToolPayload(await waitForResponseId(5, 7000));
  assertEqual(failures, "read-only limit remains terminal", readOnlyWaited.status, "failed");
  assertEqual(failures, "read-only tool success gets specific reason", readOnlyWaited.result?.failure_reason, "turn_limit_after_tool_success");
  assertEqual(failures, "read-only final text absent", readOnlyWaited.result?.worker?.final_text_present, false);
  if ((readOnlyWaited.result?.worker?.successful_tool_count ?? 0) < 1) {
    failures.push({ name: "read-only successful tool retained", actual: readOnlyWaited.result?.worker });
  }

  console.log(JSON.stringify({
    requested_model: started.model ?? null,
    reasoning_effort: started.reasoning_effort ?? null,
    max_budget_usd: started.max_budget_usd ?? null,
    enable_tool_search: started.enable_tool_search ?? null,
    result_status: waited.result?.status ?? null,
    failure_reason: waited.result?.failure_reason ?? null,
    total_cost_usd: waited.result?.worker?.total_cost_usd ?? null,
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

function assertEqual(failures, name, actual, expected) {
  if (actual !== expected) failures.push({ name, expected, actual });
}

function assertArgValue(failures, args, name, expected) {
  const index = args.indexOf(name);
  const actual = index >= 0 ? args[index + 1] : null;
  assertEqual(failures, `launcher ${name}`, actual, expected);
}

function assertArgAbsent(failures, args, name) {
  if (args.includes(name)) failures.push({ name: `launcher omits ${name}`, actual: args });
}

function send(id, method, params = {}) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
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
    }, 25);
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
