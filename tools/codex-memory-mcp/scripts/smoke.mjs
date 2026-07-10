#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-memory-smoke-"));
const serverPath = path.join(projectRoot, "src", "server.mjs");

const child = spawn(process.execPath, [serverPath], {
  cwd: projectRoot,
  env: { ...process.env, CODEX_MEMORY_ROOT: tempRoot },
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
let stdout = "";
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  let newline;
  while ((newline = stdout.indexOf("\n")) >= 0) {
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  }
});

child.stderr.on("data", () => {});

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "codex-memory-smoke", version: "1.0.0" },
  });
  assert(initialized.serverInfo.name === "codex-memory-mcp", "initialize returned wrong server name");
  assert(initialized.serverInfo.version === "0.9.0", "initialize returned wrong server version");

  const listed = await request("tools/list", {});
  const names = listed.tools.map((tool) => tool.name).sort();
  for (const expected of ["rag_brief", "rag_finish_task", "rag_get", "rag_health", "rag_maintenance_plan", "rag_mark_verified", "rag_reindex", "rag_search", "rag_snapshot", "rag_upsert", "rag_validate"]) {
    assert(names.includes(expected), `missing tool ${expected}`);
  }

  const card = {
    id: "smoke-card-001",
    title: "Smoke card for CodexMemory",
    type: "workflow",
    scope: "test",
    project: "smoke",
    status: "active",
    confidence: "high",
    tags: ["smoke", "mcp"],
    aliases: ["temporary MCP proof card"],
    source_path: "smoke-test",
    source_section: "scripts/smoke.mjs",
    body: "## Problem\nNeed to prove MCP tools work.\n\n## Solution\nUpsert, search, get, validate and reindex in a temporary root.",
  };
  const upserted = await callTool("rag_upsert", { card });
  assert(upserted.ok === true, "rag_upsert failed");

  const searchText = await callToolText("rag_search", { query: "prove MCP tools", limit: 3 });
  assert(searchText.includes("smoke-card-001"), "rag_search text output did not include smoke card");

  const searched = await callTool("rag_search", { query: "prove MCP tools", limit: 3, format: "json" });
  assert(searched.results.some((result) => result.id === card.id), "rag_search did not find smoke card");

  const aliasSearch = await callTool("rag_search", { query: "temporary MCP proof card", limit: 3, format: "json" });
  assert(aliasSearch.results[0]?.id === card.id, "rag_search did not rank alias match first");

  const brief = await callTool("rag_brief", { query: "temporary MCP proof card", limit: 3, format: "json" });
  assert(brief.results[0]?.id === card.id, "rag_brief did not include the relevant card");

  const plan = await callTool("rag_maintenance_plan", { format: "json" });
  assert(Array.isArray(plan.suggestions), "rag_maintenance_plan did not return suggestions");

  const got = await callTool("rag_get", { id: card.id });
  assert(got.card.id === card.id, "rag_get returned wrong card");

  const verified = await callTool("rag_mark_verified", { id: card.id, last_verified_at: "2026-07-10" });
  assert(verified.ok === true && verified.last_verified_at === "2026-07-10", "rag_mark_verified failed");

  const validated = await callTool("rag_validate", {});
  assert(validated.ok === true, "rag_validate failed");

  const indexed = await callTool("rag_reindex", {});
  assert(indexed.ok === true && indexed.card_count === 1, "rag_reindex failed");

  const health = await callTool("rag_health", {});
  assert(health.ok === true && health.index.state === "current", "rag_health failed");

  const finished = await callTool("rag_finish_task", {
    task_summary: "Smoke test completed.",
    project: "smoke",
    outcome: "success",
    source_path: "scripts/smoke.mjs",
    lessons: [
      {
        id: "smoke-finish-001",
        title: "Smoke finish task card",
        type: "workflow",
        tags: ["smoke", "finish"],
        problem: "Need to prove task completion lessons can be recorded.",
        solution: "Use rag_finish_task with structured lessons.",
      },
    ],
  });
  assert(finished.ok === true && finished.written.length === 1, "rag_finish_task failed");

  const snapshot = await callTool("rag_snapshot", { label: "smoke" });
  assert(snapshot.ok === true && snapshot.file_count > 0, "rag_snapshot failed");

  console.log(JSON.stringify({ ok: true, tempRoot, tools: names }, null, 2));
} finally {
  child.kill();
  await rm(tempRoot, { recursive: true, force: true });
}

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }
    }, 5000);
  });
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return promise;
}

async function callTool(name, args) {
  const text = await callToolText(name, args);
  return JSON.parse(text);
}

async function callToolText(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  return result.content.map((item) => item.text).join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
