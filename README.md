# Codex 便携工作区

这是一个公开、受 Git 版本控制的个人便携工作区模板仓库，用于在 Windows 新电脑上重新搭建 Codex + Claude Code 工作区。

本仓库公开的是可迁移的规则、技能快照、工具源码和安装脚本，不包含登录状态、令牌、Cookie、缓存、会话记录或本机知识库数据。使用前请先阅读脚本和安全说明，再按自己的机器路径调整配置。

## 可以恢复什么

- Codex 全局 `AGENTS.md`。
- Workspace 工作流与协作规则。
- 面向实际使用者的插件、Skills 与 MCP 使用说明。
- Codex、Claude Code 和 `.agents` skills 快照。
- 定制版 CC-Switch worker 源码。
- CodexMemory MCP / CLI 源码。
- 由脚本安全生成的 `config.toml`。

本仓库不会恢复登录状态、令牌、Cookie、缓存、对话记录、worker 任务或 `D:\Workspace\CodexMemory` 中的本机记忆数据。CodexMemory MCP 是可迁移工具层；知识库内容只在本机维护。

## 在新电脑上安装

先安装 Git、Node.js、Codex、Claude Code 和 GitHub CLI，然后运行：

```powershell
git clone https://github.com/liangjie78/codex-portable-workspace.git
cd codex-portable-workspace
.\scripts\install.ps1 -Force -InstallWorkerDependencies
.\scripts\verify.ps1 -CheckInstalled -AuditInstalledCoverage
```

默认安装位置如下：

```text
Codex home:                 %USERPROFILE%\.codex
Claude home:                %USERPROFILE%\.claude
Agents home:                %USERPROFILE%\.agents
Workspace:                  D:\Workspace
Worker source:              D:\Workspace\Tools\cc-switch-worker-mcp
CodexMemory MCP source:     D:\Workspace\Projects\Project-013-CodexMemory\03_Source\codex-memory-mcp
CodexMemory local knowledge root: D:\Workspace\CodexMemory
```

安装完成后，需要分别重新登录 Codex、GitHub 和其他外部连接器。使用 `-Force` 替换已有文件或目录时，安装脚本会先在原位置旁边创建带时间戳的 `.portable-backup-*` 备份。

## 保持仓库同步

在仓库目录中运行：

```powershell
.\scripts\backup.ps1
git diff
.\scripts\verify.ps1 -AuditInstalledCoverage
```

`backup.ps1` 会自动刷新白名单快照并运行安装态覆盖面审计。如果本机新增了 skill 或 CodexMemory MCP 源码路径缺失，但 `skills\manifest.json` 或工具白名单没有更新，脚本会失败并点名漏项。提交并推送前，请先检查 `git diff` 显示的改动。

日常使用可先看 `D:\Workspace\02_Codex用户使用说明.md`。它解释当前安装的插件、Skills 与 MCP 各自做什么；每次自动同步前都会按本机状态更新，并随备份进入仓库。

## 安全机制

备份脚本只复制固定白名单内的文件；`.gitignore` 提供第二层防护；`verify.ps1` 会拒绝已知的敏感文件名和常见凭据格式。请勿手动添加 `.codex\auth.json`、`.env`、API 密钥、Cookie、日志、会话数据、临时任务数据或 CodexMemory 本机知识库内容。

如果发现疑似敏感信息，请不要在公开 Issue 中粘贴密钥、token 或完整日志，按 `SECURITY.md` 中的方式处理。

## 许可证

本仓库使用 MIT License，详见 `LICENSE`。
