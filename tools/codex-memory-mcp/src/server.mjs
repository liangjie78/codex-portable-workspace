#!/usr/bin/env node
import {
  formatSearchResults,
  getCard,
  recordTaskCompletion,
  reindex,
  searchCards,
  upsertCard,
  validateStore,
} from "./cardStore.mjs";

const SERVER_INFO = {
  name: "codex-memory-mcp",
  version: "0.1.0",
};

const TOOLS = [
  {
    name: "rag_search",
    description: "Search local CodexMemory knowledge cards.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        type: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        include_deprecated: { type: "boolean" },
        format: { type: "string", enum: ["text", "json"] },
        verbose: { type: "boolean" },
        max_summary_chars: { type: "number" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "rag_get",
    description: "Read a full local CodexMemory card by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "rag_upsert",
    description: "Create or update a local CodexMemory knowledge card.",
    inputSchema: {
      type: "object",
      properties: {
        card: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            type: { type: "string" },
            scope: { type: "string" },
            project: { type: ["string", "null"] },
            status: { type: "string" },
            confidence: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            source_path: { type: "string" },
            source_section: { type: "string" },
            created_at: { type: "string" },
            updated_at: { type: "string" },
            last_verified_at: { type: "string" },
            body: { type: "string" },
          },
          required: ["id", "title", "type", "tags", "source_path", "body"],
        },
      },
      required: ["card"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "rag_validate",
    description: "Validate the local CodexMemory card store.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "rag_finish_task",
    description: "Record reusable lessons found during task completion analysis as CodexMemory cards and rebuild the index.",
    inputSchema: {
      type: "object",
      properties: {
        task_summary: { type: "string" },
        project: { type: ["string", "null"] },
        outcome: { type: "string" },
        source_path: { type: "string" },
        source_section: { type: "string" },
        lessons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              type: { type: "string" },
              scope: { type: "string" },
              project: { type: ["string", "null"] },
              status: { type: "string" },
              confidence: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              source_path: { type: "string" },
              source_section: { type: "string" },
              problem: { type: "string" },
              solution: { type: "string" },
              applies: { type: "string" },
              risks: { type: "string" },
              evidence: { type: "string" },
              body: { type: "string" },
            },
            required: ["title", "tags"],
          },
        },
      },
      required: ["task_summary", "lessons"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "rag_reindex",
    description: "Validate and rebuild the local CodexMemory JSONL index.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false },
  },
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handleLine(line);
  }
});

process.stderr.write(`${SERVER_INFO.name} ${SERVER_INFO.version} ready\n`);

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    return writeError(null, -32700, `Parse error: ${error.message}`);
  }

  if (!Object.prototype.hasOwnProperty.call(request, "id")) {
    return;
  }

  try {
    const result = await dispatch(request.method, request.params ?? {});
    writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    writeError(request.id, -32000, error.message);
  }
}

async function dispatch(method, params) {
  if (method === "initialize") {
    return {
      protocolVersion: params.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        "Use CodexMemory as supporting local memory only. Re-verify commands, paths, ports and versions before acting.",
    };
  }

  if (method === "tools/list") {
    return { tools: TOOLS };
  }

  if (method === "tools/call") {
    return callTool(params.name, params.arguments ?? {});
  }

  throw new Error(`Unsupported method: ${method}`);
}

async function callTool(name, args) {
  if (name === "rag_search") {
    const result = await searchCards(args);
    if (args.format === "json") return toolResult(result);
    return textToolResult(formatSearchResults(result, args));
  }
  if (name === "rag_get") return toolResult(await getCard(required(args, "id")));
  if (name === "rag_upsert") return toolResult(await upsertCard(required(args, "card")));
  if (name === "rag_validate") return toolResult(await validateStore());
  if (name === "rag_finish_task") return toolResult(await recordTaskCompletion(args));
  if (name === "rag_reindex") return toolResult(await reindex());
  throw new Error(`Unknown tool: ${name}`);
}

function required(args, key) {
  if (args[key] === undefined || args[key] === null || args[key] === "") {
    throw new Error(`${key} is required`);
  }
  return args[key];
}

function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function textToolResult(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}
