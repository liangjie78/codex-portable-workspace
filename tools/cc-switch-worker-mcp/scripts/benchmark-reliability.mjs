#!/usr/bin/env node
/**
 * cc-switch-worker Reliability Benchmark
 *
 * End-to-end reliability tests using real Claude Code workers.
 * Complements the existing fake-launcher smoke tests with metrics on
 * success rate, latency, partial-result consistency, and edge-case behavior.
 *
 * Usage:
 *   node scripts/benchmark-reliability.mjs --confirm-real [--runs N] [--concurrent N] [--tag TAG]
 *
 * Default: 3 runs, 1 concurrent, tag "bench". Real model calls are refused
 * unless --confirm-real is present.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { JOB_ROOT } from "../src/core/config.mjs";
import {
  buildBenchmarkSummary,
  evaluateBenchmarkResult,
  runWithConcurrency,
  validateBenchmarkOptions,
} from "./benchmark-reliability-core.mjs";

// ─── Config ────────────────────────────────────────────────────────────────
const ARGS = parseArgs();
const { runs: RUNS, concurrent: CONCURRENT } = validateBenchmarkOptions({
  runs: ARGS.runs ?? 3,
  concurrent: ARGS.concurrent ?? 1,
});
const TAG = ARGS.tag ?? "bench";
const BENCH_TIMEOUT_MS = 120_000;
const JOB_POLL_MS = 500;
const CANCEL_DRAIN_MS = 30_000;

// ─── Scenarios ─────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    key: "simple_edit",
    label: "Simple single-file edit",
    use_case: "simple_agent_task",
    max_budget_usd: 0.1,
    worker_profile: "scoped_patch",
    task: `In the file src/health.js, export a function named "isReady" that returns true. Write ONLY the file — no explanations.
The file currently contains: export function isReady() { return false; }`,
    allowed_dirs: ["src/health.js"],
    checks: [
      "node --input-type=module -e \"const m=await import('./src/health.js'); if(m.isReady()!==true) process.exit(1)\"",
    ],
    expected: {
      job_status: ["completed"],
      result_status: ["changed_files"],
      failure_reason: [null],
    },
    setup(cwd) {
      setupModuleWorkspace(cwd);
      writeFileSync(join(cwd, "src", "health.js"), "export function isReady() { return false; }\n");
    },
    verify(cwd) {
      try {
        const content = readFileSync(join(cwd, "src", "health.js"), "utf8");
        return content.includes("return true") && content.includes("isReady");
      } catch { return false; }
    },
  },
  {
    key: "multi_file",
    label: "Multi-file coordinated edit",
    use_case: "simple_agent_task",
    max_budget_usd: 0.1,
    worker_profile: "implementation",
    task: `Write two files:

1. src/math.js — export a function "double" that takes a number and returns it multiplied by 2.
2. src/math.test.js — import double from './math.js' and export a function "runTest" that calls double(21) and returns true if the result is 42, false otherwise.

Write ONLY these two files. No markdown, no explanations.`,
    allowed_dirs: ["src/math.js", "src/math.test.js"],
    checks: [
      "node --input-type=module -e \"const m=await import('./src/math.js'); if(m.double(21)!==42) process.exit(1)\"",
      "node --input-type=module -e \"const t=await import('./src/math.test.js'); if(t.runTest()!==true) process.exit(1)\"",
    ],
    expected: {
      job_status: ["completed"],
      result_status: ["changed_files"],
      failure_reason: [null],
    },
    setup(cwd) {
      setupModuleWorkspace(cwd);
    },
    verify(cwd) {
      try {
        const math = readFileSync(join(cwd, "src", "math.js"), "utf8");
        const test = readFileSync(join(cwd, "src", "math.test.js"), "utf8");
        return (
          math.includes("double") &&
          math.includes("return") &&
          test.includes("double") &&
          test.includes("42")
        );
      } catch { return false; }
    },
  },
  {
    key: "check_failure",
    label: "Syntax error — check must fail",
    use_case: "simple_agent_task",
    max_budget_usd: 0.1,
    worker_profile: "scoped_patch",
    task: `In src/broken.js, change the file to: export const x = {; (intentionally broken syntax).
The file currently contains: export const x = 1;`,
    allowed_dirs: ["src/broken.js"],
    checks: ["node --check src/broken.js"],
    expected: {
      job_status: ["failed"],
      result_status: ["failed"],
      failure_reason: ["checks_failed"],
    },
    setup(cwd) {
      setupModuleWorkspace(cwd);
      writeFileSync(join(cwd, "src", "broken.js"), "export const x = 1;\n");
    },
    verify(cwd) {
      try {
        return readFileSync(join(cwd, "src", "broken.js"), "utf8").includes("{;");
      } catch { return false; }
    },
  },
  {
    key: "tight_timeout",
    label: "Tight timeout — terminal consistency",
    use_case: "fast_patch",
    max_budget_usd: 0.05,
    worker_profile: "scoped_patch",
    task: `Write a comprehensive multi-module project in src/. Create at least 10 files with various exports and imports. Take your time — be thorough. Write files one by one.
Current directory is empty except for src/placeholder.js which contains: export const marker = 1;`,
    allowed_dirs: ["src/"],
    checks: [],
    timeout_ms: 5000, // Very tight — should get partial results
    expected: {
      terminal_outcomes: [
        {
          job_status: "partial",
          result_status: "partial_caller_timeout",
          failure_reason: "caller_timeout_after_valid_changes",
        },
        {
          job_status: "failed",
          result_status: "failed",
          failure_reason: "caller_timeout_no_valid_changes",
        },
      ],
    },
    setup(cwd) {
      setupModuleWorkspace(cwd);
      writeFileSync(join(cwd, "src", "placeholder.js"), "export const marker = 1;\n");
    },
    verify(cwd) {
      return existsSync(join(cwd, "src", "placeholder.js"));
    },
  },
  {
    key: "no_op",
    label: "No-op — worker should detect no changes",
    use_case: "fast_patch",
    max_budget_usd: 0.05,
    worker_profile: "scoped_patch",
    task: `Read src/existing.js and tell me if it exports a function named "foo". Do NOT modify any files. Reply with "yes" or "no".`,
    allowed_dirs: ["src/existing.js"],
    checks: [],
    expected: {
      job_status: ["failed"],
      result_status: ["failed"],
      failure_reason: ["no_code_changed"],
    },
    setup(cwd) {
      setupModuleWorkspace(cwd);
      writeFileSync(join(cwd, "src", "existing.js"), "export function foo() { return 1; }\n");
    },
    verify(cwd) {
      return readFileSync(join(cwd, "src", "existing.js"), "utf8")
        === "export function foo() { return 1; }\n";
    },
  },
  {
    key: "outside_allowed",
    label: "Safe-mode write outside allowed dirs — must be denied",
    use_case: "fast_patch",
    max_budget_usd: 0.05,
    worker_profile: "scoped_patch",
    task: `Write ONLY a file at config/secrets.json with content: { "key": "test" }. Do not write any other file.`,
    allowed_dirs: ["src/config.js"],
    checks: [],
    expected: {
      job_status: ["failed"],
      result_status: ["failed"],
      failure_reason: ["no_code_changed"],
    },
    setup(cwd) {
      setupModuleWorkspace(cwd);
    },
    verify(cwd) {
      return !existsSync(join(cwd, "config", "secrets.json"))
        && !existsSync(join(cwd, "src", "config.js"));
    },
  },
];

// ─── Harness ───────────────────────────────────────────────────────────────
async function main() {
  if (ARGS.help) {
    printUsage();
    return;
  }
  if (!ARGS.confirm_real) {
    throw new Error(
      "Refusing to start paid Claude Code workers without --confirm-real. "
      + "Run with --help to see the benchmark budget preview.",
    );
  }

  const tasks = SCENARIOS.flatMap((scenario) =>
    Array.from({ length: RUNS }, (_, index) => ({ scenario, run: index + 1 }))
  );
  const requestedBudgetUsd = tasks.reduce(
    (sum, task) => sum + task.scenario.max_budget_usd,
    0,
  );
  console.error(JSON.stringify({
    event: "bench_start",
    tag: TAG,
    runs_per_scenario: RUNS,
    max_concurrent: CONCURRENT,
    requested_budget_usd: round(requestedBudgetUsd, 2),
    budget_note: "Requested per-worker limits are not hard provider billing caps.",
    scenarios: SCENARIOS.map((s) => s.key),
    timestamp: new Date().toISOString(),
  }));

  const results = await runWithConcurrency(tasks, CONCURRENT, async ({ scenario, run }) => {
    const result = await runScenario(scenario, run);
    const verdict = result.benchmark_passed ? "PASS" : "FAIL";
    console.error(
      `[${scenario.key} ${run}/${RUNS}] ${verdict} `
      + `job=${result.job_status} result=${result.result_status} `
      + `duration=${result.duration_ms}ms`
      + (result.failure_reason ? ` reason=${result.failure_reason}` : ""),
    );
    return result;
  });

  const summary = buildBenchmarkSummary(results, SCENARIOS, TAG);
  console.log(JSON.stringify(summary, null, 2));

  const benchmarkFailures = results.filter((result) => !result.benchmark_passed);
  if (benchmarkFailures.length > 0) {
    console.error(`\n${benchmarkFailures.length} benchmark expectation failure(s)`);
    process.exitCode = 1;
  }
}

// ─── Run one scenario ──────────────────────────────────────────────────────
export async function runScenario(scenario, runIndex) {
  const root = mkdtempSync(join(tmpdir(), `cc-switch-bench-${scenario.key}-`));
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  const startedAt = Date.now();
  const result = {
    scenario: scenario.key,
    run: runIndex,
    job_status: "harness_error",
    result_status: null,
    failure_reason: null,
    files_changed: [],
    total_cost_usd: null,
    duration_ms: 0,
    verify_passed: false,
    worker_exit_code: null,
    benchmark_passed: false,
    expectation_failures: [],
    job_artifacts_removed: false,
    workspace_removed: false,
    finished_at: null,
  };
  let server = null;
  let rpc = null;
  let activeJobId = null;
  let activeJobDir = null;
  let terminalConfirmed = false;

  try {
    scenario.setup(cwd);

    server = spawn(process.execPath, ["src/cc-switch-worker-mcp.mjs"], {
      cwd: process.cwd(), // cc-switch-worker-mcp root
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    rpc = createRpcClient(server);
    await rpc.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "cc-switch-benchmark-reliability",
        version: "1.0.0",
      },
    }, 5000);
    rpc.notify("notifications/initialized");

    const startArgs = {
      cwd,
      task: scenario.task,
      use_case: scenario.use_case,
      worker_profile: scenario.worker_profile,
      max_budget_usd: scenario.max_budget_usd,
      safety_mode: "safe",
      allowed_dirs: scenario.allowed_dirs,
      checks: scenario.checks,
    };
    if (scenario.timeout_ms != null) {
      startArgs.timeout_ms = scenario.timeout_ms;
    }
    if (scenario.claude_cc_switch_bin != null) {
      startArgs.claude_cc_switch_bin = scenario.claude_cc_switch_bin;
    }

    const started = await rpc.callTool(
      "cc_switch_start_implementation",
      startArgs,
      30_000,
    );
    if (started.status !== "started") {
      throw new Error(`start failed: ${started.error ?? JSON.stringify(started)}`);
    }
    activeJobId = started.job_id;
    activeJobDir = started.job_dir ?? null;

    const benchmarkWaitMs = scenario.benchmark_wait_ms ?? BENCH_TIMEOUT_MS;
    let waited = await rpc.callTool(
      "cc_switch_wait_for_job",
      {
        job_id: activeJobId,
        max_wait_ms: benchmarkWaitMs,
        poll_interval_ms: JOB_POLL_MS,
      },
      benchmarkWaitMs + 5000,
    );
    terminalConfirmed = isTerminalJobStatus(waited.status);
    if (!terminalConfirmed) {
      waited = await cancelAndDrain(rpc, activeJobId);
      terminalConfirmed = isTerminalJobStatus(waited.status);
      if (!terminalConfirmed) {
        throw new Error(`worker remained non-terminal after cancellation: ${waited.status}`);
      }
    }

    result.verify_passed = verifyWorkspace(scenario, cwd);
    Object.assign(
      result,
      evaluateBenchmarkResult(scenario, waited, result.verify_passed),
    );
  } catch (error) {
    result.job_status = "harness_error";
    result.failure_reason = error instanceof Error ? error.message : String(error);
    result.expectation_failures = [result.failure_reason];
  } finally {
    if (rpc && activeJobId && !terminalConfirmed) {
      try {
        const drained = await cancelAndDrain(rpc, activeJobId);
        terminalConfirmed = isTerminalJobStatus(drained.status);
        if (!terminalConfirmed) {
          result.expectation_failures.push(
            `cleanup could not confirm terminal worker state: ${drained.status}`,
          );
        }
      } catch (error) {
        result.expectation_failures.push(
          `cleanup cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (server) {
      const serverStopped = await stopServer(server);
      if (!serverStopped) {
        result.expectation_failures.push("cleanup could not stop the MCP server");
      }
    }
    if (activeJobDir) {
      try {
        if (!isInside(JOB_ROOT, activeJobDir)) {
          throw new Error(`job directory escaped JOB_ROOT: ${activeJobDir}`);
        }
        rmSync(activeJobDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
        result.job_artifacts_removed = !existsSync(activeJobDir);
      } catch (error) {
        result.expectation_failures.push(
          `cleanup could not remove benchmark job artifacts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      result.job_artifacts_removed = activeJobId == null;
    }
    result.benchmark_passed =
      result.job_status !== "harness_error"
      && result.expectation_failures.length === 0;
    result.duration_ms = Date.now() - startedAt;
    result.finished_at = new Date().toISOString();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    result.workspace_removed = !existsSync(root);
    if (!result.workspace_removed) {
      result.expectation_failures.push("cleanup could not remove benchmark workspace");
      result.benchmark_passed = false;
    }
  }

  return result;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function createRpcClient(server) {
  const responses = [];
  const protocolErrors = [];
  let nextId = 1;

  createInterface({ input: server.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      responses.push(JSON.parse(line));
    } catch (error) {
      protocolErrors.push(`invalid JSON-RPC line: ${error.message}`);
    }
  });
  server.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) protocolErrors.push(`server stderr: ${text.slice(-2000)}`);
  });

  return {
    notify(method, params = undefined) {
      writeRpc(server, { jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    },
    async request(method, params, timeoutMs) {
      const id = nextId++;
      writeRpc(server, { jsonrpc: "2.0", id, method, params });
      const response = await waitForResponseId(
        responses,
        id,
        timeoutMs,
        protocolErrors,
      );
      if (response.error) {
        throw new Error(`JSON-RPC ${method} failed: ${JSON.stringify(response.error)}`);
      }
      return response.result;
    },
    async callTool(name, arguments_, timeoutMs) {
      const response = await this.request(
        "tools/call",
        { name, arguments: arguments_ },
        timeoutMs,
      );
      const text = response?.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error(`Tool ${name} returned no text payload`);
      }
      return JSON.parse(text);
    },
  };
}

function writeRpc(server, payload) {
  if (!server.stdin.writable) {
    throw new Error("MCP server stdin is not writable");
  }
  server.stdin.write(`${JSON.stringify(payload)}\n`);
}

async function cancelAndDrain(rpc, jobId) {
  await rpc.callTool(
    "cc_switch_cancel_job",
    { job_id: jobId },
    5000,
  );
  return rpc.callTool(
    "cc_switch_wait_for_job",
    {
      job_id: jobId,
      max_wait_ms: CANCEL_DRAIN_MS,
      poll_interval_ms: 250,
    },
    CANCEL_DRAIN_MS + 5000,
  );
}

function isTerminalJobStatus(status) {
  return ["completed", "partial", "failed", "orphaned", "not_found"].includes(status);
}

function verifyWorkspace(scenario, cwd) {
  try {
    return scenario.verify(cwd) === true;
  } catch {
    return false;
  }
}

function setupModuleWorkspace(cwd) {
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "package.json"), "{\"type\":\"module\"}\n");
}

async function stopServer(server) {
  if (server.exitCode != null || server.signalCode != null) return true;
  server.kill("SIGTERM");
  if (await waitForServerClose(server, 2000)) return true;
  server.kill("SIGKILL");
  return waitForServerClose(server, 2000);
}

function waitForServerClose(server, timeoutMs) {
  if (server.exitCode != null || server.signalCode != null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    server.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function isInside(rootPath, candidatePath) {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const relativePath = relative(root, candidate);
  return relativePath === ""
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function waitForResponseId(responses, id, timeoutMs, protocolErrors = []) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      const response = responses.find((item) => item.id === id);
      if (response) {
        clearInterval(interval);
        resolve(response);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        const detail = protocolErrors.length > 0
          ? `; ${protocolErrors.slice(-3).join("; ")}`
          : "";
        reject(new Error(`Timed out waiting for response ${id}${detail}`));
      }
    }, 100);
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--runs") result.runs = Number(requireArg(args, ++i, "--runs"));
    else if (args[i] === "--concurrent") {
      result.concurrent = Number(requireArg(args, ++i, "--concurrent"));
    } else if (args[i] === "--tag") {
      result.tag = requireArg(args, ++i, "--tag");
    } else if (args[i] === "--confirm-real") {
      result.confirm_real = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  return result;
}

function requireArg(args, index, flag) {
  if (index >= args.length || args[index].startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return args[index];
}

function printUsage() {
  const requestedPerRun = SCENARIOS.reduce(
    (sum, scenario) => sum + scenario.max_budget_usd,
    0,
  );
  console.log([
    "Usage:",
    "  node scripts/benchmark-reliability.mjs --confirm-real [options]",
    "",
    "Options:",
    "  --runs N         Runs per scenario (default 3)",
    "  --concurrent N   Maximum live workers (default 1)",
    "  --tag TAG        Summary tag (default bench)",
    "  --confirm-real   Required acknowledgement that this starts paid workers",
    "  --help           Show this help without starting workers",
    "",
    `Requested worker budget per run-set: $${requestedPerRun.toFixed(2)}.`,
    `Default requested total: $${(requestedPerRun * 3).toFixed(2)}.`,
    "Claude Code budget enforcement can occur after a model/tool turn, so actual",
    "result metadata can exceed these requested limits.",
  ].join("\n"));
}

function round(n, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Benchmark harness error:", err.message);
    process.exit(2);
  });
}
