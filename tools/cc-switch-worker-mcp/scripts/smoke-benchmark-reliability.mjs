import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario } from "./benchmark-reliability.mjs";
import {
  buildBenchmarkSummary,
  evaluateBenchmarkResult,
  runWithConcurrency,
  validateBenchmarkOptions,
} from "./benchmark-reliability-core.mjs";

const scenarios = [
  {
    key: "simple_edit",
    label: "Simple edit",
    expected: {
      job_status: ["completed"],
      result_status: ["changed_files"],
      failure_reason: [null],
    },
  },
  {
    key: "check_failure",
    label: "Expected check failure",
    expected: {
      job_status: ["failed"],
      result_status: ["failed"],
      failure_reason: ["checks_failed"],
    },
  },
];

const completed = evaluateBenchmarkResult(
  scenarios[0],
  {
    status: "completed",
    result: {
      status: "changed_files",
      failure_reason: null,
      files_changed: ["src/health.js"],
      worker: { total_cost_usd: 0.012, exit_code: 0 },
    },
  },
  true,
);
assert.equal(completed.benchmark_passed, true);
assert.equal(completed.total_cost_usd, 0.012);

const expectedFailure = evaluateBenchmarkResult(
  scenarios[1],
  {
    status: "failed",
    result: {
      status: "failed",
      failure_reason: "checks_failed",
      files_changed: ["src/broken.js"],
      worker: { total_cost_usd: 0.02, exit_code: 1 },
    },
  },
  true,
);
assert.equal(expectedFailure.benchmark_passed, true);

const wrongFailure = evaluateBenchmarkResult(
  scenarios[1],
  {
    status: "failed",
    result: {
      status: "failed",
      failure_reason: "no_code_changed",
      files_changed: [],
      worker: { total_cost_usd: null, exit_code: 0 },
    },
  },
  true,
);
assert.equal(wrongFailure.benchmark_passed, false);
assert.deepEqual(wrongFailure.expectation_failures, [
  "failure_reason expected checks_failed; got no_code_changed",
]);

const timeoutScenario = {
  key: "tight_timeout",
  label: "Tight timeout",
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
};
const validTimeout = evaluateBenchmarkResult(
  timeoutScenario,
  {
    status: "partial",
    result: {
      status: "partial_caller_timeout",
      failure_reason: "caller_timeout_after_valid_changes",
    },
  },
  true,
);
assert.equal(validTimeout.benchmark_passed, true);

const inconsistentTimeout = evaluateBenchmarkResult(
  timeoutScenario,
  {
    status: "partial",
    result: {
      status: "failed",
      failure_reason: "caller_timeout_no_valid_changes",
    },
  },
  true,
);
assert.equal(inconsistentTimeout.benchmark_passed, false);
assert.match(inconsistentTimeout.expectation_failures[0], /terminal outcome expected/);

const summary = buildBenchmarkSummary(
  [
    {
      scenario: "simple_edit",
      run: 1,
      duration_ms: 100,
      finished_at: "2026-07-29T00:00:00.000Z",
      verify_passed: true,
      ...completed,
    },
    {
      scenario: "check_failure",
      run: 1,
      duration_ms: 200,
      finished_at: "2026-07-29T00:00:01.000Z",
      verify_passed: true,
      ...expectedFailure,
    },
    {
      scenario: "check_failure",
      run: 2,
      duration_ms: 300,
      finished_at: "2026-07-29T00:00:02.000Z",
      verify_passed: true,
      ...wrongFailure,
    },
  ],
  scenarios,
  "self-test",
);
assert.equal(summary.aggregated.scenario_pass_rate_pct, 66.7);
assert.equal(summary.aggregated.worker_completed_rate_pct, 33.3);
assert.equal(summary.aggregated.total_cost_usd, 0.032);
assert.equal(summary.scenarios.check_failure.passed, 1);
assert.equal(summary.scenarios.check_failure.failed, 1);

assert.deepEqual(validateBenchmarkOptions({ runs: 2, concurrent: 1 }), {
  runs: 2,
  concurrent: 1,
});
assert.throws(
  () => validateBenchmarkOptions({ runs: 0, concurrent: 1 }),
  /runs must be a positive integer/,
);
assert.throws(
  () => validateBenchmarkOptions({ runs: 1, concurrent: Number.NaN }),
  /concurrent must be a positive integer/,
);

let active = 0;
let maxActive = 0;
const ordered = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise((resolve) => setTimeout(resolve, value % 2 === 0 ? 5 : 10));
  active -= 1;
  return value * 10;
});
assert.equal(maxActive, 2);
assert.deepEqual(ordered, [10, 20, 30, 40, 50]);

const fixtureRoot = mkdtempSync(join(tmpdir(), "cc-switch-benchmark-fixture-"));
try {
  const completedLauncher = join(fixtureRoot, "fake-completed-launcher.mjs");
  writeLauncher(completedLauncher, [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.cwd(), 'src', 'health.js'), 'export function isReady() { return true; }\\n');",
    "console.log(JSON.stringify({",
    "  type: 'result',",
    "  subtype: 'success',",
    "  is_error: false,",
    "  result: 'done',",
    "  total_cost_usd: 0,",
    "  num_turns: 1,",
    "}));",
  ]);
  const completedScenario = {
    key: "fixture_completed",
    label: "Fake launcher completes",
    use_case: "fast_patch",
    max_budget_usd: 0.01,
    worker_profile: "scoped_patch",
    task: "Update src/health.js so isReady returns true.",
    allowed_dirs: ["src/health.js"],
    checks: [
      "node --input-type=module -e \"const m=await import('./src/health.js'); if(m.isReady()!==true) process.exit(1)\"",
    ],
    claude_cc_switch_bin: completedLauncher,
    expected: {
      job_status: ["completed"],
      result_status: ["changed_files"],
      failure_reason: [null],
    },
    setup(cwd) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "package.json"), "{\"type\":\"module\"}\n");
      writeFileSync(
        join(cwd, "src", "health.js"),
        "export function isReady() { return false; }\n",
      );
    },
    verify(cwd) {
      return readFileSync(join(cwd, "src", "health.js"), "utf8")
        .includes("return true");
    },
  };
  const completedE2e = await runScenario(completedScenario, 1);
  assert.equal(
    completedE2e.benchmark_passed,
    true,
    JSON.stringify(completedE2e),
  );
  assert.equal(completedE2e.job_artifacts_removed, true);
  assert.equal(completedE2e.workspace_removed, true);

  const hangingLauncher = join(fixtureRoot, "fake-hanging-launcher.mjs");
  writeLauncher(hangingLauncher, [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.cwd(), 'src', 'partial.js'), 'export const partial = true;\\n');",
    "setInterval(() => {}, 1000);",
  ]);
  const cancelledScenario = {
    key: "fixture_cancelled",
    label: "Harness cancels a non-terminal worker",
    use_case: "fast_patch",
    max_budget_usd: 0.01,
    worker_profile: "scoped_patch",
    task: "Create src/partial.js, then keep working.",
    allowed_dirs: ["src/"],
    checks: [],
    timeout_ms: 30_000,
    benchmark_wait_ms: 1000,
    claude_cc_switch_bin: hangingLauncher,
    expected: {
      job_status: ["partial"],
      result_status: ["partial_cancelled"],
      failure_reason: ["cancelled_after_valid_changes"],
    },
    setup(cwd) {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "package.json"), "{\"type\":\"module\"}\n");
    },
    verify(cwd) {
      return readFileSync(join(cwd, "src", "partial.js"), "utf8")
        .includes("partial = true");
    },
  };
  const cancelledE2e = await runScenario(cancelledScenario, 1);
  assert.equal(
    cancelledE2e.benchmark_passed,
    true,
    JSON.stringify(cancelledE2e),
  );
  assert.equal(cancelledE2e.job_artifacts_removed, true);
  assert.equal(cancelledE2e.workspace_removed, true);

console.log(JSON.stringify({
  ok: true,
  cases: 17,
    max_concurrent_observed: maxActive,
    e2e: {
      completed: completedE2e.job_status,
      cancelled: cancelledE2e.job_status,
      cleanup_verified: true,
    },
  }));
} finally {
  rmSync(fixtureRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

function writeLauncher(path, lines) {
  writeFileSync(path, ["#!/usr/bin/env node", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
}
