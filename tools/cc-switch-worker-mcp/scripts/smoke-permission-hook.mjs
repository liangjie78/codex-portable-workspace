import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const config = {
  cwd: "/tmp/cc-switch-worker-permission-smoke",
  allowed_dirs: ["/tmp/cc-switch-worker-permission-smoke/src"],
  forbidden_paths: ["/tmp/cc-switch-worker-permission-smoke/.env"],
  checks: ["node --check src/index.js"],
  worker_profile: "scoped_patch",
  safety_mode: "safe",
};

const permissiveConfig = { ...config, safety_mode: "permissive" };
const workspaceWideConfig = {
  ...config,
  allowed_dirs: ["/tmp/cc-switch-worker-permission-smoke"],
};

const cases = [
  {
    name: "approved check",
    input: { tool_name: "Bash", tool_input: { command: "node --check src/index.js" } },
    expect: "allow",
  },
  {
    name: "safe readonly wc",
    input: { tool_name: "Bash", tool_input: { command: "wc -l src/index.js" } },
    expect: "allow",
  },
  {
    name: "safe readonly rg",
    input: { tool_name: "Bash", tool_input: { command: "rg \"function\" src" } },
    expect: "allow",
  },
  {
    name: "safe rg blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "rg SECRET .env" } },
    expect: "deny",
  },
  {
    name: "safe rg -e blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "rg -e SECRET .env" } },
    expect: "deny",
  },
  {
    name: "safe rg without path blocks implicit cwd read",
    input: { tool_name: "Bash", tool_input: { command: "rg SECRET" } },
    expect: "deny",
  },
  {
    name: "safe rg files blocks outside allowed dirs",
    input: { tool_name: "Bash", tool_input: { command: "rg --files .." } },
    expect: "deny",
  },
  {
    name: "safe grep blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "grep SECRET .env" } },
    expect: "deny",
  },
  {
    name: "safe grep -e blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "grep -e SECRET .env" } },
    expect: "deny",
  },
  {
    name: "safe grep -E allows explicit allowed path",
    input: { tool_name: "Bash", tool_input: { command: "grep -E function src/index.js" } },
    expect: "allow",
  },
  {
    name: "safe sed blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "sed -n 1p .env" } },
    expect: "deny",
  },
  {
    name: "safe sed -e blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "sed -n -e 1p .env" } },
    expect: "deny",
  },
  {
    name: "safe sed read script command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n '1r .env' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed write script command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n '1w out.txt' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed expression read script command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n -e '1r .env' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed expression write script command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n -e '1w out.txt' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed execute script command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n '1e echo SECRET' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed block read script command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n '1{r .env' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed block write script command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n '1{ w out.txt' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed compact read command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n '1r.env' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed compact write command is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n '1wout.txt' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed substitution execute flag is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n 's/x/y/e' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed substitution write flag is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n 's/x/y/w out.txt' src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe find blocks outside allowed dirs",
    input: { tool_name: "Bash", tool_input: { command: "find .. -name .env" } },
    expect: "deny",
  },
  {
    name: "safe ls blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "ls .env" } },
    expect: "deny",
  },
  {
    name: "safe git diff blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "git diff -- .env" } },
    expect: "deny",
  },
  {
    name: "safe git show blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "git show HEAD:.env" } },
    expect: "deny",
  },
  {
    name: "safe git diff blocks implicit repo read",
    input: { tool_name: "Bash", tool_input: { command: "git diff" } },
    expect: "deny",
  },
  {
    name: "safe git show blocks implicit object read",
    input: { tool_name: "Bash", tool_input: { command: "git show HEAD" } },
    expect: "deny",
  },
  {
    name: "safe wc blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "wc -l .env" } },
    expect: "deny",
  },
  {
    name: "safe wc files0-from blocks forbidden path",
    input: { tool_name: "Bash", tool_input: { command: "wc --files0-from=.env" } },
    expect: "deny",
  },
  {
    name: "safe wc separated files0-from blocks forbidden path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "wc --files0-from .env" } },
    expect: "deny",
  },
  {
    name: "safe rg ignore-file blocks forbidden path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "rg --ignore-file .env SECRET src" } },
    expect: "deny",
  },
  {
    name: "safe rg inline ignore-file blocks forbidden path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "rg --ignore-file=.env SECRET src" } },
    expect: "deny",
  },
  {
    name: "safe rg preprocessor is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "rg --pre 'cmd /c type .env' SECRET src" } },
    expect: "deny",
  },
  {
    name: "safe rg inline preprocessor is denied",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "rg --pre='cmd /c type .env' SECRET src" } },
    expect: "deny",
  },
  {
    name: "safe rg pre-glob is denied with preprocessor",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "rg --pre-glob '*.js' --pre 'cmd /c type .env' SECRET src" } },
    expect: "deny",
  },
  {
    name: "safe rg pattern file still checks input path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "rg -f src/patterns.txt .env" } },
    expect: "deny",
  },
  {
    name: "safe rg inline pattern file still checks input path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "rg -fsrc/patterns.txt .env" } },
    expect: "deny",
  },
  {
    name: "safe rg glob pattern is not treated as path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "rg --glob=.env SECRET src" } },
    expect: "allow",
  },
  {
    name: "safe grep exclude-from blocks forbidden path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "grep --exclude-from .env SECRET src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe grep inline exclude-from blocks forbidden path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "grep --exclude-from=.env SECRET src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe grep pattern file still checks input path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "grep -f src/patterns.txt .env" } },
    expect: "deny",
  },
  {
    name: "safe grep inline pattern file still checks input path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "grep -fsrc/patterns.txt .env" } },
    expect: "deny",
  },
  {
    name: "safe sed script-file blocks forbidden path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n -f .env src/index.js" } },
    expect: "deny",
  },
  {
    name: "safe sed script-file still checks input path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n -f src/script.sed .env" } },
    expect: "deny",
  },
  {
    name: "safe sed inline script-file still checks input path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "sed -n -fsrc/script.sed .env" } },
    expect: "deny",
  },
  {
    name: "safe find name pattern stays allowed",
    input: { tool_name: "Bash", tool_input: { command: "find src -name index.js" } },
    expect: "allow",
  },
  {
    name: "safe find newer blocks forbidden path",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "find src -newer .env" } },
    expect: "deny",
  },
  {
    name: "safe find checks all search roots",
    config: workspaceWideConfig,
    input: { tool_name: "Bash", tool_input: { command: "find src .env -name index.js" } },
    expect: "deny",
  },
  {
    name: "safe rg blocks outside allowed dirs",
    input: { tool_name: "Bash", tool_input: { command: "rg \"function\" other" } },
    expect: "deny",
  },
  {
    name: "unapproved scoped bash",
    input: { tool_name: "Bash", tool_input: { command: "cat src/index.js" } },
    expect: "deny",
  },
  {
    name: "readonly command with redirect is denied",
    input: { tool_name: "Bash", tool_input: { command: "rg \"x\" src > out.txt" } },
    expect: "deny",
  },
  {
    name: "dangerous bash",
    input: { tool_name: "Bash", tool_input: { command: "rm -rf src" } },
    expect: "deny",
  },
  {
    name: "write inside allowed dirs",
    input: { tool_name: "Edit", tool_input: { file_path: "/tmp/cc-switch-worker-permission-smoke/src/index.js" } },
    expect: null,
  },
  {
    name: "write outside allowed dirs",
    input: { tool_name: "Edit", tool_input: { file_path: "/tmp/cc-switch-worker-permission-smoke/other.js" } },
    expect: "deny",
  },
  {
    name: "forbidden path read",
    input: { tool_name: "Read", tool_input: { file_path: "/tmp/cc-switch-worker-permission-smoke/.env" } },
    expect: "deny",
  },
  {
    name: "Glob inside workspace",
    input: { tool_name: "Glob", tool_input: { pattern: "**/*.js", path: "/tmp/cc-switch-worker-permission-smoke/src" } },
    expect: null,
  },
  {
    name: "Glob outside workspace",
    input: { tool_name: "Glob", tool_input: { pattern: "**/*", path: "/tmp" } },
    expect: "deny",
  },
  {
    name: "Glob forbidden path",
    input: { tool_name: "Glob", tool_input: { pattern: "*", path: "/tmp/cc-switch-worker-permission-smoke/.env" } },
    expect: "deny",
  },
  {
    name: "Grep outside workspace",
    input: { tool_name: "Grep", tool_input: { pattern: "secret", path: "/tmp" } },
    expect: "deny",
  },
  {
    name: "tool cwd outside workspace",
    input: { tool_name: "Grep", tool_input: { pattern: "secret", cwd: "/tmp" } },
    expect: "deny",
  },
];

const permissiveCases = [
  {
    name: "permissive allows ordinary bash",
    config: permissiveConfig,
    input: { tool_name: "Bash", tool_input: { command: "cat src/index.js" } },
    expect: "allow",
  },
  {
    name: "permissive still denies dangerous bash",
    config: permissiveConfig,
    input: { tool_name: "Bash", tool_input: { command: "rm -rf src" } },
    expect: "deny",
  },
];

const failures = [];
for (const item of cases) {
  const result = await runHook(item.input, item.config ?? config);
  const decision = result.output?.hookSpecificOutput?.permissionDecision ?? null;
  if (decision !== item.expect) {
    failures.push({ name: item.name, expected: item.expect, actual: decision, stderr: result.stderr });
  }
}

for (const item of permissiveCases) {
  const result = await runHook(item.input, item.config);
  const decision = result.output?.hookSpecificOutput?.permissionDecision ?? null;
  if (decision !== item.expect) {
    failures.push({ name: item.name, expected: item.expect, actual: decision, stderr: result.stderr });
  }
}

const hookLogDir = mkdtempSync(join(tmpdir(), "cc-switch-worker-hook-log-"));
const toolEventsPath = join(hookLogDir, "tool-events.jsonl");
const preDeniedResult = await runHook({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "cat src/index.js" },
}, { ...config, tool_events_path: toolEventsPath });
if (preDeniedResult.output?.hookSpecificOutput?.permissionDecision !== "deny") {
  failures.push({ name: "PreToolUse denied command emits decision", expected: "deny", actual: preDeniedResult.stdout });
}

const linkRoot = mkdtempSync(join(tmpdir(), "cc-switch-worker-policy-link-"));
const linkWorkspace = join(linkRoot, "workspace");
const linkAllowed = join(linkWorkspace, "src");
const linkOutside = join(linkRoot, "outside");
mkdirSync(linkAllowed, { recursive: true });
mkdirSync(linkOutside, { recursive: true });
const escapeLink = join(linkAllowed, "escape");
symlinkSync(linkOutside, escapeLink, process.platform === "win32" ? "junction" : "dir");
const linkConfig = {
  cwd: linkWorkspace,
  allowed_dirs: [linkAllowed],
  forbidden_paths: [],
  checks: [],
  worker_profile: "scoped_patch",
  safety_mode: "safe",
};
const linkedWrite = await runHook({
  tool_name: "Edit",
  tool_input: { file_path: join(escapeLink, "outside.js") },
}, linkConfig);
if (linkedWrite.output?.hookSpecificOutput?.permissionDecision !== "deny") {
  failures.push({ name: "write through link escaping workspace is denied", actual: linkedWrite.output });
}
const linkedRead = await runHook({
  tool_name: "Read",
  tool_input: { file_path: join(escapeLink, "outside.js") },
}, linkConfig);
if (linkedRead.output?.hookSpecificOutput?.permissionDecision !== "deny") {
  failures.push({ name: "read through link escaping workspace is denied", actual: linkedRead.output });
}
rmSync(linkRoot, { recursive: true, force: true });
const preHookLog = readFileSync(toolEventsPath, "utf8").trim();
const preHookEvent = preHookLog ? JSON.parse(preHookLog.split(/\r?\n/).at(-1)) : null;
if (preHookEvent?.permission_decision !== "deny" || !preHookEvent?.permission_reason) {
  failures.push({ name: "PreToolUse logs permission decision", expected: "deny with reason", actual: preHookEvent });
}
const postToolResult = await runHook({
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: {
    file_path: "/tmp/cc-switch-worker-permission-smoke/src/index.js",
    old_string: "secret old content",
    new_string: "secret new content",
  },
  tool_response: { success: true, duration_ms: 12 },
}, { ...config, tool_events_path: toolEventsPath });
if (postToolResult.stdout.trim() !== "") {
  failures.push({ name: "PostToolUse emits no permission decision", expected: "empty stdout", actual: postToolResult.stdout });
}
const hookLog = readFileSync(toolEventsPath, "utf8").trim();
const hookEvent = hookLog ? JSON.parse(hookLog.split(/\r?\n/).at(-1)) : null;
if (hookEvent?.event !== "PostToolUse" || hookEvent?.tool_name !== "Edit" || hookEvent?.path !== "src/index.js") {
  failures.push({ name: "tool hook summary", expected: "PostToolUse Edit src/index.js", actual: hookEvent });
}
if (/secret old content|secret new content/.test(hookLog)) {
  failures.push({ name: "tool hook redacts edit content", expected: "no edit content in hook log", actual: hookLog });
}
const postToolDangerous = await runHook({
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf src" },
  tool_response: { success: true },
}, { ...config, tool_events_path: toolEventsPath });
if (postToolDangerous.stdout.trim() !== "") {
  failures.push({ name: "PostToolUse dangerous Bash is log-only", expected: "empty stdout", actual: postToolDangerous.stdout });
}
rmSync(hookLogDir, { recursive: true, force: true });

console.log(JSON.stringify({ cases: cases.length + permissiveCases.length + 5, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;

function runHook(input, hookConfig) {
  return new Promise((resolvePromise) => {
    const child = spawn("node", ["src/cc-switch-worker-mcp.mjs", "--permission-hook"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CC_SWITCH_WORKER_HOOK_CONFIG: JSON.stringify(hookConfig),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (exitCode) => {
      let output = null;
      if (stdout.trim()) output = JSON.parse(stdout);
      resolvePromise({ exitCode, output, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
