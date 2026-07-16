#!/usr/bin/env node
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

const wrapperName = basename(process.argv[1] ?? "claude-cc-switch");
const defaults = modelDefaults(wrapperName);
const claudeBin = process.env.CLAUDE_BIN || defaultClaudeBin() || resolveExecutable("claude");
const keyFile = process.env.CC_SWITCH_API_KEY_FILE || join(homedir(), ".codex/secrets/cc_switch_api_key");

if (!isExecutable(claudeBin)) {
  fail(`Claude Code not found or not executable: ${claudeBin}\nSet CLAUDE_BIN to your Claude Code CLI path.`);
}

const env = { ...process.env };
if (!env.ANTHROPIC_AUTH_TOKEN) {
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile, "utf8").replace(/[\n\r]/g, "");
    if (key) {
      env.ANTHROPIC_AUTH_TOKEN = key;
    }
  }
  if (!env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_AUTH_TOKEN = "PROXY_MANAGED";
  }
}

if (!env.CC_SWITCH_KEEP_ANTHROPIC_API_KEY) {
  delete env.ANTHROPIC_API_KEY;
}

env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL || "http://127.0.0.1:15721";
if (defaults.model) {
  env.ANTHROPIC_MODEL = env.ANTHROPIC_MODEL || defaults.model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = env.ANTHROPIC_DEFAULT_OPUS_MODEL || defaults.model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = env.ANTHROPIC_DEFAULT_SONNET_MODEL || defaults.model;
}
if (defaults.haikuModel) {
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.ANTHROPIC_DEFAULT_HAIKU_MODEL || defaults.haikuModel;
}
if (defaults.subagentModel) {
  env.CLAUDE_CODE_SUBAGENT_MODEL = env.CLAUDE_CODE_SUBAGENT_MODEL || defaults.subagentModel;
}
if (defaults.effort) {
  env.CLAUDE_CODE_EFFORT_LEVEL = env.CLAUDE_CODE_EFFORT_LEVEL || defaults.effort;
}
env.API_TIMEOUT_MS = env.API_TIMEOUT_MS || "600000";
env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || "1";

const invocation = nodeScriptInvocation(claudeBin, process.argv.slice(2));
const child = spawn(invocation.command, invocation.args, {
  stdio: "inherit",
  env,
});
let forwardedSignal = null;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => forwardSignal(signal));
}
child.on("exit", (code, signal) => {
  if (forwardedSignal) {
    process.exit(forwardedSignal === "SIGINT" ? 130 : 143);
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  fail(error.message);
});

function forwardSignal(signal) {
  if (forwardedSignal) return;
  forwardedSignal = signal;
  if (child.exitCode != null || child.signalCode != null || !child.kill(signal)) {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
  setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }, 3000).unref();
}

function nodeScriptInvocation(command, args) {
  return /\.(mjs|cjs|js)$/i.test(command)
    ? { command: process.execPath, args: [command, ...args] }
    : { command, args };
}

function modelDefaults(name) {
  if (name.includes("flash")) {
    return { model: null, haikuModel: null, effort: "high", subagentModel: null };
  }
  if (name.includes("pro")) {
    return { model: null, haikuModel: null, effort: "max", subagentModel: null };
  }
  return { model: null, haikuModel: null, effort: null, subagentModel: null };
}

function resolveExecutable(command) {
  if (typeof command !== "string" || command.length === 0) return null;
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return isExecutable(command) ? command : null;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions = executableExtensions(command);
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (isExecutable(candidate)) return candidate;
      const npmPackageBin = npmShimTarget(candidate);
      if (npmPackageBin) return npmPackageBin;
    }
  }
  return null;
}

function isExecutable(path) {
  try {
    accessSync(path, platform() === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableExtensions(command) {
  if (platform() !== "win32") return [""];
  if (/\.[^\\/]+$/.test(command)) return [""];
  return (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((ext) => ext.toLowerCase())
    .concat("");
}

function defaultClaudeBin() {
  if (platform() === "win32") {
    const npmBin = process.env.APPDATA
      ? join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
      : null;
    return npmBin && isExecutable(npmBin) ? npmBin : null;
  }
  return join(homedir(), ".local/bin/claude");
}

function npmShimTarget(candidate) {
  if (platform() !== "win32" || !/\.(cmd|bat)$/i.test(candidate)) return null;
  const target = join(
    candidate.replace(/\.(cmd|bat)$/i, ""),
    "..",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  return isExecutable(target) ? target : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

