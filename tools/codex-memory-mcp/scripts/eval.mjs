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
  const hit = expected.some((id) => topIds.includes(id));
  results.push({ query: item.query, expected_ids: expected, top_ids: topIds, hit });
}

const passed = results.filter((item) => item.hit).length;
const report = {
  root,
  ok: passed === results.length,
  passed,
  total: results.length,
  results,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
