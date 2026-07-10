import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(projectRoot, "src", "server.mjs");
const MAX_REQUEST_LINE_BYTES = 1024 * 1024;

test("invalid JSON-RPC records return invalid-request errors without killing the server", async () => {
  await withTempServer(async (server) => {
    for (const raw of [
      "null\n",
      "[]\n",
      "17\n",
      '"not an object"\n',
      '{"jsonrpc":"2.0","id":"missing-method"}\n',
    ]) {
      const response = await server.raw(raw, (message) => message.id === null && message.error?.code === -32600);
      assert.match(response.error.message, /^Invalid Request:/);

      const listed = await server.request("tools/list", {});
      assert.equal(listed.error, undefined);
      assert.equal(listed.result.tools.length, 11);
    }
  });
});

test("an oversized unterminated request is rejected and the next request succeeds", async () => {
  await withTempServer(async (server) => {
    const pendingError = server.waitFor(
      (message) => message.id === null && message.error?.code === -32600 && /exceeds/.test(message.error.message),
    );
    server.write("x".repeat(MAX_REQUEST_LINE_BYTES + 1));
    server.write("\n");
    await pendingError;

    const listed = await server.request("tools/list", {});
    assert.equal(listed.error, undefined);
    assert.equal(listed.result.tools.length, 11);
  });
});

test("valid notifications stay silent", async () => {
  await withTempServer(async (server) => {
    server.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const listed = await server.request("tools/list", {});
    assert.equal(listed.error, undefined);
    assert.equal(server.unmatchedMessageCount(), 0);
  });
});

test("invalid tool calls return MCP errors before they can initialize storage", async () => {
  await withTempServer(async (server, root) => {
    const invalidCalls = [
      { name: "rag_search", arguments: { query: 42 } },
      { name: "rag_brief", arguments: { query: "   " } },
      { name: "rag_maintenance_plan", arguments: { limit: "not-a-number" } },
      { name: "rag_finish_task", arguments: { task_summary: "Bad lesson payload", lessons: "not-an-array" } },
      { name: "rag_finish_task", arguments: { task_summary: "Empty lesson payload", lessons: [] } },
    ];

    for (const params of invalidCalls) {
      const response = await server.request("tools/call", params);
      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, true);
      const result = JSON.parse(response.result.content[0].text);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "invalid_tool_arguments");
      assert.ok(!existsSync(path.join(root, "cards")));
      assert.ok(!existsSync(path.join(root, "indexes")));
    }
  });
});

async function withTempServer(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-memory-server-test-"));
  const server = startServer(root);
  try {
    return await run(server, root);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

function startServer(root) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_MEMORY_ROOT: root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const waiters = [];
  let stdout = "";
  let stderr = "";
  let nextId = 1;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      receive(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    request(method, params) {
      const id = nextId++;
      const response = waitFor((message) => message.id === id);
      write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    raw(raw, predicate) {
      const response = waitFor(predicate);
      write(raw);
      return response;
    },
    unmatchedMessageCount() {
      return messages.length;
    },
    waitFor,
    write,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end();
      let timeoutId;
      const timeout = new Promise((resolve) => {
        timeoutId = setTimeout(resolve, 1000);
      });
      await Promise.race([exited, timeout]);
      clearTimeout(timeoutId);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit");
      }
    },
  };

  function write(text) {
    child.stdin.write(text);
  }

  function receive(message) {
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    messages.push(message);
  }

  function waitFor(predicate) {
    const existing = messages.findIndex(predicate);
    if (existing >= 0) return Promise.resolve(messages.splice(existing, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for server response. stderr: ${stderr}`));
      }, 5000);
      waiters.push({ predicate, resolve, timeout });
    });
  }
}
