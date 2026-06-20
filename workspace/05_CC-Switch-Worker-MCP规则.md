# CC-Switch Worker MCP 规则

> 本文件用于保存本机调用 `cc-switch-worker` MCP 时的执行规则。
> 全局规范中只保留调用前置条件；一旦决定调用 `cc-switch-worker` MCP，必须先读取并遵守本文件。

## 核心定位

CC-Switch worker 是三层执行策略中的第二层：Codex + CC-Switch worker。

它的核心用途是节省 Codex/ChatGPT Plus 额度，并承担边界清楚、风险可控、可验证的小块执行工作。它不是协作决策层，不负责架构取舍、需求裁决、高风险判断或最终验收。

三层执行策略中的关系：

1. Codex 直接处理普通交流、简单任务、小改动、阻塞性定位和高风险最终判断。
2. Codex + CC-Switch worker 处理边界清楚、风险可控、可验证交付物，是默认省额度执行模式。
3. 多 Agent 协作只在用户明确启用，或确实需要多个专家岗位并行产出或交叉复核时使用。

复杂任务不自动进入多 Agent。Codex 应先拆解任务；拆解后如果出现清晰可执行的小块，优先考虑本文件定义的 worker 模式。

## 启用审核

除非用户已经明确授权使用 CC-Switch worker，否则 Codex 在调用前应先向用户提交：

- 建议使用 worker 的理由。
- 允许 worker 修改的范围。
- 禁止 worker 修改的范围。
- Codex 将如何审查和最终验收。
- 关键风险和失败后的兜底方式。

用户确认后，Codex 才能调用 worker。用户已经明确说“用 ccswitch worker”“交给 worker 做”“省额度执行”等同类指令时，可视为已通过 worker 启用审核，但 Codex 仍必须遵守本文件的安全边界。

## 默认角色分工

Codex 是监督者和决策者。CC-Switch worker 是受限执行者。

Codex 负责：

- 理解需求和澄清边界。
- 读取定义任务边界所需的最小关键上下文。
- 判断任务是否适合委派。
- 决定技术方案和安全边界。
- 给 CC-Switch worker 分配清晰、受限的执行任务。
- 审查 CC-Switch worker 的输出、修改范围和验证结果。
- 处理偏离任务、越界修改或不可靠实现。
- 运行或确认最终验证。
- 给用户最终汇报。

CC-Switch worker 负责：

- 在 Codex 指定的文件或目录范围内执行实现工作。
- 处理有边界的代码修改、脚手架、胶水代码、批量重复性修改。
- 根据 Codex 指定的检查命令进行初步验证。
- 回传修改文件、执行结果、验证结果和残余风险。

CC-Switch worker 不是最终裁决者。任何 worker 输出都必须由 Codex 审查后才能视为完成。

## 默认工作流程

1. Codex 读取最小必要上下文，判断任务性质、风险和修改边界。
2. 若任务属于边界清楚、风险可控、可受限执行且可验证的工程任务，Codex 可以建议委派给 CC-Switch worker。
3. Codex 在委派前必须给出清晰边界：
   - 允许修改的目录或文件。
   - 禁止修改的路径。
   - 任务目标。
   - 验收标准。
   - 建议运行的验证命令。
   - 是否允许文档-only 修改。
4. CC-Switch worker 执行具体实现和初步验证。
5. Codex 审查 CC-Switch worker 的 diff、文件范围、验证结果和关键风险。
6. 如果 CC-Switch worker 越界、跑偏或生成不相关内容，Codex 必须拒绝、清理或发起更窄范围的 follow-up。
7. Codex 自己运行或确认最终验证。
8. Codex 向用户汇报结果、验证证据和残余风险。

## Codex Token 节约原则

为减少 Codex token 消耗：

- Codex 不应为了委派而大规模读取代码、文档或日志；只读取足以判断任务性质、风险和修改边界的最小上下文。
- 详细文件探索、源码阅读、批量资料整理、实现、初步测试和日志分析，可以交给 CC-Switch worker。
- Codex 给 worker 的任务应短而完整：目标、允许路径、禁止路径、检查命令、验收标准。
- Codex 审查 worker 结果时优先看 diff 摘要、改动文件、检查结果和关键风险；只有发现异常、越界或验证失败时再读取详细 diff 或日志。
- 对一两行小改动、简单命令查询或必须立即判断的阻塞问题，Codex 可以直接处理，避免委派开销超过收益。

## CC-Switch Worker 默认参数倾向

优先使用：

- `cc_switch_start_implementation`
- `worker_profile: scoped_patch`
- `safety_mode: safe`
- 窄范围 `allowed_dirs`
- 明确 `forbidden_paths`
- 明确 `checks`
- 按任务需要传入 `required_skills`；只允许 Codex 选择已经安装到 Claude Code 的技能，不要让 worker 自行扩大技能权限。
- 小任务显式设置较短 `timeout_ms`，优先 `180000`，如果任务略复杂但仍是小范围修改，可用 `300000`；大任务显式设置适中 `timeout_ms`，最多可用 `1200000`。
补充规则：

- 当前安装的 MCP 名称是 `cc-switch-worker`，工具名前缀是 `cc_switch_*`。
- 如果 MCP `checks_run` 摘要与 worker 日志或 Codex 主线程复验冲突，以 Codex 主线程最终验证和审查为准。
- `safe` 模式下不要要求 worker 通过 Bash 新建文件；优先让 worker 编辑已存在文件，或由 Codex 先准备受限测试文件。

## 强化安全规则

- 不要把全局策略文件交给 worker 修改，例如 `{{CODEX_AGENTS}}`、`{{WORKSPACE_ROOT}}\01_全局工作台.md`、项目 `AGENTS.md`、worker 安全规则、账号级配置或类似文件。这类规则由 Codex 亲自修改和审查。
- 运行产物默认视为禁止修改，除非它本身就是用户明确要求的交付物。常见例子：`.pytest_cache/`、`__pycache__/`、`logs/`、`coverage/`、`build/`、`dist/`、`.pyc`、`.pyo`。
- 让 worker 跑 pytest 时，优先使用：`python -m pytest <target> -q -p no:cacheprovider`，以避免生成 `.pytest_cache`。如果仍生成缓存，Codex 必须清理。
- worker 测试通过不等于任务完成。Codex 必须检查 worker 结果里的 `policy`、`forbidden_changed`、`outside_allowed` 和实际 changed files。
- 只要出现 forbidden 或 outside 改动，该轮不能算干净完成；Codex 应清理或拒绝副作用，并在需要时发起更窄的 follow-up worker。
- worker 任务说明必须同时在 `forbidden_paths` 和自然语言中写明禁止运行产物，例如："Do not create or modify `.pytest_cache`, logs, indexes, bytecode, release folders, or unrelated docs."
- Codex 判断技能能提高执行质量时，可在 worker 调用中传入 `required_skills`。当前推荐映射：明确的测试优先实现用 `tdd`；疑难 Bug 或性能回退用 `diagnosing-bugs`；接口、模块边界或可测试性设计用 `codebase-design`；已经明确需求的前端界面实现或 UI 改善用 `ui-ux-pro-max`；明确要求制作横向网页 PPT 时用 `guizang-ppt-skill`。不匹配时不要为了“可能有用”而分配技能。
- `ui-ux-pro-max` 在 safe worker 中优先用 Read/Grep 查询随技能暂存的 CSV，不为此安装 Python 或扩大 Bash 权限。`guizang-ppt-skill` 在 safe worker 中用 Read/Write/Edit 复制模板；需要运行 deck validator 时，由 Codex 把绝对命令加入 `checks`，或在 worker 结束后亲自验证。
- `required_skills` 是本次任务的最小权限清单。worker 只能调用列出的技能；不得传入通配符、未安装技能或与任务无关的技能。MCP 会把选中的技能暂存到隔离目录供 Claude Code `--bare` 模式发现，任务结束后自动清理。
- worker 如果部分完成但漏了验收细节，不要重新发一个宽泛任务。应发起窄范围 follow-up，只允许修改具体文件，并明确指出未通过的验收句、输出标签或测试。
- 涉及 secret 的任务默认只由 Codex 本地执行，除非用户明确授权其他流程。不要把 `.env`、真实 API key、auth token、cookie、私有 config 值，或可识别的 redacted 凭据交给 worker。
- 如果任务依赖外部 key，而本地 smoke test 返回 401、invalid key、quota、permission denied 等外部认证或额度失败，Codex 必须把该任务标记为 blocked；不要让 worker 伪造结果，也不要把文档 TODO 勾成完成。
- worker 写的文档结论只是草稿。只有 Codex 亲自复验底层命令和真实输出之后，才能勾选文档里的完成项。
- release/package 任务必须使用白名单复制策略，并在汇报前做 secret scan。默认不得包含 `.env`、`config.json`、`AGENTS.md`、任务文档、`.git`、`.claude`、日志、索引、缓存、字节码或用户本机路径。

常见 forbidden paths：

- `.git/`
- `.obsidian/`
- `node_modules/`
- 构建产物目录。
- 与任务无关的用户资料目录。
- 知识库的 `raw/`，除非用户明确要求处理原始资料且只读。

## 什么时候不委派

Codex 不应默认委派以下任务：

- 一两行的小改动。
- 简单命令查询。
- 需要立即判断的阻塞性阅读或定位。
- 高风险架构决策本身。
- 用户明确要求 Codex 亲自完成或不要使用 CC-Switch worker。
- CC-Switch worker 无法被足够窄地限制修改范围。
- 涉及全局规范、账号级配置、真实凭据、生产数据或关键安全策略的任务。

## 最终原则

普通交流保持轻量，不强行启动 worker。

复杂任务先由 Codex 拆解，不因复杂度直接进入多 Agent。拆解后能被清晰限制范围的执行块，优先考虑 worker；需要多个独立专家视角互相复核时，才考虑多 Agent。

一旦进入适合委派的工作任务，Codex 负责监督、决策、审查和验证；CC-Switch worker 负责受限执行。
