import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

const syntaxTargets = findMjsFiles(["src", "bin", "scripts"]);
const offlineSteps = [
  ["mcp:doctor", "src/cc-switch-worker-mcp.mjs", ["--doctor"]],
  ["mcp:smoke:tools", "scripts/smoke-tools-list.mjs", []],
  ["mcp:smoke:permission", "scripts/smoke-permission-hook.mjs", []],
  ["mcp:smoke:restore", "scripts/smoke-job-restore.mjs", []],
  ["mcp:smoke:stream", "scripts/smoke-stream-events.mjs", []],
  ["mcp:smoke:observability", "scripts/smoke-observability.mjs", []],
  ["mcp:smoke:diagnostics", "scripts/smoke-diagnostics.mjs", []],
  ["mcp:smoke:duplicate-start", "scripts/smoke-duplicate-start.mjs", []],
  ["mcp:smoke:safe-settings", "scripts/smoke-safe-settings.mjs", []],
  ["mcp:smoke:required-skills", "scripts/smoke-required-skills.mjs", []],
  ["mcp:smoke:context", "scripts/smoke-context-bootstrap.mjs", []],
  ["mcp:smoke:partial-status", "scripts/smoke-partial-status.mjs", []],
  ["mcp:smoke:policy-boundary", "scripts/smoke-policy-boundary.mjs", []],
];

const results = [];

for (const file of syntaxTargets) {
  runStep(`syntax:${file}`, process.execPath, ["--check", file]);
}

runStep("version-consistency", process.execPath, [
  "--input-type=module",
  "-e",
  [
    "import { readFileSync } from 'node:fs';",
    "const pkg = JSON.parse(readFileSync('package.json', 'utf8'));",
    "const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));",
    "const config = readFileSync('src/core/config.mjs', 'utf8');",
    "if (pkg.version !== lock.version) throw new Error('package-lock root version mismatch');",
    "if (pkg.version !== lock.packages[''].version) throw new Error('package-lock packages root version mismatch');",
    "if (!config.includes(`SERVER_VERSION = \"${pkg.version}\"`)) throw new Error('SERVER_VERSION mismatch');",
    "console.log(`version ${pkg.version} consistent`);",
  ].join(" "),
]);

for (const [name, script, args] of offlineSteps) {
  runStep(name, process.execPath, [script, ...args]);
}

const packInvocation = npmPackInvocation();
const pack = runStep("npm-pack-dry-run", packInvocation.command, packInvocation.args, { capture: true });
validatePackOutput(pack.stdout);

runStep("cleanup-check", process.execPath, [
  "--input-type=module",
  "-e",
  [
    "import { readdirSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "const prefixes = [",
    "'cc-switch-worker-observability-',",
    "'cc-switch-worker-diagnostics-',",
    "'cc-switch-worker-duplicate-start-',",
    "'cc-switch-worker-safe-settings-',",
    "'cc-switch-worker-required-skills-',",
    "'cc-switch-worker-context-',",
    "'cc-switch-worker-partial-status-',",
    "'cc-switch-worker-policy-boundary-',",
    "'cc-switch-worker-restore-smoke'",
    "];",
    "const entries = readdirSync(tmpdir(), { withFileTypes: true });",
    "const leftovers = entries.filter((entry) => entry.isDirectory() && prefixes.some((prefix) => entry.name.startsWith(prefix))).map((entry) => entry.name);",
    "if (leftovers.length) throw new Error(`smoke temp leftovers: ${leftovers.join(', ')}`);",
    "console.log('no smoke temp leftovers');",
  ].join(" "),
]);

console.log(JSON.stringify({ ok: true, steps: results }, null, 2));

function runStep(name, command, args, options = {}) {
  const started = Date.now();
  console.log(`[verify:start] ${name}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  const seconds = Number(((Date.now() - started) / 1000).toFixed(2));
  results.push({ name, status: result.status, seconds });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    if (options.capture && result.stdout) process.stdout.write(result.stdout);
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    console.error(`[verify:fail] ${name} exit=${result.status} seconds=${seconds}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[verify:done] ${name} seconds=${seconds}`);
  return result;
}

function validatePackOutput(stdout) {
  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack did not return JSON: ${error.message}`);
  }
  const files = entries?.[0]?.files?.map((file) => file.path) ?? [];
  const forbidden = files.filter((file) => {
    const lower = file.toLowerCase();
    return lower.includes(".env")
      || lower.includes("mem.md")
      || lower.includes("agents.md")
      || lower.includes(".pytest_cache")
      || lower.includes("__pycache__")
      || lower.includes(".bak")
      || lower.includes("node_modules")
      || lower.includes("logs/");
  });
  if (forbidden.length > 0) {
    throw new Error(`npm pack includes forbidden files: ${forbidden.join(", ")}`);
  }
  console.log(`[verify:pack] ${files.length} files checked`);
}

function findMjsFiles(roots) {
  const files = [];
  for (const root of roots) walk(root, files);
  return files.sort();
}

function walk(path, files) {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (path.endsWith(".mjs")) files.push(path);
    return;
  }
  for (const entry of readdirSync(path)) {
    walk(join(path, entry), files);
  }
}

function npmPackInvocation() {
  if (platform() === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm pack --dry-run --json"],
    };
  }
  return {
    command: "npm",
    args: ["pack", "--dry-run", "--json"],
  };
}
