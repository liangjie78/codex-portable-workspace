import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JOB_ROOT } from "../src/core/config.mjs";

const root = mkdtempSync(join(tmpdir(), "cc-switch-worker-safe-settings-"));
const cwd = join(root, "workspace");
const fakeLauncher = join(root, "fake-claude-cc-switch.mjs");
const argsOut = join(root, "launcher-args.json");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "index.js"), "export const value = 1;\n");
writeFileSync(fakeLauncher, [
  "#!/usr/bin/env node",
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync(process.env.CC_SWITCH_SAFE_SETTINGS_ARGS, JSON.stringify(process.argv.slice(2)));",
  "setTimeout(() => process.exit(0), 50);",
  "",
].join("\n"));
chmodSync(fakeLauncher, 0o755);

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CC_SWITCH_SAFE_SETTINGS_ARGS: argsOut,
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
      task: "safe settings smoke should not need real model work",
      use_case: "fast_patch",
      worker_profile: "scoped_patch",
      allowed_dirs: ["."],
      checks: ["node --check index.js"],
      claude_cc_switch_bin: fakeLauncher,
      permission_mode: "acceptEdits",
      safety_mode: "safe",
      timeout_ms: 5000,
    },
  });
  const started = parseToolPayload(await waitForResponseId(2, 5000));
  if (started.job_dir) jobDirsToRemove.push(started.job_dir);

  send(3, "tools/call", {
    name: "cc_switch_wait_for_job",
    arguments: { job_id: started.job_id, max_wait_ms: 5000, poll_interval_ms: 50, include_logs: true },
  });
  const waited = parseToolPayload(await waitForResponseId(3, 7000));

  const launcherArgs = existsSync(argsOut) ? JSON.parse(readFileSync(argsOut, "utf8")) : [];
  const settingsIndex = launcherArgs.indexOf("--settings");
  const settingsArg = settingsIndex >= 0 ? launcherArgs[settingsIndex + 1] : null;
  const settings = settingsArg && existsSync(settingsArg)
    ? JSON.parse(readFileSync(settingsArg, "utf8"))
    : null;
  const failures = [];

  if (started.status !== "started" || started.permission_mode !== "acceptEdits" || started.safety_mode !== "safe") {
    failures.push({ name: "job starts with acceptEdits safe mode", actual: started });
  }
  if (started.claude_settings_active !== true) {
    failures.push({ name: "safe mode injects settings for acceptEdits", actual: started.claude_settings_active });
  }
  if (!settings?.permissions?.allow?.includes("Bash(node --check index.js)")) {
    failures.push({ name: "requested check is allow-listed", actual: settings?.permissions?.allow });
  }
  if (settings?.permissions?.allow?.includes("Bash(rg *)") || settings?.permissions?.allow?.includes("Bash(sed -n *)")) {
    failures.push({ name: "safe mode does not allow broad readonly Bash", actual: settings?.permissions?.allow });
  }
  if (!Array.isArray(settings?.hooks?.PreToolUse) || settings.hooks.PreToolUse.length === 0) {
    failures.push({ name: "safe mode installs PreToolUse hook", actual: settings?.hooks });
  }
  if (!settingsArg || settingsArg.trim().startsWith("{") || !existsSync(settingsArg)) {
    failures.push({ name: "settings are passed as a file path", actual: settingsArg });
  }
  if (waited.status !== "failed" || waited.result?.failure_reason !== "no_code_changed") {
    failures.push({ name: "fake launcher completed without timeout", actual: waited });
  }
  if (waited.worker?.timed_out) {
    failures.push({ name: "fake launcher should not time out", actual: waited.worker });
  }

  console.log(JSON.stringify({
    started_status: started.status,
    waited_status: waited.status,
    failure_reason: waited.result?.failure_reason ?? null,
    claude_settings_active: started.claude_settings_active,
    has_settings_arg: settingsIndex >= 0,
    settings_is_file: Boolean(settingsArg && !settingsArg.trim().startsWith("{") && existsSync(settingsArg)),
    allow_has_check: settings?.permissions?.allow?.includes("Bash(node --check index.js)") ?? false,
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
