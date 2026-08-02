# CC-Switch Worker MCP

语言：[English](README.md) | [简体中文](README.zh-CN.md)

CC-Switch Worker MCP 是一个本地 MCP 服务器，用来让 Codex 把边界清楚的代码任务委派给 Claude Code，并通过本机 CC-Switch gateway 路由执行。Codex 仍然是监督者：它负责定义任务边界、启动 worker、审查结果，并运行最终验证。

这个项目的目标是节省 Codex 主线程上下文，适合真实工程任务。它不是独立模型客户端，也不包含任何模型密钥。

## 功能

- 通过 MCP 工具启动受限范围内的 Claude Code worker 任务。
- 支持异步任务生命周期：start、get、list、diagnose、tail、wait、cancel。
- 记录紧凑进度信息：heartbeat、health、变更文件、检查结果、policy 结果。
- 提供 safe mode 权限 hook，适合受限读写和检查命令。
- 默认使用 safe mode，强制合并不可替换的 forbidden paths，并把 Read/Write/Glob/Grep 和工具工作目录限制在任务 workspace 内。
- 按 use case 设置 effort 和预算，默认关闭继承的 ToolSearch，并记录 Claude result 中的限额与成本信息。
- 默认阻止同一任务重复启动，除非显式允许并行。
- 提供 setup、doctor、离线 smoke test 和 npm 打包卫生检查。
- 允许 Codex 按每个任务选择 Claude Code skills，并只为该任务授予精确的 `Skill(name)` 权限。
- 默认使用本地 CC-Switch gateway：`http://127.0.0.1:15721`。

## 依赖

- Node.js 20 或更新版本。
- 本机已安装 Claude Code CLI。
- 可访问的 CC-Switch gateway。
- Codex Desktop 或其他可运行本地 stdio MCP server 的客户端。

认证信息不应该放进仓库。你可以在自己机器上通过这些方式配置：

- `ANTHROPIC_AUTH_TOKEN`
- `CC_SWITCH_API_KEY_FILE`
- 默认本地 gateway 流程：`PROXY_MANAGED`

不要提交 token、`.env`、gateway 配置、日志、job 快照或本地记忆文件。

## 从 GitHub 安装

发布仓库后，把下面的 `YOUR_GITHUB_USERNAME` 替换成你的 GitHub 用户名，并使用你创建的 tag。

```json
{
  "mcpServers": {
    "cc-switch-worker": {
      "command": "npx",
      "args": [
        "github:YOUR_GITHUB_USERNAME/cc-switch-worker-mcp#v0.4.5-rc.1"
      ]
    }
  }
}
```

也可以从源码运行：

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/cc-switch-worker-mcp.git
cd cc-switch-worker-mcp
npm install
npm run mcp:setup
npm run mcp:doctor
```

源码模式 MCP 配置：

```json
{
  "mcpServers": {
    "cc-switch-worker": {
      "command": "node",
      "args": ["/absolute/path/to/cc-switch-worker-mcp/src/cc-switch-worker-mcp.mjs"]
    }
  }
}
```

源码目录移动或全局链接发生变化后，重新运行 `npm run mcp:setup` 和 `npm run mcp:doctor`，然后重启 MCP 客户端。已经启动的 server 进程不会自动加载新代码。

不做全局安装，直接检查 GitHub tag：

```bash
npx github:YOUR_GITHUB_USERNAME/cc-switch-worker-mcp#v0.4.5-rc.1 --doctor
```

预期输出大致如下：

```json
{
  "server_version": "0.4.5-rc.1",
  "ok": true
}
```

## 工具

- `cc_switch_start_implementation`：启动后台 worker 任务。
- `cc_switch_get_job`：读取紧凑任务状态。
- `cc_switch_list_jobs`：列出最近的持久化任务。
- `cc_switch_diagnose_job`：检查单个任务的本地 MCP 证据。
- `cc_switch_tail_job`：读取紧凑状态，可选日志和事件。
- `cc_switch_wait_for_job`：短窗口观察任务。
- `cc_switch_cancel_job`：请求取消任务。
- `cc_switch_implement_in_workspace`：同步模式，只适合很小的修改。

大体量证据需要显式打开：

- `include_logs: true`
- `include_events: true`
- `include_diff: true`

默认状态输出刻意保持很小，避免监督者反复读取大量日志。

## 推荐工作流

先给一个清楚、受限、可验证的任务：

```json
{
  "name": "cc_switch_start_implementation",
  "arguments": {
    "cwd": "/absolute/project/path",
    "task": "Make the requested code change.",
    "worker_profile": "scoped_patch",
    "safety_mode": "safe",
    "allowed_dirs": ["src"],
    "forbidden_paths": [".env", "node_modules", "logs"],
    "required_skills": ["tdd"],
    "checks": ["npm test"]
  }
}
```

使用规则：

- Codex 在启动 worker 前定义任务边界。
- 一个清楚的实现任务对应一个 worker job。
- `allowed_dirs` 尽量窄，`forbidden_paths` 写明确。
- `required_skills` 由 Codex 根据任务需要决定；不需要技能时省略。worker 会明确调用、只放行列出的技能，并把这些技能暂存到隔离目录供 `--bare` 模式发现。
- `--bare` worker 使用临时生成的隔离 settings 文件。任务结束后会删除暂存的 skills 和 settings；不会把完整的 Claude 用户配置或 skills 目录加入 worker 范围。
- 文件工具和 safe 模式只读 Bash 在判断 `cwd`、`allowed_dirs`、`forbidden_paths` 前，会解析已有 symlink/junction 祖先的真实路径，防止工作区内的链接把允许路径转到外部。
- job 仍在 running 时，除非定位具体故障，否则不要请求大日志、大事件或完整 diff。
- 终态后再审查变更文件、policy 输出、检查结果和相关 diff。
- 这个 MCP 是权限边界辅助工具，不是 OS/container 沙箱。

## 用例

模型选择默认交给 CC-Switch 路由控制。调用方没有显式覆盖时，本 MCP 不设置具体 `model`。

`model` 参数只是传给 Claude Code 的选择值。CC-Switch 可以把它转到其他供应商，因此 `model` 和 result 事件里的 `models_used` 都不能证明底层供应商模型。

| `use_case` | 模型来源 | Effort | Claude CLI 预算护栏 | 异步默认超时 | 适合场景 |
| --- | --- | --- | --- | --- | --- |
| `auto` | 当前 CC-Switch route | `high` | 默认关闭 | 无 | 普通实现 |
| `fast_patch` | 当前 CC-Switch route | `low` | 默认关闭 | 120s | 小补丁 |
| `simple_agent_task` | 当前 CC-Switch route | `medium` | 默认关闭 | 180s | 简单 agentic coding |
| `scaffold_or_tests` | 当前 CC-Switch route | `medium` | 默认关闭 | 300s | 脚手架、胶水代码、测试 |
| `debug_loop` | 当前 CC-Switch route | `max` | 默认关闭 | 无 | 复现、定位、修复、验证 |
| `agentic_coding` | 当前 CC-Switch route | `max` | 默认关闭 | 无 | 多步骤实现 |
| `complex_reasoning` | 当前 CC-Switch route | `max` | 默认关闭 | 无 | 架构和复杂逻辑 |
| `long_context_codebase` | 当前 CC-Switch route | `max` | 默认关闭 | 无 | 大上下文代码库 |
| `docs_generation` | 当前 CC-Switch route | `low` | 默认关闭 | 无 | 文档生成 |

## 成本和限额语义

- `enable_tool_search` 默认为 `false`。除非调用方明确开启，否则 server 会删除继承的 `ENABLE_TOOL_SEARCH`。
- 经过 CC-Switch 路由的任务默认不设置 `max_budget_usd`。Claude 的美元估值不是 CC-Switch 供应商账单，可能错误地提前中止底层模型。
- 调用方仍可明确传入 `max_budget_usd` 作为 Claude CLI 兼容护栏。它会原样传给 `--max-budget-usd`；检查可能滞后一次模型或工具轮次，`total_cost_usd` 仍只是 Claude Code result 元数据。
- 真正的人民币供应商限额需要 CC-Switch 提供经过认证的账单或余额接口。接口不可用时，本 MCP 不声称能够执行人民币硬上限。
- Claude Code 可能先执行工具，再发出 `error_max_budget_usd` 或 `error_max_turns`。此时如果已有合规文件变更，状态是 `partial_worker_limit`；只读工具已成功但没有最终文本时，会返回具体的 `*_after_tool_success` 原因。
- Claude Code `2.1.178` 提供 `--max-budget-usd`，没有公开 `--max-turns`。本 server 不提供一个会被 CLI 忽略的 `max_turns` 参数。
- `partial` 不是已验收完成。使用结果前必须检查 changed files，并补跑缺失的检查。

worker 的 stdout、stderr 和 tool-event 日志有长度上限，常见凭据格式会在持久化前脱敏。workspace 快照会跳过敏感路径和 forbidden paths；持久化快照只保存哈希与元数据，不保存文件正文。终态 job 默认保留七天，可用 `CC_SWITCH_WORKER_JOB_TTL_MS` 调整。worker 子进程只继承运行时、代理、证书和认证流程需要的环境变量。

脱敏和路径 hook 仍只是兜底。显式 permissive mode、并发替换链接或任意外部工具需要真正的 OS sandbox。任务文本和 worker 文件中不得放入 secret。

## 验证

离线验证不会调用真实模型 gateway：

```bash
npm run mcp:verify:offline
```

benchmark harness 有独立的 fake launcher smoke test。它会实际走完 MCP
初始化、job 启动、等待、取消、结果分类、并发限制和清理，但不会发起付费模型请求：

```bash
npm run mcp:smoke:benchmark
```

常用单项检查：

```bash
npm run mcp:doctor
npm run mcp:smoke:tools
npm run mcp:smoke:permission
npm run mcp:smoke:diagnostics
```

真实 worker smoke 需要 Claude Code 和可用的 CC-Switch gateway：

```bash
npm run mcp:smoke
```

完整 reliability benchmark 会启动真实 Claude Code worker。没有
`--confirm-real` 时，脚本会直接拒绝运行：

```bash
node scripts/benchmark-reliability.mjs --confirm-real --runs 1 --concurrent 1
```

默认三轮 benchmark 的 worker 请求预算合计为 `$1.35`。这些值是传给
Claude Code 的单 worker 预算请求，不是供应商账单的硬上限。运行前可先用
`--help` 查看当前场景和预算摘要。

## 发布卫生

发布 GitHub 前，请使用干净复制目录，或使用按 npm whitelist 生成的 release archive。不要上传：

- `node_modules/`
- `mem.md`
- `AGENTS.md`
- `.env` 或 `.env.*`
- `backup/`
- 日志、索引、缓存、字节码、coverage、build、dist
- 本机 Codex 配置、密钥、job 快照或机器相关路径

发布白名单在 `package.json` 的 `files` 字段里。

## 状态

当前版本：`0.4.5-rc.1`。

这是 beta 软件，适合能运行本地 MCP server、并愿意审查 worker 生成代码后再接受变更的开发者。
