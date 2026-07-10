#!/usr/bin/env node
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
  searchCards,
  upsertCard,
  validateStore,
} from "./cardStore.mjs";

const SERVER_INFO = {
  name: "codex-memory-mcp",
  version: "0.9.0",
};

// Keep one malformed stdin record from making the MCP process retain an
// unbounded buffer. This is intentionally generous enough for a full card
// payload while still providing a deterministic recovery boundary.
const MAX_REQUEST_LINE_BYTES = 1024 * 1024;

const TOOLS = [
  {
    name: "rag_search",
    description: "Search local CodexMemory knowledge cards.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
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
    name: "rag_brief",
    description: "Build a read-only, task-start brief from relevant local CodexMemory cards and current verification warnings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        project: { type: "string" },
        limit: { type: "number" },
        include_deprecated: { type: "boolean" },
        format: { type: "string", enum: ["text", "json"] },
        max_summary_chars: { type: "number" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "rag_maintenance_plan",
    description: "Build a read-only CodexMemory maintenance plan with evidence-backed suggestions; it never changes cards or indexes.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        format: { type: "string", enum: ["text", "json"] },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "rag_get",
    description: "Read a full local CodexMemory card by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
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
            id: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            type: { type: "string", minLength: 1 },
            scope: { type: "string" },
            project: { type: ["string", "null"] },
            status: { type: "string" },
            confidence: { type: "string" },
            tags: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
            aliases: { type: "array", maxItems: 12, items: { type: "string", minLength: 1 } },
            source_path: { type: "string", minLength: 1 },
            source_section: { type: "string" },
            created_at: { type: "string" },
            updated_at: { type: "string" },
            last_verified_at: { type: "string" },
            body: { type: "string", minLength: 1 },
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
    name: "rag_health",
    description: "Report local CodexMemory validation, index, and verification health without changing the store.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "rag_mark_verified",
    description: "Explicitly record that one CodexMemory card was re-verified, then rebuild the local index.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        last_verified_at: { type: "string" },
        status: { type: "string" },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "rag_snapshot",
    description: "Create a verified local CodexMemory snapshot with a SHA-256 manifest; it never restores or deletes data.",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string" } },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "rag_finish_task",
    description: "Record reusable lessons found during task completion analysis as CodexMemory cards and rebuild the index.",
    inputSchema: {
      type: "object",
      properties: {
        task_summary: { type: "string", minLength: 1 },
        project: { type: ["string", "null"] },
        outcome: { type: "string" },
        source_path: { type: "string" },
        source_section: { type: "string" },
        lessons: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string", minLength: 1 },
              type: { type: "string" },
              scope: { type: "string" },
              project: { type: ["string", "null"] },
              status: { type: "string" },
              confidence: { type: "string" },
              tags: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              aliases: { type: "array", maxItems: 12, items: { type: "string", minLength: 1 } },
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

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

let buffer = "";
let bufferBytes = 0;
let discardingOversizedLine = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  processInputChunk(chunk);
});

process.stderr.write(`${SERVER_INFO.name} ${SERVER_INFO.version} ready\n`);

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    return writeError(null, -32700, `Parse error: ${error.message}`);
  }

  const invalidRequest = validateRequest(request);
  if (invalidRequest) {
    return writeError(null, -32600, `Invalid Request: ${invalidRequest}`);
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
    return callTool(params.name, params.arguments);
  }

  throw new Error(`Unsupported method: ${method}`);
}

async function callTool(name, rawArgs) {
  const validation = validateToolCall(name, rawArgs);
  if (validation) return toolError(validation);
  const args = rawArgs ?? {};

  if (name === "rag_search") {
    const result = await searchCards(args);
    if (args.format === "json") return toolResult(result);
    return textToolResult(formatSearchResults(result, args));
  }
  if (name === "rag_brief") {
    const result = await createTaskBrief(args);
    if (args.format === "json") return toolResult(result);
    return textToolResult(formatTaskBrief(result, args));
  }
  if (name === "rag_maintenance_plan") {
    const result = await createMaintenancePlan(args);
    if (args.format === "json") return toolResult(result);
    return textToolResult(formatMaintenancePlan(result));
  }
  if (name === "rag_get") return toolResult(await getCard(required(args, "id")));
  if (name === "rag_upsert") return toolResult(await upsertCard(required(args, "card")));
  if (name === "rag_validate") return toolResult(await validateStore());
  if (name === "rag_health") return toolResult(await getStoreHealth());
  if (name === "rag_mark_verified") {
    return toolResult(await markCardVerified(required(args, "id"), args));
  }
  if (name === "rag_snapshot") return toolResult(await createSnapshot(args));
  if (name === "rag_finish_task") return toolResult(await recordTaskCompletion(args));
  if (name === "rag_reindex") return toolResult(await reindex());
  throw new Error(`Unknown tool: ${name}`);
}

function processInputChunk(chunk) {
  let cursor = 0;
  while (cursor < chunk.length) {
    const newline = chunk.indexOf("\n", cursor);
    const end = newline === -1 ? chunk.length : newline;
    const segment = chunk.slice(cursor, end);
    cursor = newline === -1 ? chunk.length : newline + 1;

    if (discardingOversizedLine) {
      if (newline !== -1) discardingOversizedLine = false;
      continue;
    }

    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (bufferBytes + segmentBytes > MAX_REQUEST_LINE_BYTES) {
      buffer = "";
      bufferBytes = 0;
      writeError(
        null,
        -32600,
        `Invalid Request: request line exceeds ${MAX_REQUEST_LINE_BYTES} bytes`,
      );
      if (newline === -1) discardingOversizedLine = true;
      continue;
    }

    buffer += segment;
    bufferBytes += segmentBytes;
    if (newline !== -1) {
      const line = buffer.trim();
      buffer = "";
      bufferBytes = 0;
      if (line) {
        void handleLine(line).catch((error) => {
          writeError(null, -32600, `Invalid Request: ${error.message}`);
        });
      }
    }
  }
}

function validateRequest(request) {
  if (!isRecord(request)) return "request must be a non-null object";
  if (request.jsonrpc !== "2.0") return 'jsonrpc must equal "2.0"';
  if (typeof request.method !== "string" || request.method.trim() === "") {
    return "method must be a non-empty string";
  }
  if (Object.prototype.hasOwnProperty.call(request, "id") && !isValidRequestId(request.id)) {
    return "id must be a string, number, or null";
  }
  if (Object.prototype.hasOwnProperty.call(request, "params") && !isRecord(request.params)) {
    return "params must be an object when provided";
  }
  return null;
}

function isValidRequestId(value) {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateToolCall(name, rawArgs) {
  if (typeof name !== "string" || name.trim() === "") {
    return {
      code: "invalid_tool_name",
      message: "tools/call requires a non-empty string name",
      details: [{ path: "params.name", message: "must be a non-empty string" }],
    };
  }

  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    return {
      code: "unknown_tool",
      message: `Unknown tool: ${name}`,
      details: [{ path: "params.name", message: "does not name a supported tool" }],
    };
  }

  const args = rawArgs === undefined ? {} : rawArgs;
  if (!isRecord(args)) {
    return {
      code: "invalid_tool_arguments",
      message: `Invalid arguments for ${name}`,
      details: [{ path: "params.arguments", message: "must be an object" }],
    };
  }

  const details = [];
  validateSchema(args, tool.inputSchema, "params.arguments", details);
  if (details.length === 0) return null;
  return {
    code: "invalid_tool_arguments",
    message: `Invalid arguments for ${name}`,
    details,
  };
}

function validateSchema(value, schema, path, details) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !types.some((type) => valueMatchesType(value, type))) {
    details.push({ path, message: `must be ${describeTypes(types)}` });
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    details.push({ path, message: `must be one of: ${schema.enum.join(", ")}` });
  }

  if (typeof value === "string" && schema.minLength !== undefined && value.trim().length < schema.minLength) {
    details.push({ path, message: `must contain at least ${schema.minLength} non-whitespace character(s)` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      details.push({ path, message: `must contain at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      details.push({ path, message: `must contain at most ${schema.maxItems} item(s)` });
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, details));
    }
  }

  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || value[key] === null) {
        details.push({ path: `${path}.${key}`, message: "is required" });
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) {
        validateSchema(value[key], propertySchema, `${path}.${key}`, details);
      }
    }
  }
}

function valueMatchesType(value, type) {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return false;
}

function describeTypes(types) {
  return types.map((type) => (type === "null" ? "null" : `a ${type}`)).join(" or ");
}

function toolError(error) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error }, null, 2),
      },
    ],
    isError: true,
  };
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
