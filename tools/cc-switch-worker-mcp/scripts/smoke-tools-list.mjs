import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = spawn("node", ["src/cc-switch-worker-mcp.mjs"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let stderr = "";

createInterface({ input: server.stdout }).on("line", (line) => {
  if (line.trim()) responses.push(JSON.parse(line));
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

send(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "tools-list-smoke", version: "0.1.0" },
});
await waitForResponseId(1, 5000);
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
send(2, "tools/list");

const response = await waitForResponseId(2, 5000);
server.kill("SIGTERM");

const tools = response.result?.tools ?? [];
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const start = byName.get("cc_switch_start_implementation");
const get = byName.get("cc_switch_get_job");
const list = byName.get("cc_switch_list_jobs");
const diagnose = byName.get("cc_switch_diagnose_job");
const wait = byName.get("cc_switch_wait_for_job");
const schema = start?.inputSchema?.properties ?? {};
const listSchema = list?.inputSchema?.properties ?? {};
const diagnoseSchema = diagnose?.inputSchema?.properties ?? {};

const checks = {
  has_eight_tools: tools.length === 8,
  start_mentions_async: /async CC-Switch coding worker/.test(start?.description ?? ""),
  start_mentions_one_worker_per_task: /one clearly scoped implementation task/.test(start?.description ?? "")
    && /Do not start a second worker for the same task while the first job is running/.test(start?.description ?? ""),
  start_avoids_polling_instruction: !/poll compact status with cc_switch_get_job/.test(start?.description ?? ""),
  start_mentions_bounded_default: /sonnet\/high with a bounded API budget/.test(start?.description ?? ""),
  start_has_title: start?.title === "Start CC-Switch worker job",
  start_has_output_schema: start?.outputSchema?.type === "object",
  get_mentions_omit_evidence: /omits stdout\/stderr, stream events, per-file diffs/.test(get?.description ?? ""),
  list_is_read_only_diagnostic: list?.annotations?.readOnlyHint === true
    && /finding stuck, orphaned, partial, failed/.test(list?.description ?? "")
    && listSchema.limit != null
    && listSchema.status?.enum?.includes("partial"),
  diagnose_is_local_only: diagnose?.annotations?.readOnlyHint === true
    && /Does not run the worker or contact external services/.test(diagnose?.description ?? "")
    && diagnoseSchema.job_id != null,
  wait_mentions_not_main_loop: /not the main polling loop/.test(wait?.description ?? "")
    && /completion\/partial\/failure/.test(wait?.description ?? ""),
  task_schema_keeps_review_in_host: /final review in the host agent/.test(schema.task?.description ?? ""),
  task_schema_mentions_followup_context: /previous job_id, terminal status, failure\/check result, and current diff summary/.test(schema.task?.description ?? ""),
  required_skills_are_host_selected: /selected by the host agent/.test(schema.required_skills?.description ?? "")
    && schema.required_skills?.type === "array",
  allow_parallel_schema_mentions_duplicate_guard: /already running/.test(schema.allow_parallel?.description ?? "")
    && /allow_parallel=true/.test(schema.allow_parallel?.description ?? ""),
  use_case_schema_mentions_bounded_auto: /Defaults to auto.*current CC-Switch route.*bounded API budget/.test(schema.use_case?.description ?? ""),
  cost_controls_are_exposed: schema.max_budget_usd?.type === "number"
    && schema.enable_tool_search?.type === "boolean"
    && schema.reasoning_effort?.enum?.includes("low"),
  start_schema_hides_poll_after: schema.poll_after_ms == null,
  no_extra_properties: start?.inputSchema?.additionalProperties === false,
};

process.stdout.write(`${JSON.stringify({
  ok: Object.values(checks).every(Boolean),
  checks,
  tool_names: tools.map((tool) => tool.name),
}, null, 2)}\n`);

if (stderr) process.stderr.write(stderr);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;

function send(id, method, params = {}) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function waitForResponseId(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const interval = setInterval(() => {
      const response = responses.find((item) => item.id === id);
      if (response) {
        clearInterval(interval);
        resolve(response);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(interval);
        server.kill("SIGTERM");
        reject(new Error(`Timed out waiting for response ${id}`));
      }
    }, 100);
  });
}
