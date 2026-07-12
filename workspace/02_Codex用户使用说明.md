# Codex 用户使用说明

这份文件给实际使用 Codex 的人看。它不讲配置细节，只说明现在装了什么、平时什么时候用得上。账号、令牌、Cookie、聊天记录和本机知识库内容不写在这里，也不会上传到仓库。下表的“可恢复”只表示仓库能恢复配置、Skill 快照或工具源码；账号授权和本机数据仍需单独配置。

## 先分清三种东西

- 插件像工具箱。它给 Codex 增加浏览器、文档、GitHub 或云盘这类能力。
- Skill 像一份操作手册。遇到某类任务时，Codex 会按它的步骤做事。
- MCP 像一条接线。它让 Codex 能调用本机或已连接服务的工具。

装着不等于每次都会用。Codex 会按你的问题选择；你也可以直接说出想用的名称。

## 现在装了哪些插件

| 插件来源 | 已安装插件 | 大白话说明 | 可恢复 |
| --- | --- | --- |
| `openai-bundled` | `browser`、`chrome`、`computer-use` | 操作 Codex 内置浏览器、Chrome 或 Windows 应用。| 随 Codex 或插件安装，不由本仓库复制。|
| `openai-bundled` | `sites`、`visualize` | 搭网站，或把想法和数据做成可交互图表、小工具。| 随 Codex 或插件安装，不由本仓库复制。|
| `openai-curated` | `github` | 看仓库、PR、Issue 和 CI；需要写入时会走 GitHub 授权。| 插件需安装；GitHub 授权不可恢复。|
| `openai-curated` | `hyperframes` | 用 HTML、动画和字幕做视频。| 插件需安装，不复制其运行缓存。|
| `openai-curated-remote` | `github`、`google-drive` | 通过已连接账号处理 GitHub，或操作 Drive、Docs、Sheets、Slides。| 插件需安装；连接账号不可恢复。|
| `openai-curated-remote` | `openai-templates` | 提供文档、表格和演示文稿的默认模板。| 插件需安装，不复制缓存。|
| `openai-primary-runtime` | `documents`、`pdf`、`presentations` | 创建、修改和检查 Word、PDF、PowerPoint 一类文件。| 随 Codex 或插件安装，不由本仓库复制。|
| `openai-primary-runtime` | `spreadsheets`、`template-creator` | 处理 Excel/CSV，或把现有文件整理成可复用模板。| 随 Codex 或插件安装，不由本仓库复制。|
| `ponytail` | `ponytail` | 提醒 Codex 少造轮子：能用现成能力解决就别写一大套新代码。| 插件需安装，不复制其缓存。|

插件是 Codex 程序的一部分，仓库会记录这份说明和可迁移的配置/技能，不会复制登录状态或个人授权。

## 现在可用的 MCP

| 名称 | 它能做什么 | 可恢复 |
| --- | --- |
| `node_repl` | 运行一小段 JavaScript，常用于浏览器自动化或验证网页。| 本机功能，不随仓库恢复。|
| `headroom` | 本机的模型路由与用量辅助服务。它只影响调用路线，不保存你的对话内容到仓库。| 需按机器单独安装和配置。|
| `gitnexus` | 帮 Codex 理解代码仓库结构，例如查调用链、影响范围和依赖关系。| 需按机器安装和索引仓库。|
| `gbrain` | 管理本机记忆检索与维护。| 必须按机器单独配置；不复制数据库、Vault、索引或 OAuth 凭据。|
| `cc-switch-worker` | 让 Codex 在边界清楚的任务里调用受限 worker 执行代码工作；最终结果仍由当前 Codex 任务检查。| 工具源码和配置模板可恢复；worker 登录与任务不可恢复。|
| `openaiDeveloperDocs` | 查询 OpenAI 官方开发文档，适合确认 API、模型或产品的最新用法。| 配置模板可恢复；网络访问按机器可用性决定。|

MCP 如果需要账号、网络或本机服务，没连上时会报错或提示授权。这通常不是 Codex 坏了，先看提示里缺的是登录、服务还是网络。

## Skills：遇到什么事找谁

这些 Skill 已安装在 Codex、Claude Code 或 `.agents` 的对应目录。相同的 Skill 可能被多个工具共用；清单中的 Skill 快照会随仓库恢复，运行时缓存不会。

| 类别 | Skill | 用途 |
| --- | --- | --- |
| 通用 | `humanizer-zh` | 把面向人的中文说明改得自然、直接。|
| 通用 | `tdd` | 需要先写测试再实现时使用。|
| 通用 | `diagnosing-bugs` | 排查报错、性能慢或行为异常。|
| 通用 | `codebase-design` | 设计或整理模块边界。|
| 通用 | `ui-ux-pro-max` | 做界面和用户体验决策。|
| 通用 | `guizang-ppt-skill` | 制作横向翻页的网页演示稿。|
| Codex | `bs` | 在改功能前先确认需求和方案。|
| Codex | `design-md` | 维护项目的 `DESIGN.md`。|
| Codex | `open-design` | 选择视觉规范和设计模板。|
| Codex | `playwright` | 用真实浏览器检查网页或自动化操作。|
| Claude Code / `.agents` | `agent-reach` | 从互联网或指定平台获取资料。|
| `.agents` | `gitnexus-cli`、`gitnexus-guide` | 管理或了解 GitNexus 索引。|
| `.agents` | `gitnexus-debugging`、`gitnexus-exploring` | 排查问题或追踪代码执行路径。|
| `.agents` | `gitnexus-impact-analysis`、`gitnexus-pr-review` | 评估改动影响或审查 PR。|
| `.agents` | `gitnexus-pdg-query`、`gitnexus-taint-analysis` | 追踪条件、数据流和安全风险。|
| `.agents` | `gitnexus-refactoring` | 安全地改名、拆分或移动代码。|

## 新装东西后怎么做

新装插件、Skill 或 MCP 后，不需要手工复制目录到仓库。下次“每周同步 Codex 配置仓库”任务会先检查本机状态：

1. 更新这份说明，写清它是什么、怎么用、能不能恢复。
2. 新 Skill 会被覆盖面审计发现。按提示把它加入 `skills/manifest.json` 后，备份脚本才会复制它。
3. MCP、插件或工具只有在不含凭据且适合迁移时才会进入仓库；否则只保留这里的说明。

如果你要立刻同步，可在 `{{WORKSPACE_ROOT}}\Projects\Project-008-Codex-Portable-Workspace\03_Source` 运行 `./scripts/backup.ps1`，再运行 `./scripts/verify.ps1 -CheckInstalled -AuditInstalledCoverage`。
