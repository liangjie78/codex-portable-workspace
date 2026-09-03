# Codex 便携工作区（WSL2 优先）

这是一个公开、可迁移的 Codex 工作区配置源。它只保留当前使用的 WSL2 Ubuntu + Bash 工作流、全局规则、`D:\Workspace` 入口文件、WSL 网络配置和验证脚本。

Windows 只负责 Windows 专属设置、应用和宿主机能力。仓库不保存登录状态、密码、token、Cookie、缓存、会话、日志、本机记忆或完整私有配置。

## 快速开始

在 Ubuntu-24.04 的 WSL 终端中执行：

```bash
git clone https://github.com/liangjie78/codex-portable-workspace.git
cd codex-portable-workspace

# 先预览，不写入任何目标
bash scripts/install.sh --dry-run

# 确认目标路径后安装；已存在的受管文件会先备份
bash scripts/install.sh --force

# 验证仓库和已安装的规则
bash scripts/verify.sh --installed

# 检查 WSL、基础工具、Codex 沙箱和网络提示
bash scripts/doctor.sh
```

如果只想安装到隔离目录做测试：

```bash
bash scripts/install.sh \
  --force \
  --skip-config \
  --no-windows-codex \
  --codex-home /tmp/codex-home \
  --workspace-root /tmp/codex-workspace
bash scripts/verify.sh \
  --installed \
  --skip-config \
  --codex-home /tmp/codex-home \
  --workspace-root /tmp/codex-workspace
```

脚本默认使用当前 WSL 用户的 `~/.codex`，以及 `/mnt/d/Workspace`。如果检测到 Windows 用户的 `C:\Users\<用户>\.codex`，也会同步当前全局规则，并将 Codex 智能体的 WSL 运行开关设为 `true`。已有 `config.toml` 的其他字段保持不变。

## 目录

```text
codex/                      Codex 全局规则和最小配置片段
workspace/                  D:\Workspace 的当前入口文件
wsl/                        当前 WSL 网络配置示例
scripts/                   Bash 安装、备份、验证、诊断和 CI
docs/                      架构、安全边界和迁移说明
```

## WSL 与 VPN

`wsl/.wslconfig` 记录当前使用的 mirrored networking、自动代理、DNS tunneling 和 Windows 防火墙配置。安装脚本默认不会覆盖用户的 `.wslconfig`、VPN、DNS 或代理设置。

如果网络已经正常，不要为了消除 localhost 代理提示而改动配置。确实需要变更时，先备份现有文件，确认差异后再手动应用，并按 Windows 要求执行 `wsl --shutdown`。

## 同步与验证

仓库是当前配置的发布和恢复来源。反向读取本机当前公开规则前，先预览：

```bash
bash scripts/backup.sh --help
bash scripts/backup.sh --dry-run
bash scripts/backup.sh --apply --force
bash scripts/verify.sh
bash scripts/ci.sh
```

脚本只处理明确登记的当前规则和配置片段，不扫描或复制整个用户目录；不会自动提交或推送 Git 变更。

## 安全边界

公开仓库中禁止出现认证文件、`.env`、私钥、API key、Cookie、日志、缓存、会话、数据库、机器私有绝对路径和真实任务快照。发现疑似泄露时不要在 Issue 中粘贴完整内容，请按 [SECURITY.md](SECURITY.md) 处理。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
