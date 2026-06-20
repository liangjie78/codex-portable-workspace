# Codex 便携工作区

这是一个私有、受 Git 版本控制的配置仓库，用于在 Windows 新电脑上重新搭建个人 Codex + Claude Code 工作区。

## 可以恢复什么

- Codex 全局 `AGENTS.md`
- Workspace 工作流与协作规则
- Codex 和 Claude Code 共用的 skills
- 定制版 CC-Switch worker 源码
- 由脚本安全生成的 `config.toml`

本仓库不会恢复登录状态、令牌、Cookie、缓存、对话记录或 worker 任务。

## 在新电脑上安装

先安装 Git、Node.js、Codex、Claude Code 和 GitHub CLI，然后运行：

```powershell
git clone https://github.com/liangjie78/codex-portable-workspace.git
cd codex-portable-workspace
.\scripts\install.ps1 -Force -InstallWorkerDependencies
.\scripts\verify.ps1 -CheckInstalled
```

默认安装位置如下：

```text
Codex home:    %USERPROFILE%\.codex
Claude home:   %USERPROFILE%\.claude
Workspace:     D:\Workspace
Worker source: D:\Workspace\Tools\cc-switch-worker-mcp
```

安装完成后，需要分别重新登录 Codex、GitHub 和其他外部连接器。
使用 `-Force` 替换已有文件或目录时，安装脚本会先在原位置旁边创建带时间戳的 `.portable-backup-*` 备份。

## 保持仓库同步

在仓库目录中运行：

```powershell
.\scripts\backup.ps1
git diff
.\scripts\verify.ps1
```

提交并推送前，请先检查 `git diff` 显示的改动。

## 安全机制

备份脚本只复制固定白名单内的文件；`.gitignore` 提供第二层防护；`verify.ps1` 会拒绝已知的敏感文件名和常见凭据格式。请勿手动添加 `.codex\auth.json`、`.env`、API 密钥、Cookie、日志、会话数据或临时任务数据。
