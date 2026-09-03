# AGENTS.md — Codex portable workspace repository

本仓库是公开、可迁移的 Codex 工作区配置源。它只保存规则、文档、可审计的脚本和公开源码，不保存任何登录状态或本机私有数据。

## 开始前

- 阅读 `README.md`、`docs/architecture.md`、`codex/AGENTS.md` 和 `workspace/AGENTS.md`。
- 运行时默认使用 WSL2 Ubuntu + Bash；只有明确涉及 Windows 专属能力时才使用 PowerShell 7。
- 修改脚本后先运行 `bash scripts/ci.sh`。

## 修改边界

- 不提交密码、token、API key、Cookie、认证文件、缓存、会话、日志、数据库、机器记忆或本机绝对路径。
- 安装脚本只能写入用户明确指定的目标，并在 `--force` 覆盖前创建旁边的备份。
- 默认不修改 Windows VPN、DNS、代理或 `.wslconfig`；网络配置只提供示例和检查。
- 只保留当前工作流需要的规则、文档和脚本；旧版快照、兼容入口和未登记能力不重新加入。

## 验证

```bash
bash scripts/verify.sh
bash scripts/smoke.sh
bash scripts/ci.sh
```

真实安装验证需要使用隔离目标目录，例如：

```bash
bash scripts/install.sh --force --skip-config --no-windows-codex --codex-home /tmp/codex-home --workspace-root /tmp/codex-workspace
bash scripts/verify.sh --installed --skip-config --codex-home /tmp/codex-home --workspace-root /tmp/codex-workspace
```
