# Codex 便携工作区

这是一个公开、受 Git 版本控制的个人便携工作区模板仓库，用于在 Windows 新电脑上重新搭建 Codex + Claude Code 工作区。

本仓库公开的是可迁移的规则、技能快照、工具源码和安装脚本，不包含登录状态、令牌、Cookie、缓存、会话记录或本机知识库数据。使用前请先阅读脚本和安全说明，再按自己的机器路径调整配置。

## 可以恢复什么

- Codex 全局 `AGENTS.md`。
- Workspace 工作流与协作规则。
- 面向实际使用者的插件、Skills 与 MCP 使用说明。
- Codex、Claude Code 和 `.agents` skills 快照。
- 定制版 CC-Switch worker 源码。
- 由脚本安全生成的 `config.toml`。

本仓库不会恢复登录状态、令牌、Cookie、缓存、对话记录、worker 任务或本机记忆数据。GBrain 由每台机器单独配置，不随本仓库恢复。

## 在新电脑上安装

先安装 Git、Node.js、Codex、Claude Code 和 GitHub CLI，然后运行：

```powershell
git clone https://github.com/liangjie78/codex-portable-workspace.git
cd codex-portable-workspace
pwsh -NoProfile -File .\scripts\install.ps1 -Force -InstallWorkerDependencies
pwsh -NoProfile -File .\scripts\verify.ps1 -CheckInstalled -AuditInstalledCoverage
```

默认安装位置如下：

```text
Codex home:                 %USERPROFILE%\.codex
Claude home:                %USERPROFILE%\.claude
Agents home:                %USERPROFILE%\.agents
Workspace:                  D:\Workspace
Worker source:              D:\Workspace\MCP\cc-switch-worker-mcp
GBrain MCP source:          D:\Workspace\MCP\gbrain
GBrain brain source:        D:\Workspace\GBrain
```

安装完成后，需要分别重新登录 Codex、GitHub 和其他外部连接器。`-Force` 对普通文件和目录先创建带时间戳的 `.portable-backup-*` 备份；对已有 `config.toml` 只更新本仓库负责的 Workspace、Worker 和 OpenAI 文档 MCP 字段，保留其他键、MCP、hooks、memories 和 plugins 配置。合并只显示字段名，不输出现有配置值。可先用 `-WhatIf` 预览，预览不会创建目录、备份或 inventory，也不会输出安装成功提示。

恢复配置备份时，在确认目标路径后运行：

```powershell
Copy-Item -LiteralPath <backup-config.toml> -Destination "$HOME\.codex\config.toml" -Force
pwsh -NoProfile -File .\scripts\verify.ps1 -CheckInstalled
```

## 保持仓库同步

在仓库目录中运行：

```powershell
pwsh -NoProfile -File .\scripts\backup.ps1
git diff
pwsh -NoProfile -File .\scripts\verify.ps1 -AuditInstalledCoverage
```

便携仓库是发布和恢复的唯一事实来源。`backup.ps1` 只把 Workspace 规则和已登记 skills 生成到仓库外的候选目录；候选通过验证后，脚本才替换正式快照。与生成路径无关的未提交改动会保留，生成路径本身有用户改动时脚本停止，不覆盖文件。实际 Worker 不再反向覆盖便携源码；两边不一致时备份失败，需用安装脚本从便携源恢复。

`skills\manifest.json` 只把逐字一致的 Codex/Claude skill 放在 `shared_skills`。两个平台内容不同的 skill 分别保存到 `skills\codex` 和 `skills\claude`，恢复时不会拿一份快照覆盖两边。

安装脚本会写入 `%USERPROFILE%\.codex\portable-install-inventory.json`。`verify.ps1 -CheckInstalled` 按清单中的路径和 SHA-256 检查安装结果，同时核对 `01_`、`02_`、`04_`、`05_` Workspace 规则和 Worker 镜像。正文损坏或规则缺失都会失败。

如果本机新增了 skill 但 manifest 没有登记，覆盖面审计会失败并点名漏项。提交和推送仍由人工或自动化任务在检查 `git diff` 后执行，脚本本身不提交。

本地 doctor 会按结构化状态检查 Agent Reach、GBrain、Worker、GitNexus 真实查询和便携仓库漂移；`warn`、`off`、`degraded` 不会显示为全绿：

```powershell
pwsh -NoProfile -File .\scripts\doctor.ps1 -Quick
pwsh -NoProfile -File .\scripts\doctor.ps1 -Json
```

完整离线回归使用：

```powershell
pwsh -NoProfile -File .\scripts\smoke-portable-workspace.ps1
```

本地和 GitHub Actions 使用同一套 CI 入口；它在临时目录 clean install Worker，不污染正式工作树：

```powershell
pwsh -NoProfile -File .\scripts\ci.ps1
```

每周 `backup.ps1` 在候选验证通过后、替换正式快照前运行实际 Worker 离线套件。候选或离线套件失败时不会替换正式快照，下一轮仍可重试。

日常使用可先看 `D:\Workspace\02_Codex用户使用说明.md`。它解释当前安装的插件、Skills 与 MCP 各自做什么；每次自动同步前都会按本机状态更新，并随备份进入仓库。

## 安全机制

备份脚本只复制固定白名单内的文件；`.gitignore` 提供第二层防护；`verify.ps1` 会拒绝已知的敏感文件名和常见凭据格式。请勿手动添加 `.codex\auth.json`、`.env`、API 密钥、Cookie、日志、会话数据、临时任务数据或本机记忆数据。

如果发现疑似敏感信息，请不要在公开 Issue 中粘贴密钥、token 或完整日志，按 `SECURITY.md` 中的方式处理。

## 许可证

本仓库使用 MIT License，详见 `LICENSE`。
