import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CARD_TYPES = new Set([
  "environment",
  "tool",
  "workflow",
  "pitfall",
  "project",
  "error",
  "decision",
]);

export const CARD_STATUSES = new Set([
  "active",
  "needs_verification",
  "stale",
  "deprecated",
]);

export const CARD_CONFIDENCE = new Set(["high", "medium", "low"]);

const CARD_DIRS = {
  environment: "environment",
  tool: "tools",
  workflow: "workflows",
  pitfall: "pitfalls",
  project: "projects",
  error: "pitfalls",
  decision: "workflows",
};

const MAX_CARD_TITLE_CHARS = 180;
const MAX_CARD_BODY_CHARS = 12000;
const MAX_CARD_TAGS = 16;
const MAX_CARD_TAG_CHARS = 64;
const MAX_CARD_ALIASES = 12;
const MAX_CARD_ALIAS_CHARS = 120;
const LOCK_RETRY_MS = 40;
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 180000;
const LOCK_HEARTBEAT_MS = Math.max(1000, Math.floor(LOCK_STALE_MS / 3));
const VERIFICATION_OVERDUE_DAYS = 180;
const LOCK_FILE_NAME = ".codex-memory-write.lock";
const TRANSACTION_FILE_NAME = ".codex-memory-transaction.json";
const TRANSACTION_VERSION = 1;

export function resolveMemoryRoot(root) {
  if (root && root.trim()) return path.resolve(root);
  if (process.env.CODEX_MEMORY_ROOT?.trim()) {
    return path.resolve(process.env.CODEX_MEMORY_ROOT);
  }
  const workspaceRoot = "D:\\Workspace\\CodexMemory";
  if (process.platform === "win32" && existsSync(workspaceRoot)) {
    return workspaceRoot;
  }
  return path.join(os.homedir(), ".codex-memory");
}

export async function ensureMemoryRoot(root) {
  const resolved = resolveMemoryRoot(root);
  const dirs = [
    "cards/environment",
    "cards/tools",
    "cards/workflows",
    "cards/pitfalls",
    "cards/projects",
    "sources",
    "indexes",
    "eval",
    "backups",
  ];
  for (const dir of dirs) {
    await mkdir(path.join(resolved, dir), { recursive: true });
  }
  return resolved;
}

export async function listCardFiles(root) {
  const resolved = resolveMemoryRoot(root);
  const cardsRoot = path.join(resolved, "cards");
  if (!existsSync(cardsRoot)) return [];
  const results = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }
  await walk(cardsRoot);
  return results.sort((a, b) => a.localeCompare(b));
}

export function parseCardMarkdown(text, filePath = "") {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new Error(`Card is missing frontmatter: ${filePath}`);
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error(`Card frontmatter is not closed: ${filePath}`);

  const metadata = {};
  for (const rawLine of lines.slice(1, end)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    metadata[key] = parseScalar(rawValue);
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return normalizeCard({ ...metadata, body, file_path: filePath });
}

function parseScalar(value) {
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {
      // Support the existing compact YAML-like tag syntax below.
    }
    return inner
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter(Boolean);
  }
  return stripQuotes(value);
}

function stripQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function normalizeCard(input) {
  const today = localDateString();
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((tag) => String(tag).trim()).filter(Boolean))]
    : [];
  const aliases = Array.isArray(input.aliases)
    ? input.aliases.map((alias) => String(alias).trim())
    : input.aliases === undefined || input.aliases === null
      ? []
      : [String(input.aliases).trim()];
  return {
    id: stringOrEmpty(input.id),
    title: stringOrEmpty(input.title),
    type: stringOrDefault(input.type, "workflow"),
    scope: stringOrDefault(input.scope, "global"),
    project: input.project === undefined || input.project === null ? null : String(input.project).trim(),
    status: stringOrDefault(input.status, "active"),
    confidence: stringOrDefault(input.confidence, "medium"),
    tags,
    aliases,
    source_path: stringOrEmpty(input.source_path),
    source_section: stringOrEmpty(input.source_section),
    created_at: stringOrDefault(input.created_at, today),
    updated_at: stringOrDefault(input.updated_at, today),
    last_verified_at: stringOrDefault(input.last_verified_at, today),
    body: stringOrEmpty(input.body),
    file_path: input.file_path ? String(input.file_path) : undefined,
  };
}

function stringOrEmpty(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function stringOrDefault(value, fallback) {
  const text = stringOrEmpty(value);
  return text || fallback;
}

export function validateCard(card) {
  const errors = [];
  if (!card.id) errors.push("id is required");
  if (card.id && !/^[a-z0-9][a-z0-9-]*$/.test(card.id)) {
    errors.push("id must use lowercase letters, numbers and hyphens");
  }
  if (!card.title) errors.push("title is required");
  if (card.title.length > MAX_CARD_TITLE_CHARS) {
    errors.push(`title must be at most ${MAX_CARD_TITLE_CHARS} characters`);
  }
  if (!CARD_TYPES.has(card.type)) errors.push(`type must be one of: ${[...CARD_TYPES].join(", ")}`);
  if (!CARD_STATUSES.has(card.status)) {
    errors.push(`status must be one of: ${[...CARD_STATUSES].join(", ")}`);
  }
  if (!CARD_CONFIDENCE.has(card.confidence)) {
    errors.push(`confidence must be one of: ${[...CARD_CONFIDENCE].join(", ")}`);
  }
  if (!Array.isArray(card.tags) || card.tags.length === 0) {
    errors.push("tags must contain at least one tag");
  }
  if (Array.isArray(card.tags) && card.tags.length > MAX_CARD_TAGS) {
    errors.push(`tags must contain at most ${MAX_CARD_TAGS} values`);
  }
  if (Array.isArray(card.tags) && card.tags.some((tag) => !tag || tag.length > MAX_CARD_TAG_CHARS || /[\r\n]/.test(tag))) {
    errors.push(`each tag must be non-empty, one line, and at most ${MAX_CARD_TAG_CHARS} characters`);
  }
  if (card.aliases !== undefined && !Array.isArray(card.aliases)) errors.push("aliases must be an array when provided");
  if (Array.isArray(card.aliases) && card.aliases.length > MAX_CARD_ALIASES) {
    errors.push(`aliases must contain at most ${MAX_CARD_ALIASES} values`);
  }
  if (Array.isArray(card.aliases) && card.aliases.some((alias) => !alias || alias.length > MAX_CARD_ALIAS_CHARS || /[\r\n]/.test(alias))) {
    errors.push(`aliases must be non-empty, one line, and at most ${MAX_CARD_ALIAS_CHARS} characters each`);
  }
  if (Array.isArray(card.aliases) && new Set(card.aliases.map((alias) => alias.toLowerCase())).size !== card.aliases.length) {
    errors.push("aliases must not contain duplicates");
  }
  if (!card.source_path) errors.push("source_path is required");
  if (!card.body) errors.push("body is required");
  if (card.body.length > MAX_CARD_BODY_CHARS) {
    errors.push(`body must be at most ${MAX_CARD_BODY_CHARS} characters`);
  }
  for (const field of ["created_at", "updated_at", "last_verified_at"]) {
    if (!isValidLocalDate(card[field])) errors.push(`${field} must use a real YYYY-MM-DD date`);
  }
  if (containsCredentialLikeValue(card)) {
    errors.push("card contains a credential-looking value; store a redacted description instead");
  }
  return errors;
}

function isValidLocalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function containsCredentialLikeValue(card) {
  const text = [
    card.title,
    card.project,
    card.tags?.join(" "),
    card.aliases?.join(" "),
    card.source_path,
    card.source_section,
    card.body,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
    /\bsk-(?:proj-)?[a-z0-9_-]{20,}\b/i,
    /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bauthorization\s*:\s*bearer\s+[a-z0-9._~+/-]{12,}\b/i,
  ].some((pattern) => pattern.test(text));
}

export async function loadCardFile(filePath) {
  const text = await readFile(filePath, "utf8");
  return parseCardMarkdown(text, filePath);
}

export async function loadAllCards(root) {
  const files = await listCardFiles(root);
  const cards = [];
  const errors = [];
  for (const file of files) {
    try {
      cards.push(await loadCardFile(file));
    } catch (error) {
      errors.push({ file, error: error.message });
    }
  }
  return { cards, errors };
}

export async function getCard(id, root) {
  const resolved = resolveMemoryRoot(root);
  const transaction = await inspectPendingTransaction(resolved);
  if (transaction.state !== "none") {
    return { card: null, errors: [transactionReadError(transaction)] };
  }
  const { cards, errors } = await loadAllCards(resolved);
  const matches = cards.filter((item) => item.id === id);
  if (matches.length > 1) {
    return {
      card: null,
      errors: [...errors, { file: null, error: `duplicate id ${id} exists in ${matches.length} card files` }],
    };
  }
  const card = matches[0] ?? null;
  if (card && !isCardInCanonicalDirectory(card, resolved)) {
    return {
      card: null,
      errors: [...errors, { file: card.file_path, error: `card ${card.id} is outside its canonical type directory` }],
    };
  }
  return { card, errors };
}

export async function markCardVerified(id, input = {}, root) {
  const cardId = stringOrEmpty(id);
  if (!cardId) return { ok: false, errors: ["id is required"] };
  const resolved = resolveMemoryRoot(root);
  return withStoreLock(resolved, async () => {
    await recoverPendingTransaction(resolved);
    const snapshot = await loadAllCards(resolved);
    if (snapshot.errors.length > 0) {
      return { ok: false, errors: ["store contains unreadable cards; fix validation errors before verifying"], load_errors: snapshot.errors };
    }
    const existing = findSingleCardById(snapshot.cards, cardId);
    if (existing.error) return { ok: false, errors: [existing.error] };
    if (!existing.card) return { ok: false, errors: [`card not found: ${cardId}`] };

    const today = localDateString();
    const card = normalizeCard({
      ...existing.card,
      status: input.status ?? existing.card.status,
      last_verified_at: input.last_verified_at ?? today,
      updated_at: today,
    });
    const errors = validateCard(card);
    if (errors.length > 0) return failedCardWrite(card, errors);

    try {
      const committed = await commitCardMutations(resolved, snapshot.cards, [{ card, existing: existing.card }]);
      return {
        ok: true,
        ...committed.written[0],
        index: committed.index,
        last_verified_at: card.last_verified_at,
        status: card.status,
      };
    } catch (error) {
      return failedCardWrite(card, [error.message]);
    }
  });
}

export async function validateStore(root) {
  const resolved = resolveMemoryRoot(root);
  return validateStoreAtRoot(resolved);
}

async function validateStoreAtRoot(root) {
  const resolved = resolveMemoryRoot(root);
  const { cards, errors: loadErrors } = await loadAllCards(resolved);
  const seen = new Map();
  const cardErrors = [];
  for (const card of cards) {
    const errors = validateCard(card);
    if (seen.has(card.id)) errors.push(`duplicate id also found at ${seen.get(card.id)}`);
    if (card.id) seen.set(card.id, card.file_path);
    if (!isCardInCanonicalDirectory(card, resolved)) {
      errors.push(`card type ${card.type} must be stored in ${CARD_DIRS[card.type]}`);
    }
    if (errors.length > 0) {
      cardErrors.push({ id: card.id || "(missing id)", file: card.file_path, errors });
    }
  }
  return {
    root: resolved,
    ok: loadErrors.length === 0 && cardErrors.length === 0,
    card_count: cards.length,
    load_errors: loadErrors,
    card_errors: cardErrors,
  };
}

export async function reindex(root) {
  const resolved = await ensureMemoryRoot(root);
  return withStoreLock(resolved, async () => {
    await recoverPendingTransaction(resolved);
    return rebuildIndex(resolved);
  });
}

export async function createSnapshot(input = {}, root) {
  const resolved = await ensureMemoryRoot(root);
  return withStoreLock(resolved, async () => {
    await recoverPendingTransaction(resolved);
    const index = await rebuildIndex(resolved);
    if (!index.ok) return { ok: false, errors: ["store validation failed; snapshot was not created"], index };

    const label = normalizeSnapshotLabel(input.label);
    const snapshotRoot = path.join(resolved, "backups");
    await mkdir(snapshotRoot, { recursive: true });
    const finalPath = nextSnapshotPath(snapshotRoot, label);
    const partialPath = `${finalPath}.partial`;
    await mkdir(partialPath, { recursive: false });

    try {
      const files = await listSnapshotSourceFiles(resolved);
      const manifestFiles = [];
      for (const sourcePath of files) {
        const relativePath = path.relative(resolved, sourcePath);
        const destinationPath = path.join(partialPath, relativePath);
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await copyFile(sourcePath, destinationPath);
        const contents = await readFile(destinationPath);
        manifestFiles.push({ path: relativePath.replaceAll("\\", "/"), bytes: contents.length, sha256: sha256(contents) });
      }
      const manifest = {
        version: 1,
        created_at: new Date().toISOString(),
        label: label || null,
        source_root: resolved,
        file_count: manifestFiles.length,
        files: manifestFiles,
      };
      await writeFile(path.join(partialPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await rename(partialPath, finalPath);
      return {
        ok: true,
        snapshot_path: finalPath,
        manifest_path: path.join(finalPath, "manifest.json"),
        file_count: manifestFiles.length,
        index,
      };
    } catch (error) {
      await rm(partialPath, { recursive: true, force: true });
      throw error;
    }
  });
}

function normalizeSnapshotLabel(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function nextSnapshotPath(snapshotRoot, label) {
  const timestamp = snapshotTimestamp();
  const baseName = `snapshot-${timestamp}${label ? `-${label}` : ""}`;
  let attempt = 1;
  while (true) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const candidate = path.join(snapshotRoot, `${baseName}${suffix}`);
    if (!existsSync(candidate) && !existsSync(`${candidate}.partial`)) return candidate;
    attempt += 1;
  }
}

function snapshotTimestamp(date = new Date()) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ];
  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

async function listSnapshotSourceFiles(root) {
  const files = [];
  for (const name of ["cards", "sources", "eval", "indexes"]) {
    const start = path.join(root, name);
    if (!existsSync(start)) continue;
    await walkSnapshotFiles(start, files);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function walkSnapshotFiles(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkSnapshotFiles(filePath, files);
    } else if (
      entry.isFile() &&
      !entry.name.startsWith(LOCK_FILE_NAME) &&
      !entry.name.startsWith(TRANSACTION_FILE_NAME) &&
      !entry.name.endsWith(".tmp")
    ) {
      files.push(filePath);
    }
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function rebuildIndex(root) {
  const validation = await validateStoreAtRoot(root);
  if (!validation.ok) return { ...validation, index_path: null };
  const { cards } = await loadAllCards(root);
  const text = indexTextForCards(root, cards);
  const indexPath = path.join(root, "indexes", "cards.jsonl");
  await commitStoreTransaction(root, [{ file_path: indexPath, after: text }]);
  return {
    root,
    ok: true,
    card_count: cards.length,
    index_path: indexPath,
  };
}

export async function getStoreHealth(root) {
  const resolved = resolveMemoryRoot(root);
  const validation = await validateStoreAtRoot(resolved);
  const { cards } = await loadAllCards(resolved);
  const transaction = await inspectPendingTransaction(resolved);
  const writeLock = await inspectWriteLock(path.join(resolved, "indexes", LOCK_FILE_NAME));
  const statusCounts = Object.fromEntries([...CARD_STATUSES].map((status) => [status, 0]));
  for (const card of cards) statusCounts[card.status] = (statusCounts[card.status] ?? 0) + 1;

  const overdue = cards
    .filter((card) => card.status !== "deprecated" && daysSinceLocalDate(card.last_verified_at) > VERIFICATION_OVERDUE_DAYS)
    .map((card) => ({ id: card.id, title: card.title, last_verified_at: card.last_verified_at, status: card.status }))
    .slice(0, 25);
  const index = await inspectIndex(resolved, cards);
  const sources = inspectSourceIntegrity(cards);
  const warnings = [];
  if (!validation.ok) warnings.push("Card validation has errors; repair the store before writing new memory.");
  if (index.state !== "current") warnings.push(`Index is ${index.state}; run rag_reindex to rebuild it.`);
  if (statusCounts.needs_verification > 0) {
    warnings.push(`${statusCounts.needs_verification} card(s) are marked needs_verification.`);
  }
  if (overdue.length > 0) warnings.push(`${overdue.length} card(s) have not been verified for over ${VERIFICATION_OVERDUE_DAYS} days.`);
  if (sources.missing > 0) warnings.push(`${sources.missing} card(s) reference missing local source evidence.`);
  if (transaction.state !== "none") {
    warnings.push("A pending CodexMemory transaction was found; run rag_reindex to recover it before reading or writing memory.");
  }
  if (writeLock.state === "stale") {
    warnings.push("A stale CodexMemory write lock was found; the next write operation will safely reclaim it.");
  }

  return {
    root: resolved,
    ok:
      validation.ok &&
      index.state === "current" &&
      sources.missing === 0 &&
      transaction.state === "none" &&
      writeLock.state !== "stale",
    card_count: validation.card_count,
    validation: {
      ok: validation.ok,
      load_error_count: validation.load_errors.length,
      card_error_count: validation.card_errors.length,
    },
    status_counts: statusCounts,
    verification: { overdue_after_days: VERIFICATION_OVERDUE_DAYS, overdue },
    sources,
    index,
    transaction,
    write_lock: writeLock,
    warnings,
  };
}

function inspectSourceIntegrity(cards) {
  const missing_sources = [];
  let checked = 0;
  let existing = 0;
  let uncheckable = 0;
  for (const card of cards) {
    if (!isAbsoluteFilesystemPath(card.source_path)) {
      uncheckable += 1;
      continue;
    }
    checked += 1;
    if (existsSync(card.source_path)) {
      existing += 1;
      continue;
    }
    if (missing_sources.length < 25) {
      missing_sources.push({ id: card.id, source_path: card.source_path });
    }
  }
  return { checked, existing, missing: checked - existing, uncheckable, missing_sources };
}

function isAbsoluteFilesystemPath(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (process.platform === "win32") return /^[a-z]:[\\/]/i.test(text);
  return path.isAbsolute(text);
}

async function inspectIndex(root, cards) {
  const indexPath = path.join(root, "indexes", "cards.jsonl");
  let text;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", path: indexPath, record_count: 0 };
    return { state: "invalid", path: indexPath, record_count: 0, error: "index could not be read" };
  }

  let indexed;
  try {
    indexed = text
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return { state: "invalid", path: indexPath, record_count: 0, error: "index contains invalid JSONL" };
  }

  const expected = cards
    .slice()
    .sort((a, b) => String(a.file_path).localeCompare(String(b.file_path)))
    .map((card) => cardIndexRecordForIndex(card, root));
  const current =
    indexed.length === expected.length && indexed.every((record, index) => JSON.stringify(record) === JSON.stringify(expected[index]));
  return { state: current ? "current" : "stale", path: indexPath, record_count: indexed.length };
}

function daysSinceLocalDate(value) {
  if (!isValidLocalDate(value)) return Number.POSITIVE_INFINITY;
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor((Date.now() - Date.UTC(year, month - 1, day)) / 86400000);
}

async function withStoreLock(root, operation) {
  const lockPath = path.join(root, "indexes", LOCK_FILE_NAME);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const owner = randomUUID();
  let acquired = false;

  while (!acquired) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, owner, pid: process.pid, acquired_at: new Date().toISOString() }) + "\n",
          "utf8",
        );
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = await inspectWriteLock(lockPath);
      if (observed.state === "stale" && (await reclaimStaleLock(lockPath, observed))) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for CodexMemory write lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  const heartbeat = setInterval(() => {
    void refreshStoreLock(lockPath, owner);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await releaseStoreLock(lockPath, owner);
  }
}

async function inspectWriteLock(lockPath) {
  try {
    const details = await stat(lockPath);
    const record = await readLockRecord(lockPath);
    const expired = Date.now() - details.mtimeMs > LOCK_STALE_MS;
    const liveOwner = expired && isProcessAlive(record?.pid);
    return {
      state: expired && !liveOwner ? "stale" : "active",
      owner: record?.owner ?? null,
      pid: Number.isInteger(record?.pid) ? record.pid : null,
      path: lockPath,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", owner: null, path: lockPath };
    throw error;
  }
}

function isProcessAlive(value) {
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLockRecord(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function reclaimStaleLock(lockPath, observed) {
  const current = await inspectWriteLock(lockPath);
  if (current.state !== "stale") return false;
  if (observed.owner && current.owner !== observed.owner) return false;
  await rm(lockPath, { force: true });
  return true;
}

async function refreshStoreLock(lockPath, owner) {
  try {
    const record = await readLockRecord(lockPath);
    if (record?.owner !== owner) return;
    const now = new Date();
    await utimes(lockPath, now, now);
  } catch {
    // The owner check prevents an older operation from refreshing a replacement lock.
  }
}

async function releaseStoreLock(lockPath, owner) {
  const record = await readLockRecord(lockPath);
  if (record?.owner === owner) await rm(lockPath, { force: true });
}

async function writeFileAtomically(filePath, text) {
  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporaryPath, text, "utf8");
  try {
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function cardPathFor(root, card) {
  return path.join(root, "cards", CARD_DIRS[card.type] ?? "workflows", `${card.id}.md`);
}

function isCardInCanonicalDirectory(card, root) {
  const directory = CARD_DIRS[card.type];
  if (!directory || !card.file_path) return true;
  return path.resolve(card.file_path) === path.resolve(cardPathFor(root, card));
}

function relativePathWithinRoot(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) {
    throw new Error(`transaction path escapes the CodexMemory root: ${filePath}`);
  }
  return relative.replaceAll("\\", "/");
}

function resolveTransactionPath(root, relativePath) {
  const text = String(relativePath ?? "").replaceAll("/", path.sep);
  if (!text || path.isAbsolute(text) || text.split(/[\\/]+/).includes("..")) {
    throw new Error("transaction contains an unsafe relative path");
  }
  const target = path.resolve(root, text);
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) {
    throw new Error("transaction path escapes the CodexMemory root");
  }
  return target;
}

function transactionPathFor(root) {
  return path.join(root, "indexes", TRANSACTION_FILE_NAME);
}

async function readTextIfPresent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function commitStoreTransaction(root, changes) {
  const pending = await inspectPendingTransaction(root);
  if (pending.state !== "none") {
    throw new Error("a CodexMemory transaction is already pending; run rag_reindex to recover it first");
  }
  const operations = await prepareTransactionOperations(root, changes);
  if (operations.length === 0) return { operation_count: 0 };

  const journalPath = transactionPathFor(root);
  const journal = {
    version: TRANSACTION_VERSION,
    state: "prepared",
    created_at: new Date().toISOString(),
    operations,
  };
  await writeFileAtomically(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  try {
    await applyTransactionOperations(root, operations, "after");
    await writeFileAtomically(journalPath, `${JSON.stringify({ ...journal, state: "committed" }, null, 2)}\n`);
    await rm(journalPath, { force: true });
    return { operation_count: operations.length };
  } catch (error) {
    try {
      await applyTransactionOperations(root, operations, "before");
      await rm(journalPath, { force: true });
    } catch (rollbackError) {
      throw new Error(`${error.message}; automatic rollback failed: ${rollbackError.message}`);
    }
    throw error;
  }
}

async function prepareTransactionOperations(root, changes) {
  const byPath = new Map();
  for (const change of changes) {
    const target = path.resolve(change.file_path);
    const relative = relativePathWithinRoot(root, target);
    const after = change.after === null ? null : String(change.after);
    const existing = byPath.get(relative);
    if (existing) existing.after = after;
    else byPath.set(relative, { path: relative, after });
  }
  const operations = [];
  for (const operation of byPath.values()) {
    const target = resolveTransactionPath(root, operation.path);
    operations.push({ ...operation, before: await readTextIfPresent(target) });
  }
  return operations;
}

async function applyTransactionOperations(root, operations, field) {
  for (const operation of operations) {
    const target = resolveTransactionPath(root, operation.path);
    const contents = operation[field];
    if (contents === null) {
      await rm(target, { force: true });
      continue;
    }
    if (typeof contents !== "string") throw new Error(`transaction ${field} contents must be a string or null`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomically(target, contents);
  }
}

async function inspectPendingTransaction(root) {
  const journalPath = transactionPathFor(root);
  let raw;
  try {
    raw = await readFile(journalPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "none", path: journalPath };
    return { state: "invalid", path: journalPath, error: "transaction journal could not be read" };
  }

  try {
    const journal = JSON.parse(raw);
    if (
      journal?.version !== TRANSACTION_VERSION ||
      !["prepared", "committed"].includes(journal.state) ||
      !Array.isArray(journal.operations) ||
      journal.operations.some(
        (operation) =>
          !operation ||
          typeof operation.path !== "string" ||
          ![operation.before, operation.after].every((value) => value === null || typeof value === "string"),
      )
    ) {
      return { state: "invalid", path: journalPath, error: "transaction journal has an invalid shape" };
    }
    for (const operation of journal.operations) resolveTransactionPath(root, operation.path);
    return { state: journal.state, path: journalPath, journal };
  } catch (error) {
    return { state: "invalid", path: journalPath, error: `transaction journal is invalid: ${error.message}` };
  }
}

async function recoverPendingTransaction(root) {
  const pending = await inspectPendingTransaction(root);
  if (pending.state === "none") return pending;
  if (pending.state === "invalid") throw new Error(`${pending.error}; repair the journal manually before writing memory`);
  const field = pending.state === "committed" ? "after" : "before";
  await applyTransactionOperations(root, pending.journal.operations, field);
  await rm(pending.path, { force: true });
  return { ...pending, recovered: field };
}

function transactionReadError(transaction) {
  return {
    file: transaction.path,
    error:
      transaction.state === "invalid"
        ? transaction.error
        : "a CodexMemory transaction is pending; run rag_reindex to recover it before reading memory",
  };
}

function cardIndexRecord(card) {
  return {
    id: card.id,
    title: card.title,
    type: card.type,
    scope: card.scope,
    project: card.project,
    status: card.status,
    confidence: card.confidence,
    tags: card.tags,
    aliases: card.aliases,
    source_path: card.source_path,
    source_section: card.source_section,
    updated_at: card.updated_at,
    last_verified_at: card.last_verified_at,
    summary: extractSummary(card.body),
    file_path: card.file_path,
  };
}

function cardIndexRecordForIndex(card, root) {
  return {
    ...cardIndexRecord(card),
    file_path: card.file_path ? relativePathWithinRoot(root, card.file_path) : null,
  };
}

function indexTextForCards(root, cards) {
  const ordered = cards.slice().sort((a, b) => String(a.file_path).localeCompare(String(b.file_path)));
  const lines = ordered.map((card) => JSON.stringify(cardIndexRecordForIndex(card, root)));
  return lines.join("\n") + (lines.length ? "\n" : "");
}

export async function searchCards(input = {}, root) {
  const resolved = resolveMemoryRoot(root);
  const query = stringOrEmpty(input.query);
  const limit = clampNumber(input.limit, 5, 1, 50);
  const wantedTags = normalizeTags(input.tags);
  const wantedType = stringOrEmpty(input.type);
  const wantedProject = stringOrEmpty(input.project);
  const includeDeprecated = Boolean(input.include_deprecated);
  const transaction = await inspectPendingTransaction(resolved);
  if (transaction.state !== "none") {
    return {
      root: resolved,
      query,
      count: 0,
      results: [],
      load_errors: [transactionReadError(transaction)],
    };
  }
  const { cards, errors } = await loadAllCards(resolved);
  const { blockedIds, errors: integrityErrors } = collectReadIntegrityErrors(cards, resolved);
  const scored = [];
  for (const card of cards) {
    if (blockedIds.has(card.id)) continue;
    if (!includeDeprecated && card.status === "deprecated") continue;
    if (wantedType && card.type !== wantedType) continue;
    if (wantedProject && String(card.project ?? "") !== wantedProject) continue;
    if (wantedTags.length > 0 && !wantedTags.every((tag) => card.tags.includes(tag))) continue;
    const match = query ? analyzeQueryMatch(card, query) : null;
    if (query && !match.hasOverlap) continue;
    const score = scoreCard(card, match, wantedTags, wantedType, wantedProject);
    if (query && score <= 0) continue;
    scored.push({
      ...cardIndexRecord(card),
      score,
      match_reason: explainMatch(match),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    root: resolved,
    query,
    count: scored.length,
    results: scored.slice(0, limit),
    load_errors: [...errors, ...integrityErrors],
  };
}

export async function createTaskBrief(input = {}, root) {
  const resolved = resolveMemoryRoot(root);
  const search = await searchCards(
    { ...input, limit: clampNumber(input.limit, 3, 1, 10) },
    resolved,
  );
  const health = await getStoreHealth(resolved);
  const reminders = [];
  for (const card of search.results) {
    if (card.status === "needs_verification") {
      reminders.push({
        code: "needs_verification",
        id: card.id,
        title: card.title,
        message: "Card is marked needs_verification; recheck its source before relying on it.",
      });
    }
    if (card.status !== "deprecated" && daysSinceLocalDate(card.last_verified_at) > VERIFICATION_OVERDUE_DAYS) {
      reminders.push({
        code: "overdue_verification",
        id: card.id,
        title: card.title,
        message: `Card has not been verified for over ${VERIFICATION_OVERDUE_DAYS} days.`,
      });
    }
  }
  const warnings = [...new Set([
    ...health.warnings,
    ...search.load_errors.map((item) => item.error),
  ])];
  return {
    root: resolved,
    ok: health.ok && search.load_errors.length === 0,
    query: search.query,
    results: search.results,
    reminders,
    warnings,
    load_errors: search.load_errors,
    health: {
      ok: health.ok,
      index: health.index,
      transaction: health.transaction,
      sources: health.sources,
    },
    boundary:
      "Treat this brief as supporting local memory only. Re-verify commands, paths, ports, versions and external facts before acting.",
  };
}

export function formatTaskBrief(brief, options = {}) {
  const maxSummaryChars = clampNumber(options.max_summary_chars, 120, 40, 240);
  const lines = [
    `CodexMemory brief: "${brief.query}"`,
    `Relevant cards: ${brief.results.length}.`,
  ];
  if (brief.results.length === 0) {
    lines.push("No matching cards. Do not create a filler memory card just because the brief is empty.");
  } else {
    for (const [index, card] of brief.results.entries()) {
      lines.push(`${index + 1}. ${card.id} | ${card.title} | match=${card.match_reason} | ${shortSource(card)}`);
      lines.push(`   note=${compactText(card.summary, maxSummaryChars)}`);
    }
  }
  if (brief.reminders.length > 0) {
    lines.push("Verification reminders:");
    for (const reminder of brief.reminders) lines.push(`- ${reminder.id}: ${reminder.message}`);
  }
  if (brief.warnings.length > 0) {
    lines.push("Store warnings:");
    for (const warning of brief.warnings) lines.push(`- ${warning}`);
  }
  lines.push(`Boundary: ${brief.boundary}`);
  return lines.join("\n");
}

export async function createMaintenancePlan(input = {}, root) {
  const resolved = resolveMemoryRoot(root);
  const limit = clampNumber(input.limit, 50, 1, 100);
  const health = await getStoreHealth(resolved);
  const { cards, errors } = await loadAllCards(resolved);
  const integrity = collectReadIntegrityErrors(cards, resolved);
  const suggestions = [];
  const cardsById = new Map(cards.map((card) => [card.id, card]));

  for (const card of cards) {
    if (card.status !== "deprecated" && daysSinceLocalDate(card.last_verified_at) > VERIFICATION_OVERDUE_DAYS) {
      suggestions.push(maintenanceSuggestion({
        code: "verify",
        priority: "high",
        card_ids: [card.id],
        reason: `Last verified on ${card.last_verified_at}, over ${VERIFICATION_OVERDUE_DAYS} days ago.`,
        next_step: "Recheck the cited evidence, then use rag_mark_verified only if the evidence is still valid.",
        evidence: { last_verified_at: card.last_verified_at },
      }));
    }
    if (isAbsoluteFilesystemPath(card.source_path) && !existsSync(card.source_path)) {
      suggestions.push(maintenanceSuggestion({
        code: "source_missing",
        priority: "high",
        card_ids: [card.id],
        reason: "The card's absolute local source path no longer exists.",
        next_step: "Locate or replace the evidence before relying on the card; do not silently change its status.",
        evidence: { source_path: card.source_path },
      }));
    }
    if (["active", "needs_verification"].includes(card.status) && card.aliases.length === 0) {
      suggestions.push(maintenanceSuggestion({
        code: "add_aliases",
        priority: "low",
        card_ids: [card.id],
        reason: "The active card has no reviewed natural-language aliases.",
        next_step: "Add only reviewed common phrasings or bilingual equivalents after checking the card's source.",
        evidence: { aliases: [] },
      }));
    }
  }

  for (const duplicate of exactDuplicateGroups(cards)) {
    suggestions.push(maintenanceSuggestion({
      code: "possible_duplicate",
      priority: "medium",
      card_ids: duplicate.card_ids,
      reason: `Cards share the same normalized ${duplicate.field}: ${duplicate.value}`,
      next_step: "Compare the cited evidence and merge or deprecate only after a human review; this plan makes no change.",
      evidence: { field: duplicate.field, value: duplicate.value },
    }));
  }

  suggestions.sort((a, b) => maintenancePriority(b.priority) - maintenancePriority(a.priority) || a.code.localeCompare(b.code) || a.card_ids.join(",").localeCompare(b.card_ids.join(",")));
  const warnings = [...new Set([
    ...health.warnings,
    ...errors.map((item) => item.error),
    ...integrity.errors.map((item) => item.error),
  ])];
  return {
    root: resolved,
    ok: health.validation.ok && health.transaction.state === "none" && errors.length === 0 && integrity.errors.length === 0,
    suggestions: suggestions.slice(0, limit),
    total_suggestions: suggestions.length,
    warnings,
    load_errors: [...errors, ...integrity.errors],
    health: {
      validation: health.validation,
      index: health.index,
      transaction: health.transaction,
      sources: health.sources,
    },
    boundary:
      "This plan is read-only. It never verifies, rewrites, merges, deprecates, reindexes or deletes a card.",
    cards: Object.fromEntries([...cardsById].map(([id, card]) => [id, { title: card.title, status: card.status }])),
  };
}

export function formatMaintenancePlan(plan) {
  const lines = [
    "CodexMemory maintenance plan",
    `Suggestions: ${plan.suggestions.length} shown of ${plan.total_suggestions}.`,
  ];
  if (plan.suggestions.length === 0) {
    lines.push("No evidence-backed maintenance action is currently suggested.");
  } else {
    for (const [index, suggestion] of plan.suggestions.entries()) {
      const cardLabels = suggestion.card_ids
        .map((id) => `${id}${plan.cards[id]?.title ? ` (${plan.cards[id].title})` : ""}`)
        .join(", ");
      lines.push(`${index + 1}. [${suggestion.priority}] ${suggestion.code} | ${cardLabels}`);
      lines.push(`   reason=${suggestion.reason}`);
      lines.push(`   next=${suggestion.next_step}`);
    }
  }
  if (plan.warnings.length > 0) {
    lines.push("Store warnings:");
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  lines.push(`Boundary: ${plan.boundary}`);
  return lines.join("\n");
}

function maintenanceSuggestion(suggestion) {
  return { ...suggestion, card_ids: [...new Set(suggestion.card_ids)].sort((a, b) => a.localeCompare(b)) };
}

function maintenancePriority(priority) {
  if (priority === "high") return 3;
  if (priority === "medium") return 2;
  return 1;
}

function exactDuplicateGroups(cards) {
  const groups = new Map();
  for (const card of cards) {
    addDuplicateCandidate(groups, "title", card.title, card.id);
    for (const alias of card.aliases) addDuplicateCandidate(groups, "alias", alias, card.id);
  }
  return [...groups.values()]
    .filter((group) => group.card_ids.size > 1)
    .map((group) => ({ ...group, card_ids: [...group.card_ids].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.field.localeCompare(b.field) || a.value.localeCompare(b.value));
}

function addDuplicateCandidate(groups, field, value, id) {
  const normalized = normalizeComparableText(value);
  if (!normalized || normalized.length < 3) return;
  const key = `${field}:${normalized}`;
  const current = groups.get(key) ?? { field, value: String(value).trim(), card_ids: new Set() };
  current.card_ids.add(id);
  groups.set(key, current);
}

function normalizeComparableText(text) {
  return normalizeText(text).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function collectReadIntegrityErrors(cards, root) {
  const counts = new Map();
  for (const card of cards) counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
  const blockedIds = new Set();
  const errors = [];
  for (const [id, count] of counts) {
    if (id && count > 1) {
      blockedIds.add(id);
      errors.push({ file: null, error: `duplicate id ${id} exists in ${count} card files` });
    }
  }
  for (const card of cards) {
    if (!isCardInCanonicalDirectory(card, root)) {
      blockedIds.add(card.id);
      errors.push({ file: card.file_path, error: `card ${card.id} is outside its canonical type directory` });
    }
  }
  return { blockedIds, errors };
}

export function formatSearchResults(result, options = {}) {
  const verbose = Boolean(options.verbose);
  const maxSummaryChars = clampNumber(options.max_summary_chars, 80, 40, 240);
  const lines = [
    `CodexMemory search: "${result.query}"`,
    `Found ${result.count} result(s); showing ${result.results.length}. Use rag_get(id) for full card.`,
  ];
  if (result.load_errors?.length) {
    lines.push(`Load warnings: ${result.load_errors.length}`);
  }
  if (result.results.length === 0) {
    lines.push("No matching cards.");
    return lines.join("\n");
  }
  for (const [index, item] of result.results.entries()) {
    lines.push(
      `${index + 1}. ${item.id} | ${item.title} | score=${item.score} | ${item.type}/${item.status} | ${shortSource(item)} | match=${item.match_reason}`,
    );
    if (verbose) {
      lines.push(`   tags=${item.tags.join(", ")}`);
      lines.push(`   note=${compactText(item.summary, maxSummaryChars)}`);
    }
  }
  return lines.join("\n");
}

function shortSource(item) {
  const file = item.source_path ? path.basename(item.source_path) : "unknown";
  return item.source_section ? `${file}#${item.source_section}` : file;
}

function compactText(text, maxChars) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}...`;
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  if (typeof tags === "string") {
    return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

function scoreCard(card, match, wantedTags, wantedType, wantedProject) {
  let score = 0;
  if (wantedType && card.type === wantedType) score += 20;
  if (wantedProject && String(card.project ?? "") === wantedProject) score += 20;
  score += wantedTags.filter((tag) => card.tags.includes(tag)).length * 12;
  if (!match) return score + freshnessScore(card) + confidenceScore(card);

  for (const field of match.phraseFields) score += field.phraseScore;
  for (const field of match.fields) score += field.termCount * field.termScore;
  score += match.coverage.count * 32;
  score += Math.round(match.coverage.ratio * 80);
  return score + freshnessScore(card) + confidenceScore(card);
}

function analyzeQueryMatch(card, query) {
  const phrase = normalizeText(query);
  const terms = queryTerms(query);
  const fields = searchFields(card);
  const matchedTerms = new Set();
  const fieldMatches = fields.map((field) => {
    const matches = terms.filter((term) => field.text.includes(term));
    for (const term of matches) matchedTerms.add(term);
    return { ...field, terms: matches, termCount: matches.length };
  });
  const phraseFields = fieldMatches.filter((field) => phrase && field.text.includes(phrase));
  return {
    phrase,
    terms,
    fields: fieldMatches,
    phraseFields,
    coverage: {
      count: matchedTerms.size,
      total: terms.length,
      ratio: terms.length ? matchedTerms.size / terms.length : 0,
    },
    hasOverlap: phraseFields.length > 0 || matchedTerms.size > 0,
  };
}

function searchFields(card) {
  return [
    { name: "title", text: normalizeText(card.title), termScore: 30, phraseScore: 260 },
    { name: "alias", text: normalizeText(card.aliases?.join(" ")), termScore: 28, phraseScore: 230 },
    { name: "tag", text: normalizeText(card.tags.join(" ")), termScore: 22, phraseScore: 190 },
    { name: "source", text: normalizeText(`${card.source_path} ${card.source_section}`), termScore: 12, phraseScore: 75 },
    { name: "body", text: normalizeText(card.body), termScore: 8, phraseScore: 45 },
  ];
}

function explainMatch(match) {
  if (!match) return "filtered/browsed";
  const reasons = [];
  for (const field of match.phraseFields) reasons.push(`${field.name} phrase`);
  for (const field of match.fields) {
    if (field.termCount > 0) reasons.push(`${field.name} tokens ${field.termCount}/${match.coverage.total}`);
  }
  return reasons.join("; ") || "no match evidence";
}

function freshnessScore(card) {
  const text = card.last_verified_at || card.updated_at;
  const time = Date.parse(text);
  if (!Number.isFinite(time)) return 0;
  const days = (Date.now() - time) / 86400000;
  if (days < 30) return 5;
  if (days < 180) return 2;
  return 0;
}

function confidenceScore(card) {
  if (card.confidence === "high") return 5;
  if (card.confidence === "medium") return 2;
  return 0;
}

function normalizeText(text) {
  return String(text ?? "").toLowerCase();
}

function queryTerms(text) {
  const normalized = normalizeText(text);
  const words = [...normalized.matchAll(/[a-z0-9_-]+/g)]
    .map((match) => match[0])
    .filter((word) => word.length >= 2 && !SEARCH_STOP_WORDS.has(word));
  const hanBigrams = [];
  for (const match of normalized.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu)) {
    const characters = [...match[0]];
    for (let index = 0; index < characters.length - 1; index += 1) {
      const bigram = characters.slice(index, index + 2).join("");
      if (!CJK_STOP_BIGRAMS.has(bigram)) hanBigrams.push(bigram);
    }
  }
  return [...new Set([...words, ...hanBigrams])];
}

const SEARCH_STOP_WORDS = new Set(["a", "an", "and", "for", "in", "is", "of", "on", "or", "the", "to", "with"]);
const CJK_STOP_BIGRAMS = new Set(["一个", "一些", "什么", "怎么", "这样", "那样", "这个", "那个"]);

function extractSummary(body) {
  const lines = String(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines.slice(0, 3).join(" ").slice(0, 360);
}

export async function upsertCard(input, root) {
  const resolved = resolveMemoryRoot(root);
  const proposed = normalizeCard(input);
  const errors = validateCard(proposed);
  if (errors.length > 0) return failedCardWrite(proposed, errors);

  await ensureMemoryRoot(resolved);
  return withStoreLock(resolved, async () => {
    await recoverPendingTransaction(resolved);
    const snapshot = await loadAllCards(resolved);
    if (snapshot.errors.length > 0) {
      return failedCardWrite(proposed, ["store contains unreadable cards; fix validation errors before writing"]);
    }
    const existing = findSingleCardById(snapshot.cards, proposed.id);
    if (existing.error) return failedCardWrite(proposed, [existing.error]);

    const card = prepareCardForUpsert(input, existing.card);
    const finalErrors = validateCard(card);
    if (finalErrors.length > 0) return failedCardWrite(card, finalErrors);

    try {
      const committed = await commitCardMutations(resolved, snapshot.cards, [{ card, existing: existing.card }]);
      return { ok: true, ...committed.written[0], index: committed.index };
    } catch (error) {
      return failedCardWrite(card, [error.message]);
    }
  });
}

export async function recordTaskCompletion(input = {}, root) {
  const resolved = resolveMemoryRoot(root);
  const lessons = Array.isArray(input.lessons) ? input.lessons : [];
  if (lessons.length === 0) {
    return completionResult(resolved, input, lessons, [], [{ error: "lessons must contain at least one card" }], null);
  }
  if (lessons.length > 5) {
    return completionResult(resolved, input, lessons, [], [{ error: "lessons may contain at most 5 cards" }], null);
  }

  const proposed = lessons.map((lesson, index) => completionLessonToCard(lesson ?? {}, input, index + 1));
  const errors = [];
  const seen = new Set();
  for (const [index, card] of proposed.entries()) {
    const cardErrors = validateCard(card);
    if (seen.has(card.id)) cardErrors.push("duplicate id in task-completion batch");
    seen.add(card.id);
    if (cardErrors.length > 0) errors.push({ lesson_index: index, errors: cardErrors, card: cardIndexRecord(card) });
  }
  if (errors.length > 0) return completionResult(resolved, input, lessons, [], errors, null);

  await ensureMemoryRoot(resolved);
  return withStoreLock(resolved, async () => {
    await recoverPendingTransaction(resolved);
    const snapshot = await loadAllCards(resolved);
    if (snapshot.errors.length > 0) {
      return completionResult(resolved, input, lessons, [], [{ error: "store contains unreadable cards; fix validation errors before writing" }], null);
    }

    const mutations = [];
    for (const candidate of proposed) {
      const existing = findSingleCardById(snapshot.cards, candidate.id);
      if (existing.error) {
        return completionResult(resolved, input, lessons, [], [{ error: existing.error }], null);
      }
      const card = prepareCardForUpsert(candidate, existing.card);
      const cardErrors = validateCard(card);
      if (cardErrors.length > 0) {
        return completionResult(resolved, input, lessons, [], [{ errors: cardErrors, card: cardIndexRecord(card) }], null);
      }
      mutations.push({ card, existing: existing.card });
    }

    try {
      const committed = await commitCardMutations(resolved, snapshot.cards, mutations);
      return completionResult(resolved, input, lessons, committed.written, [], committed.index);
    } catch (error) {
      return completionResult(resolved, input, lessons, [], [{ error: error.message }], null);
    }
  });
}

function failedCardWrite(card, errors) {
  return { ok: false, errors, card: cardIndexRecord(card) };
}

function findSingleCardById(cards, id) {
  const matches = cards.filter((card) => card.id === id);
  if (matches.length > 1) return { card: null, error: `duplicate id ${id} already exists in ${matches.length} card files` };
  return { card: matches[0] ?? null, error: null };
}

function prepareCardForUpsert(input, existing) {
  const today = localDateString();
  return normalizeCard({
    ...input,
    created_at: existing?.created_at ?? input.created_at ?? today,
    updated_at: input.updated_at ?? today,
    last_verified_at: input.last_verified_at ?? existing?.last_verified_at ?? today,
  });
}

async function commitCardMutations(root, cards, mutations) {
  const nextCards = cards.slice();
  const changes = [];
  const written = [];

  for (const { card, existing } of mutations) {
    const filePath = cardPathFor(root, card);
    changes.push({ file_path: filePath, after: formatCardMarkdown(card) });
    if (existing?.file_path && path.resolve(existing.file_path) !== path.resolve(filePath)) {
      changes.push({ file_path: existing.file_path, after: null });
    }

    const indexedCard = { ...card, file_path: filePath };
    if (existing) {
      const index = nextCards.indexOf(existing);
      if (index < 0) throw new Error(`card ${card.id} disappeared while preparing the transaction`);
      nextCards.splice(index, 1, indexedCard);
    } else {
      nextCards.push(indexedCard);
    }
    written.push({ id: card.id, file_path: filePath });
  }

  const errors = validateCardCollection(nextCards, root);
  if (errors.length > 0) throw new Error(`transaction would create an invalid store: ${errors.join("; ")}`);
  const indexPath = path.join(root, "indexes", "cards.jsonl");
  changes.push({ file_path: indexPath, after: indexTextForCards(root, nextCards) });
  await commitStoreTransaction(root, changes);
  return {
    written,
    index: {
      root,
      ok: true,
      card_count: nextCards.length,
      index_path: indexPath,
    },
  };
}

function validateCardCollection(cards, root) {
  const errors = [];
  const seen = new Map();
  for (const card of cards) {
    const cardErrors = validateCard(card);
    if (seen.has(card.id)) cardErrors.push(`duplicate id also found at ${seen.get(card.id)}`);
    if (card.id) seen.set(card.id, card.file_path);
    if (!isCardInCanonicalDirectory(card, root)) {
      cardErrors.push(`card type ${card.type} must be stored in ${CARD_DIRS[card.type]}`);
    }
    if (cardErrors.length > 0) errors.push(`${card.id || "(missing id)"}: ${cardErrors.join(", ")}`);
  }
  return errors;
}

function completionResult(root, input, lessons, written, errors, index) {
  return {
    root,
    ok: errors.length === 0 && (index === null || index.ok),
    task_summary: stringOrEmpty(input.task_summary),
    project: input.project ?? null,
    outcome: input.outcome ?? null,
    lesson_count: lessons.length,
    written,
    errors,
    index,
  };
}

function completionLessonToCard(lesson, task, ordinal) {
  const today = localDateString();
  const title = stringOrDefault(lesson.title, `Reusable lesson from ${task.project ?? "task"}`);
  return {
    id: lesson.id || `${slugify(title)}-${today.replaceAll("-", "")}-${String(ordinal).padStart(2, "0")}`,
    title,
    type: stringOrDefault(lesson.type, "workflow"),
    scope: stringOrDefault(lesson.scope, "global"),
    project: lesson.project ?? task.project ?? null,
    status: stringOrDefault(lesson.status, "active"),
    confidence: stringOrDefault(lesson.confidence, "medium"),
    tags: Array.isArray(lesson.tags) ? lesson.tags : ["task-completion"],
    aliases: Array.isArray(lesson.aliases) ? lesson.aliases : [],
    source_path: stringOrDefault(lesson.source_path, task.source_path || "task completion"),
    source_section: stringOrDefault(lesson.source_section, task.source_section || "task completion analysis"),
    created_at: stringOrDefault(lesson.created_at, today),
    updated_at: stringOrDefault(lesson.updated_at, today),
    last_verified_at: stringOrDefault(lesson.last_verified_at, today),
    body: lesson.body || formatCompletionBody(lesson, task),
  };
}

function formatCompletionBody(lesson, task) {
  const problem = stringOrDefault(lesson.problem, "Task produced a reusable lesson.");
  const solution = stringOrDefault(lesson.solution, lesson.summary || "Record and reuse this lesson in future similar tasks.");
  const applies = stringOrDefault(lesson.applies, task.project || "future Codex tasks");
  const risks = stringOrDefault(lesson.risks, "Re-check paths, commands, ports and versions before applying this memory.");
  const evidence = stringOrDefault(lesson.evidence, task.task_summary || "Captured during task completion analysis.");
  return [
    "## Problem",
    "",
    problem,
    "",
    "## Solution",
    "",
    solution,
    "",
    "## Applies",
    "",
    applies,
    "",
    "## Risks",
    "",
    risks,
    "",
    "## Evidence",
    "",
    evidence,
  ].join("\n");
}

function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "memory-card";
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatCardMarkdown(card) {
  const metadata = [
    ["id", card.id],
    ["title", card.title],
    ["type", card.type],
    ["scope", card.scope],
    ["project", card.project ?? "null"],
    ["status", card.status],
    ["confidence", card.confidence],
    ["tags", card.tags],
    ["aliases", card.aliases ?? []],
    ["source_path", card.source_path],
    ["source_section", card.source_section],
    ["created_at", card.created_at],
    ["updated_at", card.updated_at],
    ["last_verified_at", card.last_verified_at],
  ];
  const lines = ["---"];
  for (const [key, value] of metadata) {
    lines.push(`${key}: ${formatValue(value)}`);
  }
  lines.push("---", "", card.body.trim(), "");
  return lines.join("\n");
}

function formatValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value === null || value === undefined) return "null";
  const text = String(value);
  if (/[:#\[\]{}\r\n"]|^\s|\s$/.test(text)) return JSON.stringify(text);
  return text;
}
