#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  formatSearchResults,
  formatMaintenancePlan,
  formatTaskBrief,
  createSnapshot,
  createMaintenancePlan,
  createTaskBrief,
  getCard,
  getStoreHealth,
  markCardVerified,
  recordTaskCompletion,
  reindex,
  resolveMemoryRoot,
  searchCards,
  upsertCard,
  validateStore,
} from "./cardStore.mjs";

const args = process.argv.slice(2);
const command = args.shift();

try {
  if (!command || command === "help" || command === "--help") {
    printHelp();
  } else if (command === "search") {
    const query = collectQuery(args);
    const options = parseOptions(args);
    const result = await searchCards({ query, ...options }, options.root);
    if (options.json || options.format === "json") printJson(result);
    else console.log(formatSearchResults(result));
  } else if (command === "brief") {
    const query = collectQuery(args);
    const options = parseOptions(args);
    const result = await createTaskBrief({ query, ...options }, options.root);
    if (options.json || options.format === "json") printJson(result);
    else console.log(formatTaskBrief(result, options));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "maintenance-plan") {
    const options = parseOptions(args);
    const result = await createMaintenancePlan(options, options.root);
    if (options.json || options.format === "json") printJson(result);
    else console.log(formatMaintenancePlan(result));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "get") {
    const id = args.shift();
    if (!id) throw new Error("get requires an id");
    const options = parseOptions(args);
    const result = await getCard(id, options.root);
    printJson(result);
  } else if (command === "verify") {
    const id = args.shift();
    if (!id) throw new Error("verify requires an id");
    const options = parseOptions(args);
    const result = await markCardVerified(id, { last_verified_at: options.date, status: options.status }, options.root);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "validate") {
    const options = parseOptions(args);
    const result = await validateStore(options.root);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "health") {
    const options = parseOptions(args);
    const result = await getStoreHealth(options.root);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "snapshot") {
    const options = parseOptions(args);
    const result = await createSnapshot({ label: options.label }, options.root);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "reindex") {
    const options = parseOptions(args);
    const result = await reindex(options.root);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "upsert") {
    const file = args.shift();
    if (!file) throw new Error("upsert requires a JSON file path");
    const options = parseOptions(args);
    const card = JSON.parse(await readFile(file, "utf8"));
    const result = await upsertCard(card, options.root);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "finish") {
    const file = args.shift();
    if (!file) throw new Error("finish requires a JSON file path");
    const options = parseOptions(args);
    const payload = JSON.parse(await readFile(file, "utf8"));
    const result = await recordTaskCompletion(payload, options.root);
    printJson(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "root") {
    const options = parseOptions(args);
    console.log(resolveMemoryRoot(options.root));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function printHelp() {
  console.log(`codex-memory commands:
  search <query> [--limit N] [--type TYPE] [--tags a,b] [--project NAME] [--root PATH]
  search <query> --json
  brief <query> [--limit N] [--project NAME] [--include-deprecated true] [--root PATH]
  brief <query> --json
  maintenance-plan [--limit N] [--root PATH]
  maintenance-plan --json
  get <id> [--root PATH]
  verify <id> [--date YYYY-MM-DD] [--status STATUS] [--root PATH]
  upsert <card.json> [--root PATH]
  finish <task-completion.json> [--root PATH]
  validate [--root PATH]
  health [--root PATH]
  snapshot [--label TEXT] [--root PATH]
  reindex [--root PATH]
  root [--root PATH]
`);
}

function collectQuery(values) {
  const parts = [];
  while (values.length > 0 && !values[0].startsWith("--")) {
    parts.push(values.shift());
  }
  return parts.join(" ");
}

function parseOptions(values) {
  const options = {};
  while (values.length > 0) {
    const key = values.shift();
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2).replace(/-/g, "_");
    if (name === "json") {
      if (values[0] === "false") {
        values.shift();
        options.json = false;
      } else {
        options.json = true;
      }
      continue;
    }
    const value = values.shift();
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    if (name === "limit") options.limit = Number(value);
    else if (name === "tags") options.tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
    else options[name] = value;
  }
  return options;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
