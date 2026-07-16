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
const envOut = join(root, "launcher-env-keys.json");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "index.js"), "export const value = 1;\n");
writeFileSync(join(cwd, ".env.local"), "SYNTHETIC_ONLY=not-a-real-secret\n");
writeFileSync(join(cwd, "synthetic.key"), "not a real key\n");
mkdirSync(join(cwd, "private"), { recursive: true });
writeFileSync(join(cwd, "private", "ignored.txt"), "synthetic private fixture\n");
writeFileSync(fakeLauncher, [
  "#!/usr/bin/env node",
  "import { writeFileSync } from 'node:fs';",
  `writeFileSync(${JSON.stringify(argsOut)}, JSON.stringify(process.argv.slice(2)));`,
  `writeFileSync(${JSON.stringify(envOut)}, JSON.stringify(Object.keys(process.env).sort()));`,
  "setTimeout(() => process.exit(0), 50);",
  "",
].join("\n"));
chmodSync(fakeLauncher, 0o755);

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    UNRELATED_SECRET_TEST: "synthetic-value-that-must-not-reach-worker",
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
      forbidden_paths: ["private"],
      checks: ["node --check index.js"],
      claude_cc_switch_bin: fakeLauncher,
      permission_mode: "acceptEdits",
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
  const launcherEnvKeys = existsSync(envOut) ? JSON.parse(readFileSync(envOut, "utf8")) : [];
  const persistedSnapshot = JSON.parse(readFileSync(join(started.job_dir, "before-snapshot.json"), "utf8"));
  const persistedPaths = persistedSnapshot.map(([path]) => path);
  const settingsIndex = launcherArgs.indexOf("--settings");
  const settingsArg = settingsIndex >= 0 ? launcherArgs[settingsIndex + 1] : null;
  const settings = settingsArg && existsSync(settingsArg)
    ? JSON.parse(readFileSync(settingsArg, "utf8"))
    : null;
  const failures = [];

  if (started.status !== "started" || started.permission_mode !== "acceptEdits" || started.safety_mode !== "safe") {
    failures.push({ name: "safe mode is the default", actual: started.safety_mode });
  }
  if (started.claude_settings_active !== true) {
    failures.push({ name: "safe mode injects settings for acceptEdits", actual: started.claude_settings_active });
  }
  if (!settings?.permissions?.allow?.includes("Bash(node --check index.js)")) {
    failures.push({ name: "requested check is allow-listed", actual: settings?.permissions?.allow });
  }
  if (!settings?.permissions?.deny?.some((entry) => entry.includes(".env"))) {
    failures.push({ name: "mandatory forbidden paths survive caller overrides", actual: settings?.permissions?.deny });
  }
  if (persistedPaths.some((path) => path === ".env.local" || path === "synthetic.key" || path.startsWith("private/"))) {
    failures.push({ name: "snapshot excludes sensitive and forbidden paths", actual: persistedPaths });
  }
  if (persistedSnapshot.some(([, metadata]) => Object.hasOwn(metadata ?? {}, "content"))) {
    failures.push({ name: "persisted snapshots contain hashes and metadata only", actual: persistedSnapshot });
  }
  if (launcherEnvKeys.includes("UNRELATED_SECRET_TEST")) {
    failures.push({ name: "worker subprocess receives a minimal environment", actual: launcherEnvKeys });
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
    snapshot_paths: persistedPaths,
    subprocess_env_key_count: launcherEnvKeys.length,
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
