import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JOB_ROOT } from "../src/core/config.mjs";

const root = mkdtempSync(join(tmpdir(), "cc-switch-worker-policy-boundary-"));
const cwd = join(root, "workspace");
const fakeLauncher = join(root, "fake-claude-cc-switch.mjs");

mkdirSync(join(cwd, "allowed"), { recursive: true });
writeFileSync(join(cwd, "allowed", "index.js"), "export const allowed = 1;\n");
writeFileSync(join(cwd, "outside.js"), "export const outside = 1;\n");
writeFileSync(fakeLauncher, [
  "#!/usr/bin/env node",
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "writeFileSync(join(process.cwd(), 'allowed', 'index.js'), 'export const allowed = 2;\\n');",
  "writeFileSync(join(process.cwd(), 'outside.js'), 'export const outside = 2;\\n');",
  "process.exit(1);",
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
      task: "policy boundary smoke: modify allowed/index.js and outside.js",
      use_case: "fast_patch",
      worker_profile: "scoped_patch",
      allowed_dirs: ["allowed"],
      forbidden_paths: [],
      claude_cc_switch_bin: fakeLauncher,
      timeout_ms: 5000,
    },
  });
  const started = parseToolPayload(await waitForResponseId(2, 5000));
  if (started.job_dir) jobDirsToRemove.push(started.job_dir);

  send(3, "tools/call", {
    name: "cc_switch_wait_for_job",
    arguments: { job_id: started.job_id, max_wait_ms: 5000, poll_interval_ms: 50, include_diff: true },
  });
  const waited = parseToolPayload(await waitForResponseId(3, 7000));

  send(4, "tools/call", {
    name: "cc_switch_diagnose_job",
    arguments: { job_id: started.job_id },
  });
  const diagnosed = parseToolPayload(await waitForResponseId(4, 5000));

  const failures = [];
  const policy = waited.result?.policy ?? {};
  const outside = policy.outside_allowed ?? [];
  const findingCodes = diagnosed.diagnosis?.findings?.map((finding) => finding.code) ?? [];

  if (waited.status !== "failed" || waited.result?.failure_reason !== "changed_outside_allowed_dirs") {
    failures.push({ name: "outside allowed dirs fails terminal result", actual: waited });
  }
  if (policy.ok !== false || !outside.includes("outside.js")) {
    failures.push({ name: "policy records outside_allowed", actual: policy });
  }
  if ((policy.forbidden_changed ?? []).length !== 0) {
    failures.push({ name: "outside-only change is not forbidden change", actual: policy.forbidden_changed });
  }
  if (!findingCodes.includes("outside_allowed_dirs_changed")) {
    failures.push({ name: "diagnosis includes outside allowed finding", actual: diagnosed.diagnosis });
  }
  if (waited.result?.checks_run?.length !== 0) {
    failures.push({ name: "checks skipped when policy fails", actual: waited.result?.checks_run });
  }

  console.log(JSON.stringify({
    waited_status: waited.status,
    failure_reason: waited.result?.failure_reason ?? null,
    policy_ok: policy.ok,
    outside_allowed: outside,
    finding_codes: findingCodes,
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
