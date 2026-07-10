#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveMemoryRoot, searchCards } from "../src/cardStore.mjs";

const root = resolveMemoryRoot();
const evalPath = path.join(root, "eval", "queries.jsonl");
const text = await readFile(evalPath, "utf8");
const cases = text
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const results = [];
for (const item of cases) {
  const search = await searchCards({ query: item.query, limit: 3 }, root);
  const topIds = search.results.map((result) => result.id);
  const expected = item.expected_ids ?? [];
  const ranks = expected.map((id) => topIds.indexOf(id) + 1).filter((rank) => rank > 0);
  const best_rank = ranks.length > 0 ? Math.min(...ranks) : null;
  const hit = best_rank !== null;
  results.push({ query: item.query, expected_ids: expected, top_ids: topIds, best_rank, hit });
}

const passed = results.filter((item) => item.hit).length;
const top1 = results.filter((item) => item.best_rank === 1).length;
const mrr = results.length
  ? results.reduce((total, item) => total + (item.best_rank ? 1 / item.best_rank : 0), 0) / results.length
  : 0;
const report = {
  root,
  ok: passed === results.length,
  passed,
  total: results.length,
  metrics: {
    top1,
    top1_rate: results.length ? top1 / results.length : 0,
    mean_reciprocal_rank: mrr,
  },
  results,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
