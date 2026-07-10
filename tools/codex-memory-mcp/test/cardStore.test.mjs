import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatCardMarkdown,
  formatMaintenancePlan,
  formatTaskBrief,
  createSnapshot,
  createMaintenancePlan,
  createTaskBrief,
  getCard,
  getStoreHealth,
  markCardVerified,
  parseCardMarkdown,
  reindex,
  recordTaskCompletion,
  searchCards,
  upsertCard,
  validateCard,
  validateStore,
} from "../src/cardStore.mjs";

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-memory-test-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function card(overrides = {}) {
  return {
    id: "test-card-001",
    title: "Test card",
    type: "workflow",
    scope: "test",
    project: "test",
    status: "active",
    confidence: "high",
    tags: ["test", "memory"],
    source_path: "test/cardStore.test.mjs",
    source_section: "fixture",
    created_at: "2026-06-01",
    updated_at: "2026-06-01",
    last_verified_at: "2026-06-01",
    body: "## Problem\n\nTest a durable knowledge-card workflow.",
    ...overrides,
  };
}

test("parses UTF-8 BOM card frontmatter", () => {
  const parsed = parseCardMarkdown(`\uFEFF${formatCardMarkdown(card())}`, "bom-card.md");
  assert.equal(parsed.id, "test-card-001");

  const escaped = parseCardMarkdown(
    formatCardMarkdown(
      card({
        title: 'Quoted "title"',
        tags: ["comma,tag", 'quote"tag'],
        aliases: ["常见问法", 'quoted "alias"'],
      }),
    ),
    "escaped-card.md",
  );
  assert.equal(escaped.title, 'Quoted "title"');
  assert.deepEqual(escaped.tags, ["comma,tag", 'quote"tag']);
  assert.deepEqual(escaped.aliases, ["常见问法", 'quoted "alias"']);
});

test("rejects invalid verification dates and credential-looking values", () => {
  const invalidDate = validateCard(card({ last_verified_at: "2026-02-30" }));
  assert.match(invalidDate.join("\n"), /last_verified_at.*YYYY-MM-DD/);

  const tokenLikeValue = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
  const secret = validateCard(card({ body: `credential ${tokenLikeValue}` }));
  assert.match(secret.join("\n"), /credential-looking value/);

  const invalidAliases = validateCard(card({ aliases: ["", "valid alias"] }));
  assert.match(invalidAliases.join("\n"), /aliases/);
});

test("upsert preserves created_at, moves the canonical card, and refreshes the index", async () => {
  await withTempRoot(async (root) => {
    const first = await upsertCard(card(), root);
    assert.equal(first.ok, true);
    assert.ok(existsSync(first.file_path));

    const updated = await upsertCard(
      card({
        title: "Moved test card",
        type: "tool",
        created_at: undefined,
        updated_at: undefined,
        last_verified_at: undefined,
      }),
      root,
    );
    assert.equal(updated.ok, true);
    assert.ok(existsSync(updated.file_path));
    assert.ok(!existsSync(first.file_path));

    const loaded = await getCard("test-card-001", root);
    assert.equal(loaded.card.type, "tool");
    assert.equal(loaded.card.created_at, "2026-06-01");

    const validation = await validateStore(root);
    assert.equal(validation.ok, true);
    const health = await getStoreHealth(root);
    assert.equal(health.index.state, "current");
  });
});

test("explicit verification updates only lifecycle metadata and keeps the index current", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(card(), root);
    const verified = await markCardVerified(
      "test-card-001",
      { last_verified_at: "2026-07-10", status: "needs_verification" },
      root,
    );
    assert.equal(verified.ok, true);
    assert.equal(verified.last_verified_at, "2026-07-10");
    assert.equal(verified.status, "needs_verification");

    const loaded = await getCard("test-card-001", root);
    assert.equal(loaded.card.created_at, "2026-06-01");
    assert.equal(loaded.card.last_verified_at, "2026-07-10");
    assert.equal(loaded.card.status, "needs_verification");
    assert.equal((await getStoreHealth(root)).index.state, "current");
  });
});

test("explicit verification does not create a missing card", async () => {
  await withTempRoot(async (root) => {
    const result = await markCardVerified("missing-card-001", {}, root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /card not found/);
    assert.ok(!existsSync(path.join(root, "cards")));
  });
});

test("snapshot captures the local store with a manifest and never leaves a partial directory", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(card(), root);
    const snapshot = await createSnapshot({ label: "Before release!" }, root);
    assert.equal(snapshot.ok, true);
    assert.ok(existsSync(snapshot.snapshot_path));
    assert.ok(!existsSync(`${snapshot.snapshot_path}.partial`));

    const manifest = JSON.parse(await readFile(snapshot.manifest_path, "utf8"));
    assert.equal(manifest.label, "before-release");
    assert.equal(manifest.file_count, snapshot.file_count);
    assert.ok(manifest.files.some((item) => item.path === "cards/workflows/test-card-001.md"));
    assert.equal(
      await readFile(path.join(snapshot.snapshot_path, "cards", "workflows", "test-card-001.md"), "utf8"),
      await readFile(path.join(root, "cards", "workflows", "test-card-001.md"), "utf8"),
    );
    assert.equal((await getStoreHealth(snapshot.snapshot_path)).index.state, "current");
  });
});

test("snapshot refuses an invalid store before creating a final snapshot", async () => {
  await withTempRoot(async (root) => {
    const invalidCard = path.join(root, "cards", "workflows", "invalid.md");
    await mkdir(path.dirname(invalidCard), { recursive: true });
    await writeFile(invalidCard, "not valid frontmatter", "utf8");

    const snapshot = await createSnapshot({}, root);
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.snapshot_path, undefined);
  });
});

test("completion validates every lesson before writing the batch", async () => {
  await withTempRoot(async (root) => {
    const result = await recordTaskCompletion(
      {
        task_summary: "Batch validation test",
        lessons: [
          { id: "valid-batch-001", title: "Valid lesson", tags: ["test"] },
          { id: "invalid-batch-001", title: "Invalid lesson", tags: [] },
        ],
      },
      root,
    );
    assert.equal(result.ok, false);
    assert.ok(!existsSync(path.join(root, "cards")), "invalid completion must not initialize card storage");
    const health = await getStoreHealth(root);
    assert.equal(health.card_count, 0);
  });
});

test("completion rejects an empty batch without initializing a knowledge root", async () => {
  await withTempRoot(async (root) => {
    const result = await recordTaskCompletion({ task_summary: "No reusable lesson", lessons: [] }, root);
    assert.equal(result.ok, false);
    assert.match(result.errors[0].error, /at least one/);
    assert.ok(!existsSync(path.join(root, "cards")));
  });
});

test("completion generates a schema-safe ID when a Chinese lesson omits one", async () => {
  await withTempRoot(async (root) => {
    const result = await recordTaskCompletion(
      {
        task_summary: "中文任务完成",
        project: "测试项目",
        lessons: [{ title: "中文经验", tags: ["测试"], aliases: ["任务结束经验"] }],
      },
      root,
    );
    assert.equal(result.ok, true);
    assert.match(result.written[0].id, /^memory-card-\d{8}-01$/);
    assert.deepEqual((await getCard(result.written[0].id, root)).card.aliases, ["任务结束经验"]);
    assert.equal((await validateStore(root)).ok, true);
  });
});

test("health distinguishes a stale index from a current index", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(card(), root);
    const current = await getStoreHealth(root);
    assert.equal(current.index.state, "current");

    const manualPath = path.join(root, "cards", "workflows", "unindexed-card-001.md");
    await mkdir(path.dirname(manualPath), { recursive: true });
    await writeFile(manualPath, formatCardMarkdown(card({ id: "unindexed-card-001" })), "utf8");

    const stale = await getStoreHealth(root);
    assert.equal(stale.index.state, "stale");
    assert.equal(stale.ok, false);
  });
});

test("health warns about missing absolute local source evidence without blocking the card", async () => {
  await withTempRoot(async (root) => {
    const missingSource = path.join(root, "evidence", "deleted-note.md");
    const result = await upsertCard(card({ source_path: missingSource }), root);
    assert.equal(result.ok, true);

    const health = await getStoreHealth(root);
    assert.equal(health.ok, false);
    assert.equal(health.sources.checked, 1);
    assert.equal(health.sources.existing, 0);
    assert.equal(health.sources.missing, 1);
    assert.equal(health.sources.missing_sources[0].id, "test-card-001");
    assert.match(health.warnings.join("\n"), /missing local source evidence/);
  });
});

test("health does not probe UNC source paths as local evidence", async () => {
  await withTempRoot(async (root) => {
    const result = await upsertCard(card({ source_path: "\\\\offline-server\\share\\evidence.md" }), root);
    assert.equal(result.ok, true);

    const health = await getStoreHealth(root);
    assert.equal(health.ok, true);
    assert.equal(health.sources.checked, 0);
    assert.equal(health.sources.uncheckable, 1);
    assert.equal(health.sources.missing, 0);
  });
});

test("Chinese phrase search ranks cards by overlapping Han-character terms", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(
      card({
        id: "chinese-search-target-001",
        title: "Explicit verification workflow",
        confidence: "medium",
        body: "## Problem\n\n检索或读取卡片不等于完成验证。",
      }),
      root,
    );
    await upsertCard(
      card({
        id: "chinese-search-distractor-001",
        title: "Unrelated high confidence card",
        confidence: "high",
        body: "## Problem\n\nUnrelated content.",
      }),
      root,
    );

    const result = await searchCards({ query: "检索不等于验证", limit: 2 }, root);
    assert.equal(result.results[0].id, "chinese-search-target-001");
  });
});

test("a query excludes cards with no lexical overlap", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(
      card({
        id: "no-overlap-high-confidence-001",
        title: "Unrelated high confidence card",
        confidence: "high",
        body: "## Problem\n\nUnrelated content.",
      }),
      root,
    );

    const result = await searchCards({ query: "absent-term-xyz", limit: 5 }, root);
    assert.equal(result.count, 0);
    assert.deepEqual(result.results, []);
  });
});

test("aliases make reviewed natural task wording rank ahead of incidental CJK overlap", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(
      card({
        id: "transaction-recovery-001",
        title: "Recover an interrupted multi-file write",
        aliases: ["知识库写到一半中断", "恢复半批写入"],
        confidence: "medium",
        body: "## Problem\n\nRecover a prepared local transaction after interruption.",
      }),
      root,
    );
    await upsertCard(
      card({
        id: "incidental-overlap-001",
        title: "Knowledge base migration notes",
        confidence: "high",
        body: "## Problem\n\n知识库处理过程需要记录。",
      }),
      root,
    );

    const result = await searchCards({ query: "知识库写到一半中断怎么处理", limit: 2 }, root);
    assert.equal(result.results[0].id, "transaction-recovery-001");
    assert.match(result.results[0].match_reason, /alias/);
    assert.ok(result.results[0].aliases.includes("知识库写到一半中断"));
  });
});

test("coverage ranking favors the card that matches more distinct Chinese terms", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(
      card({
        id: "network-source-target-001",
        title: "Source integrity for UNC paths",
        aliases: ["网络共享路径来源检查"],
        confidence: "medium",
        body: "## Problem\n\nCheck local evidence but do not probe network shares.",
      }),
      root,
    );
    await upsertCard(
      card({
        id: "network-path-distractor-001",
        title: "Windows path checks",
        aliases: ["网络路径检查"],
        confidence: "high",
        body: "## Problem\n\nGeneral path troubleshooting.",
      }),
      root,
    );

    const result = await searchCards({ query: "网络共享路径来源检查", limit: 2 }, root);
    assert.equal(result.results[0].id, "network-source-target-001");
    assert.match(result.results[0].match_reason, /tokens \d+\/\d+/);
  });
});

test("task brief is read-only and combines relevant cards with verification reminders", async () => {
  await withTempRoot(async (root) => {
    const missingSource = path.join(root, "evidence", "deleted-note.md");
    await upsertCard(
      card({
        id: "brief-target-001",
        title: "Brief target",
        aliases: ["任务开工小抄"],
        status: "needs_verification",
        last_verified_at: "2020-01-01",
        source_path: missingSource,
      }),
      root,
    );

    const before = await readFile(path.join(root, "indexes", "cards.jsonl"), "utf8");
    const brief = await createTaskBrief({ query: "任务开工小抄", limit: 3 }, root);
    const after = await readFile(path.join(root, "indexes", "cards.jsonl"), "utf8");

    assert.equal(brief.results[0].id, "brief-target-001");
    assert.equal(before, after, "brief must not rewrite the index");
    assert.ok(brief.reminders.some((item) => item.code === "needs_verification"));
    assert.ok(brief.reminders.some((item) => item.code === "overdue_verification"));
    assert.ok(brief.warnings.some((warning) => /missing local source evidence/.test(warning)));
    assert.match(formatTaskBrief(brief), /brief-target-001/);
  });
});

test("task brief does not initialize an empty knowledge root", async () => {
  await withTempRoot(async (root) => {
    const brief = await createTaskBrief({ query: "missing knowledge" }, root);
    assert.equal(brief.results.length, 0);
    assert.ok(!existsSync(path.join(root, "cards")));
    assert.ok(!existsSync(path.join(root, "indexes")));
  });
});

test("maintenance plan is read-only and reports only evidence-backed actions", async () => {
  await withTempRoot(async (root) => {
    const missingSource = path.join(root, "evidence", "deleted-note.md");
    await upsertCard(
      card({
        id: "maintenance-target-001",
        title: "Exact duplicate workflow",
        status: "active",
        aliases: [],
        last_verified_at: "2020-01-01",
        source_path: missingSource,
      }),
      root,
    );
    await upsertCard(
      card({
        id: "maintenance-duplicate-001",
        title: "Exact duplicate workflow",
        aliases: ["reviewed alias"],
      }),
      root,
    );

    const indexPath = path.join(root, "indexes", "cards.jsonl");
    const before = await readFile(indexPath, "utf8");
    const plan = await createMaintenancePlan({}, root);
    const after = await readFile(indexPath, "utf8");

    assert.equal(before, after, "maintenance planning must not rewrite the index");
    assert.ok(plan.suggestions.some((item) => item.code === "verify" && item.card_ids.includes("maintenance-target-001")));
    assert.ok(plan.suggestions.some((item) => item.code === "source_missing" && item.card_ids.includes("maintenance-target-001")));
    assert.ok(plan.suggestions.some((item) => item.code === "add_aliases" && item.card_ids.includes("maintenance-target-001")));
    const duplicate = plan.suggestions.find((item) => item.code === "possible_duplicate");
    assert.deepEqual(duplicate.card_ids, ["maintenance-duplicate-001", "maintenance-target-001"]);
    assert.match(formatMaintenancePlan(plan), /Exact duplicate workflow/);
  });
});

test("maintenance plan does not initialize an empty knowledge root", async () => {
  await withTempRoot(async (root) => {
    const plan = await createMaintenancePlan({}, root);
    assert.deepEqual(plan.suggestions, []);
    assert.ok(!existsSync(path.join(root, "cards")));
    assert.ok(!existsSync(path.join(root, "indexes")));
  });
});

test("concurrent upserts leave a current index containing every card", async () => {
  await withTempRoot(async (root) => {
    const results = await Promise.all(
      ["concurrent-card-001", "concurrent-card-002", "concurrent-card-003"].map((id) =>
        upsertCard(card({ id, title: id }), root),
      ),
    );
    assert.ok(results.every((result) => result.ok));

    const health = await getStoreHealth(root);
    assert.equal(health.ok, true);
    assert.equal(health.card_count, 3);
    assert.equal(health.index.state, "current");
  });
});

test("verification and a concurrent content update preserve both changes", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(card(), root);
    await Promise.all([
      markCardVerified("test-card-001", { last_verified_at: "2026-07-10" }, root),
      upsertCard(
        card({
          body: "## Problem\n\nContent update must survive verification.",
          created_at: undefined,
          updated_at: undefined,
          last_verified_at: undefined,
        }),
        root,
      ),
    ]);

    const loaded = await getCard("test-card-001", root);
    assert.match(loaded.card.body, /Content update must survive verification/);
    assert.equal(loaded.card.last_verified_at, "2026-07-10");
    assert.equal((await getStoreHealth(root)).index.state, "current");
  });
});

test("reindex rolls back a prepared partial type move before rebuilding the index", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(card(), root);
    const oldPath = path.join(root, "cards", "workflows", "test-card-001.md");
    const newPath = path.join(root, "cards", "tools", "test-card-001.md");
    const oldText = await readFile(oldPath, "utf8");
    const oldIndex = await readFile(path.join(root, "indexes", "cards.jsonl"), "utf8");
    const moved = card({ type: "tool", title: "Partially moved card" });

    await mkdir(path.dirname(newPath), { recursive: true });
    await writeFile(newPath, formatCardMarkdown(moved), "utf8");
    await writeFile(
      path.join(root, "indexes", ".codex-memory-transaction.json"),
      `${JSON.stringify({
        version: 1,
        state: "prepared",
        operations: [
          { path: "cards/tools/test-card-001.md", before: null, after: formatCardMarkdown(moved) },
          { path: "cards/workflows/test-card-001.md", before: oldText, after: null },
          { path: "indexes/cards.jsonl", before: oldIndex, after: "partial index" },
        ],
      })}\n`,
      "utf8",
    );

    const blockedRead = await getCard("test-card-001", root);
    assert.equal(blockedRead.card, null);
    assert.match(blockedRead.errors[0].error, /transaction is pending/);

    const rebuilt = await reindex(root);
    assert.equal(rebuilt.ok, true);
    assert.ok(existsSync(oldPath));
    assert.ok(!existsSync(newPath));
    assert.equal((await getCard("test-card-001", root)).card.type, "workflow");
    assert.equal((await getStoreHealth(root)).transaction.state, "none");
  });
});

test("reindex completes a committed journal after an interrupted publish", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(card(), root);
    const cardPath = path.join(root, "cards", "workflows", "test-card-001.md");
    const indexPath = path.join(root, "indexes", "cards.jsonl");
    const beforeCard = await readFile(cardPath, "utf8");
    const beforeIndex = await readFile(indexPath, "utf8");
    const afterCard = formatCardMarkdown(card({ title: "Committed recovery card" }));

    await writeFile(
      path.join(root, "indexes", ".codex-memory-transaction.json"),
      `${JSON.stringify({
        version: 1,
        state: "committed",
        operations: [
          { path: "cards/workflows/test-card-001.md", before: beforeCard, after: afterCard },
          { path: "indexes/cards.jsonl", before: beforeIndex, after: beforeIndex },
        ],
      })}\n`,
      "utf8",
    );

    const rebuilt = await reindex(root);
    assert.equal(rebuilt.ok, true);
    assert.equal((await getCard("test-card-001", root)).card.title, "Committed recovery card");
    assert.equal((await getStoreHealth(root)).transaction.state, "none");
  });
});

test("read operations refuse duplicate IDs instead of choosing an arbitrary card", async () => {
  await withTempRoot(async (root) => {
    const workflowPath = path.join(root, "cards", "workflows", "test-card-001.md");
    const toolPath = path.join(root, "cards", "tools", "test-card-001.md");
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await mkdir(path.dirname(toolPath), { recursive: true });
    await writeFile(workflowPath, formatCardMarkdown(card()), "utf8");
    await writeFile(toolPath, formatCardMarkdown(card({ type: "tool", title: "Duplicate" })), "utf8");

    const got = await getCard("test-card-001", root);
    assert.equal(got.card, null);
    assert.match(got.errors.at(-1).error, /duplicate id/);

    const searched = await searchCards({ query: "test card", limit: 5 }, root);
    assert.equal(searched.results.length, 0);
    assert.ok(searched.load_errors.some((error) => /duplicate id/.test(error.error)));
  });
});

test("a stale mutation lock is recovered before a safe write", async () => {
  await withTempRoot(async (root) => {
    const lockPath = path.join(root, "indexes", ".codex-memory-write.lock");
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "abandoned lock\n", "utf8");
    const old = new Date(Date.now() - 4 * 60 * 1000);
    await utimes(lockPath, old, old);

    const result = await upsertCard(card(), root);
    assert.equal(result.ok, true);
    assert.equal((await getStoreHealth(root)).index.state, "current");
  });
});

test("health keeps a live owner lock active even when its timestamp is old", async () => {
  await withTempRoot(async (root) => {
    await upsertCard(card(), root);
    const lockPath = path.join(root, "indexes", ".codex-memory-write.lock");
    await writeFile(lockPath, `${JSON.stringify({ version: 1, owner: "live-test", pid: process.pid })}\n`, "utf8");
    const old = new Date(Date.now() - 4 * 60 * 1000);
    await utimes(lockPath, old, old);

    const health = await getStoreHealth(root);
    assert.equal(health.write_lock.state, "active");
    assert.equal(health.write_lock.pid, process.pid);
    assert.ok(!health.warnings.some((warning) => /stale CodexMemory write lock/.test(warning)));
  });
});
