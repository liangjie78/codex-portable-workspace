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
timeout_ms: 300000（小任务）/ 600000（略复杂）/ 最多 2400000
allowed_dirs: 最小必要范围
forbidden_paths: 明确列出
checks: 明确列出
required_skills: 按任务最小授权
```

当前 MCP 名称为 `cc-switch-worker`，工具前缀为 `cc_switch_*`。

`safe` 模式下不要要求 worker 用 Bash 新建文件；优先编辑现有文件，或由 Codex 先准备受限文件。

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

运行产物只有在用户明确要求其作为交付物时才允许修改。

## 验证与越界处理

- pytest 优先使用 `python -m pytest <target> -q -p no:cacheprovider`。
- worker 测试通过不代表任务完成。Codex 必须检查 `policy`、`forbidden_changed`、`outside_allowed` 和实际 changed files。
- 出现 forbidden 或 outside 改动时，该轮不能算干净完成；清理或拒绝副作用，再按需缩小范围重派。
- 文档中的完成结论只是草稿；Codex 复验底层命令和输出后才能勾选。
- worker 可能已写入文件但 job 显示 `failed`。验收以文件范围、diff、检查和实际运行结果为准。
- 认证、额度或权限导致 401、invalid key、quota、permission denied 时标记 blocked，不伪造结果或勾选完成。

## 技能权限

`required_skills` 是本次任务的最小技能白名单。只能传入已安装且相关的技能，不使用通配符。技能会暂存到隔离目录供 Claude Code `--bare` 使用，任务结束后清理。

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

## Follow-up

worker 部分完成或遗漏验收项时，不重新发送宽泛任务。follow-up 只允许修改具体文件，并点明未通过的验收句、输出标签或测试。

## 回传与最终验收

worker 回传：修改文件、实现摘要、检查结果、越界情况和剩余风险。Codex 检查后亲自完成最终验收；未经 Codex 审查，任何 worker 输出都不算完成。
