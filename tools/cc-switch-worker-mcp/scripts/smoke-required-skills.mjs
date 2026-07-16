import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { JOB_ROOT } from "../src/core/config.mjs";

const root = mkdtempSync(join(tmpdir(), "cc-switch-worker-required-skills-"));
const cwd = join(root, "workspace");
const fakeLauncher = join(root, "fake-claude-cc-switch.mjs");
const argsOut = join(root, "launcher-args.json");
const skillsRoot = join(root, "skills");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "index.js"), "export const value = 1;\n");
for (const skill of ["tdd", "diagnosing-bugs", "codebase-design", "ui-ux-pro-max", "guizang-ppt-skill"]) {
  const skillDir = join(skillsRoot, skill);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skill}\ndescription: smoke fixture\n---\n`);
}
writeFileSync(fakeLauncher, [
  "#!/usr/bin/env node",
  "import { existsSync, writeFileSync } from 'node:fs';",
  "let input = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { input += chunk; });",
  "process.stdin.on('end', () => {",
  "  const args = process.argv.slice(2);",
  "  const roots = args.flatMap((value, index) => value === '--add-dir' ? [args[index + 1]] : []).filter(Boolean);",
  "  const expected = ['tdd', 'diagnosing-bugs', 'codebase-design', 'ui-ux-pro-max', 'guizang-ppt-skill'];",
  "  const stagedSkills = expected.every((skill) => roots.some((root) => existsSync(`${root}/.claude/skills/${skill}/SKILL.md`)));",
  `  writeFileSync(${JSON.stringify(argsOut)}, JSON.stringify({ args, prompt: input, stagedSkills }));`,
  "  setTimeout(() => process.exit(0), 25);",
  "});",
  "",
].join("\n"));
chmodSync(fakeLauncher, 0o755);

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CC_SWITCH_WORKER_SKILLS_ROOT: skillsRoot,
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
      task: "Implement the bounded change.",
      worker_profile: "scoped_patch",
      safety_mode: "permissive",
      permission_mode: "acceptEdits",
      allowed_dirs: ["."],
      required_skills: ["tdd", "diagnosing-bugs", "codebase-design", "ui-ux-pro-max", "guizang-ppt-skill"],
      claude_cc_switch_bin: fakeLauncher,
      timeout_ms: 5000,
    },
  });
  const started = parseToolPayload(await waitForResponseId(2, 5000));
  if (started.job_dir) jobDirsToRemove.push(started.job_dir);

  send(4, "tools/call", {
    name: "cc_switch_wait_for_job",
    arguments: { job_id: started.job_id, max_wait_ms: 5000, poll_interval_ms: 25 },
  });
  await waitForResponseId(4, 7000);

  const captured = existsSync(argsOut) ? JSON.parse(readFileSync(argsOut, "utf8")) : {};
  const launcherArgs = captured.args ?? [];
  const settingsIndex = launcherArgs.indexOf("--settings");
  const settingsPath = settingsIndex >= 0 ? launcherArgs[settingsIndex + 1] : null;
  const settings = settingsPath && existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8"))
    : null;
  const prompt = captured.prompt ?? "";

  send(5, "tools/call", {
    name: "cc_switch_start_implementation",
    arguments: {
      cwd,
      task: "Reject an unsafe skill name.",
      worker_profile: "scoped_patch",
      allowed_dirs: ["."],
      required_skills: ["../escape"],
      claude_cc_switch_bin: fakeLauncher,
    },
  });
  const invalid = parseToolPayload(await waitForResponseId(5, 5000));

  const failures = [];
  if (!settings?.permissions?.allow?.includes("Skill(tdd)")) {
    failures.push({ name: "tdd permission is scoped to the worker", actual: settings?.permissions?.allow });
  }
  if (!settings?.permissions?.allow?.includes("Skill(codebase-design)")) {
    failures.push({ name: "codebase-design permission is scoped to the worker", actual: settings?.permissions?.allow });
  }
  if (!settings?.permissions?.allow?.includes("Skill(ui-ux-pro-max)")) {
    failures.push({ name: "ui-ux-pro-max permission is scoped to the worker", actual: settings?.permissions?.allow });
  }
  if (!settings?.permissions?.allow?.includes("Skill(guizang-ppt-skill)")) {
    failures.push({ name: "guizang-ppt-skill permission is scoped to the worker", actual: settings?.permissions?.allow });
  }
  if (settings?.permissions?.allow?.includes("Skill")) {
    failures.push({ name: "all skills are not broadly allowed", actual: settings?.permissions?.allow });
  }
  if (!prompt.includes("/tdd") || !prompt.includes("/codebase-design") || !prompt.includes("/ui-ux-pro-max") || !prompt.includes("/guizang-ppt-skill")) {
    failures.push({ name: "prompt explicitly invokes required skills", actual: prompt });
  }
  if (captured.stagedSkills !== true) {
    failures.push({ name: "only required skills are staged for bare mode discovery", actual: captured });
  }
  if (!/invalid required skill/i.test(invalid.error?.message ?? invalid.message ?? "")) {
    failures.push({ name: "unsafe skill names are rejected", actual: invalid });
  }

  console.log(JSON.stringify({
    allow: settings?.permissions?.allow ?? null,
    prompt_has_tdd: prompt.includes("/tdd"),
    prompt_has_codebase_design: prompt.includes("/codebase-design"),
    staged_skills_visible: captured.stagedSkills === true,
    invalid_error: invalid.error?.message ?? invalid.message ?? null,
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
