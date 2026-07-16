# CC-Switch Worker MCP 规则

调用 `cc-switch-worker` MCP 后必须遵守本文件。启动条件见 `{{CODEX_AGENTS}}`。

## 定位与审核

CC-Switch worker 是受限执行者，适合边界清楚、风险可控、可验证的小块工作；不负责需求裁决、架构、安全决策或最终验收。

用户未明确授权时，Codex 调用前须说明：使用理由、允许和禁止范围、审查与验收方式、风险及失败兜底。用户明确要求使用 worker 或省额度执行时，视为已通过审核。

一两行小改、简单查询、阻塞性定位、高风险决策，以及无法收窄修改范围的任务不委派。全局规范、账号配置、凭据、生产数据和关键安全策略始终由 Codex 处理。

## 分工与流程

Codex 负责理解需求、限定边界、决定方案、审查 diff 和文件范围、复验结果并向用户交付。worker 只在授权路径内实现、运行指定检查并回传结果。

流程：

1. Codex 读取足以判断风险和边界的最小上下文。
2. 明确目标、允许目录、禁止路径、验收标准、检查命令和是否允许文档修改。
3. worker 执行实现和初步验证。
4. Codex 检查实际 changed files、策略结果、diff 和验证证据。
5. 越界、跑偏或漏项时拒绝副作用，必要时发起范围更窄的 follow-up。
6. Codex 完成最终验证和汇报。

worker 状态、日志和 `checks_run` 摘要发生冲突时，以实际文件、Codex 主线程复验和最终审查为准。

## 调用参数

默认倾向：

```text
tool: cc_switch_start_implementation
worker_profile: scoped_patch
safety_mode: safe
use_case: fast_patch / simple_agent_task / 按真实复杂度选择
timeout_ms: 300000（小任务）/ 600000（略复杂）/ 最多 2400000
allowed_dirs: 最小必要范围
forbidden_paths: 明确列出
checks: 明确列出
required_skills: 按任务最小授权
enable_tool_search: false（除非任务确实需要动态发现工具）
```

当前 MCP 名称为 `cc-switch-worker`，工具前缀为 `cc_switch_*`。

`safe` 模式下不要要求 worker 用 Bash 新建文件；优先编辑现有文件，或由 Codex 先准备受限文件。

`safe` 是服务端默认值，不依赖调用方记得传参。调用方提供的 `forbidden_paths` 只会追加，不能替换 `.env*`、认证文件、包管理锁文件等服务端禁区。Read、Write、Glob、Grep 和工具 `cwd` 都必须以任务 workspace 为根做 containment 检查；job_id 只接受服务端生成格式，并在解析后再次检查 job root containment。

## 模型、ToolSearch 与预算

本机 CC-Switch 当前把 Claude Code 请求路由到 DeepSeek V4。worker 默认不传 `--model`，保留 CC-Switch 当前路由。`model` 参数以及 Claude result 中的 `models_used` 只是 CLI/gateway 回报的选择值，不能据此认定底层供应商模型。没有单独验证路由映射前，不要用 `haiku`、`sonnet` 或 `opus` 猜测成本或供应商。

默认成本控制：

| `use_case` | Effort | `max_budget_usd` | 异步超时 |
|---|---:|---:|---:|
| `fast_patch` | `low` | `0.05` | 120 秒 |
| `simple_agent_task` | `medium` | `0.10` | 180 秒 |
| `scaffold_or_tests` | `medium` | `0.25` | 300 秒 |
| `auto` | `high` | `0.50` | 调用方按需设置 |
| `debug_loop` / `agentic_coding` | `max` | `1.00` | 调用方按需设置 |
| `long_context_codebase` | `max` | `1.50` | 调用方按需设置 |
| `complex_reasoning` | `max` | `2.00` | 调用方按需设置 |

- 低风险检查优先 `fast_patch` 或 `simple_agent_task`，不要只因默认路由可用就使用高 effort 和大预算。
- `ENABLE_TOOL_SEARCH=true` 会先消耗 ToolSearch 轮次。worker 默认删除继承值；只有任务需要动态发现工具时才显式设置 `enable_tool_search: true`。
- Claude Code `2.1.178` 公开 `--max-budget-usd`，未公开 `--max-turns`。实测未知 `--max-turns` 会被静默忽略，因此不得把它作为护栏。
- `max_budget_usd` 是传给 Claude Code 的限制请求，不是严格硬上限。检查可能滞后到一次模型或工具轮次之后，回报成本可以高于请求值。
- `total_cost_usd` 是 Claude Code result 事件的回报值，不是 CC-Switch/DeepSeek 的最终账单。记录时同时保留 use case、effort、预算、ToolSearch、turns 和 result subtype。
- 预算检查可能发生在工具执行之后。已成功调用工具但没有最终文本时，不能直接归为普通失败。

## 任务说明

提示词应短而完整，包含：

- 项目路径、目标和必要背景。
- 允许与禁止修改的路径。
- 禁止生成的运行产物。
- 验收标准和检查命令。
- 回传格式。

自然语言和 `forbidden_paths` 中都要写明：

> Do not create or modify `.pytest_cache`, logs, indexes, bytecode, release folders, or unrelated docs.

常见禁止路径：

- `.git/`、`.obsidian/`、`node_modules/`。
- `.pytest_cache/`、`__pycache__/`、`coverage/`、`build/`、`dist/`、日志、索引和字节码。
- 无关用户资料目录。
- 知识库 `raw/`；用户明确要求只读处理时除外。

文件工具和 safe 模式只读 Bash 会解析已有 symlink/junction 祖先的真实路径，链接目标逃出 workspace 或 `allowed_dirs` 时拒绝访问。该检查不能消除并发替换链接的 TOCTOU，也不能约束 permissive Bash 的任意子进程；高风险任务仍须使用真实 sandbox。

运行产物只有在用户明确要求其作为交付物时才允许修改。

## 验证与越界处理

- pytest 优先使用 `python -m pytest <target> -q -p no:cacheprovider`。
- worker 测试通过不代表任务完成。Codex 必须检查 `policy`、`forbidden_changed`、`outside_allowed` 和实际 changed files。
- 出现 forbidden 或 outside 改动时，该轮不能算干净完成；清理或拒绝副作用，再按需缩小范围重派。
- 文档中的完成结论只是草稿；Codex 复验底层命令和输出后才能勾选。
- worker 可能已写入文件但 job 显示 `failed`。验收以文件范围、diff、检查和实际运行结果为准。
- 合规改动后触发预算或轮次上限时，状态应为 `partial_worker_limit`，原因是 `budget_exhausted_after_valid_changes` 或 `turn_limit_after_valid_changes`。
- 工具已成功、没有文件改动、没有最终文本时，使用 `budget_exhausted_after_tool_success` 或 `turn_limit_after_tool_success`；进程异常退出但没有 limit 事件时，使用 `worker_exited_after_tool_success_without_final_text`。
- forbidden、outside allowed 和 checks failure 的证据优先于通用 `worker_exit_nonzero`，不能让非零退出码掩盖越界或验收失败。
- 认证、额度或权限导致 401、invalid key、quota、permission denied 时标记 blocked，不伪造结果或勾选完成。

## 技能权限

`required_skills` 是本次任务的最小技能白名单。只能传入已安装且相关的技能，不使用通配符。技能会暂存到隔离目录供 Claude Code `--bare` 使用，任务结束后清理。

`--bare` worker 只接收临时生成的 settings 文件。settings 注入必须保留最小工具白名单、权限 hook 和必要的 `--add-dir`；不得直接暴露完整用户 settings 或整个 skills 目录。任务结束后检查 skill scope 和临时 settings 已清理。

推荐映射：

- 测试优先实现：`tdd`。
- 疑难 bug 或性能回退：`diagnosing-bugs`。
- 模块边界和可测试性设计：`codebase-design`。
- 已明确需求的 UI 实现：`ui-ux-pro-max`。
- 横向网页 PPT：`guizang-ppt-skill`。

`ui-ux-pro-max` 在 safe worker 中用 Read/Grep 查询随技能提供的 CSV，不为此安装 Python 或扩大 Bash 权限。`guizang-ppt-skill` 用 Read/Write/Edit 复制模板；validator 由 Codex 加入 `checks` 或在结束后亲自运行。

## 凭据与发布

- 涉及 secret 的任务默认不委派。不得向 worker 提供 `.env`、API key、token、cookie、私有配置值或可识别的脱敏凭据。
- release/package 使用白名单复制，并在交付前运行 secret scan。
- 包中默认排除 `.env`、`config.json`、`AGENTS.md`、任务文档、`.git`、`.claude`、日志、索引、缓存、字节码和本机路径。
- stdout、stderr、Bash 命令和 tool-event 在写入 job 日志前必须做常见凭据脱敏并限制最大长度。正则脱敏不是安全边界，secret 仍不得进入 worker 上下文。
- snapshot 在遍历和读取前跳过 `.env*`、密钥类文件名及 forbidden paths。持久化快照只保存哈希和元数据，不保存文件正文；终态 job 默认保留七天，可用 `CC_SWITCH_WORKER_JOB_TTL_MS` 调整。
- worker 子进程只继承运行时、代理、证书和认证流程所需的环境变量。新增继承项必须说明必要性并补离线测试，不能恢复为完整 `process.env`。

## 安装、恢复与重启

- 源码目录移动或全局 npm 链接失效时，重新执行受控安装/设置流程，并用 `cc-switch-worker-mcp --doctor` 核对源码路径、Codex 注册路径、Claude CLI 能力和 job root。
- MCP server 进程不会热加载源码。更新后必须重启 Codex 或新建任务；旧进程继续使用启动时加载的代码。
- MCP 重启后可从磁盘恢复 job 元数据，但不能恢复原内存 Promise 或补收已经丢失的 stdout。进程仍存活时允许查询和取消；进程退出后标记 `orphaned`，由 Codex 根据文件、diff 和检查重新验收。
- 便携仓库中的 `tools\cc-switch-worker-mcp` 是发布事实来源；实际 Worker 只允许从便携源单向同步。`node_modules`、`docs` 和 `99_Retrospective.md` 是明确允许的安装态差异，其余 SHA-256 差异必须先解决。
- Windows 取消和超时必须终止 launcher 及其 Claude Code 子进程；不能只依赖 `ChildProcess.killed` 判断已经退出。

## Follow-up

worker 部分完成或遗漏验收项时，不重新发送宽泛任务。follow-up 只允许修改具体文件，并点明未通过的验收句、输出标签或测试。

## 回传与最终验收

worker 回传：修改文件、实现摘要、检查结果、越界情况和剩余风险。Codex 检查后亲自完成最终验收；未经 Codex 审查，任何 worker 输出都不算完成。
