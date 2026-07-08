import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  const lines = text.split(/\r?\n/);
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
    return inner
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter(Boolean);
  }
  return stripQuotes(value);
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function normalizeCard(input) {
  const today = localDateString();
  const tags = Array.isArray(input.tags)
    ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : [];
  return {
    id: stringOrEmpty(input.id),
    title: stringOrEmpty(input.title),
    type: stringOrDefault(input.type, "workflow"),
    scope: stringOrDefault(input.scope, "global"),
    project: input.project === undefined ? null : input.project,
    status: stringOrDefault(input.status, "active"),
    confidence: stringOrDefault(input.confidence, "medium"),
    tags,
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
  if (!card.source_path) errors.push("source_path is required");
  if (!card.body) errors.push("body is required");
  return errors;
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
  const { cards, errors } = await loadAllCards(root);
  const card = cards.find((item) => item.id === id);
  return { card: card ?? null, errors };
}

export async function validateStore(root) {
  const resolved = await ensureMemoryRoot(root);
  const { cards, errors: loadErrors } = await loadAllCards(resolved);
  const seen = new Map();
  const cardErrors = [];
  for (const card of cards) {
    const errors = validateCard(card);
    if (seen.has(card.id)) errors.push(`duplicate id also found at ${seen.get(card.id)}`);
    if (card.id) seen.set(card.id, card.file_path);
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
  const validation = await validateStore(resolved);
  if (!validation.ok) return { ...validation, index_path: null };
  const { cards } = await loadAllCards(resolved);
  const lines = cards.map((card) => JSON.stringify(cardIndexRecord(card)));
  const indexPath = path.join(resolved, "indexes", "cards.jsonl");
  await writeFile(indexPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  return {
    root: resolved,
    ok: true,
    card_count: cards.length,
    index_path: indexPath,
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
    source_path: card.source_path,
    source_section: card.source_section,
    updated_at: card.updated_at,
    last_verified_at: card.last_verified_at,
    summary: extractSummary(card.body),
    file_path: card.file_path,
  };
}

export async function searchCards(input = {}, root) {
  const resolved = resolveMemoryRoot(root);
  const query = stringOrEmpty(input.query);
  const limit = clampNumber(input.limit, 5, 1, 50);
  const wantedTags = normalizeTags(input.tags);
  const wantedType = stringOrEmpty(input.type);
  const wantedProject = stringOrEmpty(input.project);
  const includeDeprecated = Boolean(input.include_deprecated);
  const { cards, errors } = await loadAllCards(resolved);
  const scored = [];
  for (const card of cards) {
    if (!includeDeprecated && card.status === "deprecated") continue;
    if (wantedType && card.type !== wantedType) continue;
    if (wantedProject && String(card.project ?? "") !== wantedProject) continue;
    if (wantedTags.length > 0 && !wantedTags.every((tag) => card.tags.includes(tag))) continue;
    const score = scoreCard(card, query, wantedTags, wantedType, wantedProject);
    if (query && score <= 0) continue;
    scored.push({
      ...cardIndexRecord(card),
      score,
      match_reason: explainMatch(card, query),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    root: resolved,
    query,
    count: scored.length,
    results: scored.slice(0, limit),
    load_errors: errors,
  };
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
      `${index + 1}. ${item.id} | ${item.title} | score=${item.score} | ${item.type}/${item.status} | ${shortSource(item)}`,
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

function scoreCard(card, query, wantedTags, wantedType, wantedProject) {
  let score = 0;
  if (wantedType && card.type === wantedType) score += 20;
  if (wantedProject && String(card.project ?? "") === wantedProject) score += 20;
  score += wantedTags.filter((tag) => card.tags.includes(tag)).length * 12;
  if (!query) return score + freshnessScore(card) + confidenceScore(card);

  const q = normalizeText(query);
  const tokens = tokenize(query);
  const title = normalizeText(card.title);
  const tags = normalizeText(card.tags.join(" "));
  const source = normalizeText(`${card.source_path} ${card.source_section}`);
  const body = normalizeText(card.body);

  if (title.includes(q)) score += 80;
  if (tags.includes(q)) score += 50;
  if (source.includes(q)) score += 20;
  if (body.includes(q)) score += 12;

  for (const token of tokens) {
    if (title.includes(token)) score += 18;
    if (tags.includes(token)) score += 14;
    if (source.includes(token)) score += 6;
    if (body.includes(token)) score += 3;
  }
  return score + freshnessScore(card) + confidenceScore(card);
}

function explainMatch(card, query) {
  if (!query) return "filtered/browsed";
  const q = normalizeText(query);
  const reasons = [];
  if (normalizeText(card.title).includes(q)) reasons.push("title");
  if (normalizeText(card.tags.join(" ")).includes(q)) reasons.push("tags");
  if (normalizeText(card.body).includes(q)) reasons.push("body");
  if (normalizeText(`${card.source_path} ${card.source_section}`).includes(q)) reasons.push("source");
  return reasons.length ? reasons.join(", ") : "token overlap";
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

function tokenize(text) {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function extractSummary(body) {
  const lines = String(body)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return lines.slice(0, 3).join(" ").slice(0, 360);
}

export async function upsertCard(input, root) {
  const resolved = await ensureMemoryRoot(root);
  const card = normalizeCard(input);
  const errors = validateCard(card);
  if (errors.length > 0) {
    return { ok: false, errors, card: cardIndexRecord(card) };
  }
  const dirName = CARD_DIRS[card.type] ?? "workflows";
  const cardDir = path.join(resolved, "cards", dirName);
  await mkdir(cardDir, { recursive: true });
  const filePath = path.join(cardDir, `${card.id}.md`);
  await writeFile(filePath, formatCardMarkdown(card), "utf8");
  return {
    ok: true,
    id: card.id,
    file_path: filePath,
  };
}

export async function recordTaskCompletion(input = {}, root) {
  const resolved = await ensureMemoryRoot(root);
  const lessons = Array.isArray(input.lessons) ? input.lessons : [];
  const written = [];
  const errors = [];

  for (let index = 0; index < lessons.length; index += 1) {
    const lesson = lessons[index] ?? {};
    const card = completionLessonToCard(lesson, input, index + 1);
    const result = await upsertCard(card, resolved);
    if (result.ok) written.push(result);
    else errors.push({ lesson_index: index, errors: result.errors, card: result.card });
  }

  const indexResult = errors.length === 0 ? await reindex(resolved) : null;
  return {
    root: resolved,
    ok: errors.length === 0,
    task_summary: stringOrEmpty(input.task_summary),
    project: input.project ?? null,
    outcome: input.outcome ?? null,
    lesson_count: lessons.length,
    written,
    errors,
    index: indexResult,
  };
}

function completionLessonToCard(lesson, task, ordinal) {
  const today = localDateString();
  const title = stringOrDefault(lesson.title, `Reusable lesson from ${task.project ?? "task"}`);
  return normalizeCard({
    id: lesson.id || `${slugify(title)}-${today.replaceAll("-", "")}-${String(ordinal).padStart(2, "0")}`,
    title,
    type: stringOrDefault(lesson.type, "workflow"),
    scope: stringOrDefault(lesson.scope, "global"),
    project: lesson.project ?? task.project ?? null,
    status: stringOrDefault(lesson.status, "active"),
    confidence: stringOrDefault(lesson.confidence, "medium"),
    tags: Array.isArray(lesson.tags) ? lesson.tags : ["task-completion"],
    source_path: stringOrDefault(lesson.source_path, task.source_path || "task completion"),
    source_section: stringOrDefault(lesson.source_section, task.source_section || "task completion analysis"),
    created_at: stringOrDefault(lesson.created_at, today),
    updated_at: stringOrDefault(lesson.updated_at, today),
    last_verified_at: stringOrDefault(lesson.last_verified_at, today),
    body: lesson.body || formatCompletionBody(lesson, task),
  });
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
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
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
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value === null || value === undefined) return "null";
  const text = String(value);
  if (/[:#\[\]{}]|^\s|\s$/.test(text)) return JSON.stringify(text);
  return text;
}
