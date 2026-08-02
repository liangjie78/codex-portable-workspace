export function validateBenchmarkOptions({ runs, concurrent }) {
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error("runs must be a positive integer");
  }
  if (!Number.isInteger(concurrent) || concurrent <= 0) {
    throw new Error("concurrent must be a positive integer");
  }
  return { runs, concurrent };
}

export async function runWithConcurrency(items, limit, worker) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("concurrency limit must be a positive integer");
  }
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}

export function evaluateBenchmarkResult(scenario, waited, verifyPassed) {
  const jobStatus = waited?.status ?? "unknown";
  const resultStatus = waited?.result?.status ?? null;
  const failureReason = waited?.result?.failure_reason ?? null;
  const expectationFailures = [];
  const expected = scenario.expected ?? {};

  if (Array.isArray(expected.terminal_outcomes) && expected.terminal_outcomes.length > 0) {
    const actualOutcome = {
      job_status: jobStatus,
      result_status: resultStatus,
      failure_reason: failureReason,
    };
    const matched = expected.terminal_outcomes.some((outcome) =>
      outcome.job_status === actualOutcome.job_status
      && outcome.result_status === actualOutcome.result_status
      && outcome.failure_reason === actualOutcome.failure_reason
    );
    if (!matched) {
      expectationFailures.push(
        `terminal outcome expected ${expected.terminal_outcomes.map(formatOutcome).join(" or ")}; `
        + `got ${formatOutcome(actualOutcome)}`,
      );
    }
  } else if (Array.isArray(expected.terminal_outcomes)) {
    // Empty terminal_outcomes array is a scenario definition error.
    // Must not silently pass: if no outcomes are defined, no actual outcome can be valid.
    expectationFailures.push(
      "scenario.expected.terminal_outcomes must not be empty",
    );
  } else {
    checkExpected("job_status", expected.job_status, jobStatus, expectationFailures);
    checkExpected("result_status", expected.result_status, resultStatus, expectationFailures);
    checkExpected("failure_reason", expected.failure_reason, failureReason, expectationFailures);
  }
  if (!verifyPassed) {
    expectationFailures.push("workspace verification failed");
  }

  const rawCost = waited?.result?.worker?.total_cost_usd;
  const totalCostUsd = typeof rawCost === "number" && Number.isFinite(rawCost)
    ? rawCost
    : null;

  return {
    job_status: jobStatus,
    result_status: resultStatus,
    failure_reason: failureReason,
    files_changed: waited?.result?.files_changed ?? [],
    total_cost_usd: totalCostUsd,
    worker_exit_code: waited?.result?.worker?.exit_code ?? null,
    benchmark_passed: expectationFailures.length === 0,
    expectation_failures: expectationFailures,
  };
}

export function buildBenchmarkSummary(results, scenarios, tag) {
  const byScenario = new Map();
  for (const result of results) {
    const rows = byScenario.get(result.scenario) ?? [];
    rows.push(result);
    byScenario.set(result.scenario, rows);
  }

  const summary = {
    tag,
    total_runs: results.length,
    scenarios: {},
    aggregated: aggregateRows(results),
  };

  for (const scenario of scenarios) {
    const rows = byScenario.get(scenario.key) ?? [];
    const durations = rows.map((row) => row.duration_ms).sort((a, b) => a - b);
    const passed = rows.filter((row) => row.benchmark_passed).length;
    summary.scenarios[scenario.key] = {
      label: scenario.label,
      runs: rows.length,
      passed,
      failed: rows.length - passed,
      pass_rate_pct: percentage(passed, rows.length),
      avg_duration_ms: round(avg(durations), 0),
      p50_duration_ms: percentile(durations, 50),
      p95_duration_ms: percentile(durations, 95),
      total_cost_usd: round(sumCost(rows), 6),
      details: rows.map((row) => ({
        run: row.run,
        benchmark_passed: row.benchmark_passed,
        expectation_failures: row.expectation_failures,
        job_status: row.job_status,
        result_status: row.result_status,
        failure_reason: row.failure_reason,
        files_changed: row.files_changed ?? [],
        total_cost_usd: row.total_cost_usd,
        duration_ms: row.duration_ms,
        verify_passed: row.verify_passed,
        worker_exit_code: row.worker_exit_code,
      })),
    };
  }

  return summary;
}

function aggregateRows(rows) {
  const durations = rows.map((row) => row.duration_ms).sort((a, b) => a - b);
  const passed = rows.filter((row) => row.benchmark_passed).length;
  const completed = rows.filter((row) => row.job_status === "completed").length;
  const partial = rows.filter((row) => row.job_status === "partial").length;
  const failed = rows.filter((row) => row.job_status === "failed").length;
  const harnessErrors = rows.filter((row) => row.job_status === "harness_error").length;

  return {
    scenario_pass_rate_pct: percentage(passed, rows.length),
    worker_completed_rate_pct: percentage(completed, rows.length),
    partial_job_rate_pct: percentage(partial, rows.length),
    worker_failed_rate_pct: percentage(failed, rows.length),
    harness_error_rate_pct: percentage(harnessErrors, rows.length),
    avg_duration_ms: round(avg(durations), 0),
    p50_duration_ms: percentile(durations, 50),
    p95_duration_ms: percentile(durations, 95),
    total_cost_usd: round(sumCost(rows), 6),
  };
}

function checkExpected(label, allowed, actual, failures) {
  if (!Array.isArray(allowed) || allowed.length === 0) return;
  if (allowed.includes(actual)) return;
  failures.push(
    `${label} expected ${allowed.map(formatValue).join(" or ")}; got ${formatValue(actual)}`,
  );
}

function formatValue(value) {
  return value === null ? "null" : String(value);
}

function formatOutcome(outcome) {
  return `(${formatValue(outcome.job_status)}, ${formatValue(outcome.result_status)}, `
    + `${formatValue(outcome.failure_reason)})`;
}

function percentage(count, total) {
  return total === 0 ? 0 : round((count / total) * 100, 1);
}

function sumCost(rows) {
  return rows.reduce(
    (sum, row) => sum + (typeof row.total_cost_usd === "number" ? row.total_cost_usd : 0),
    0,
  );
}

function avg(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
