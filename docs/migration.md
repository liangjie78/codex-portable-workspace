# 从旧版仓库迁移

本次重构不兼容旧版 PowerShell 安装器、旧的技能快照、Worker 镜像和多 Agent 文档。远程仓库保留 Git 提交历史，但当前 `main` 的工作树只包含现行 WSL2 工作流。

## 新机器

1. 安装并确认 WSL2 Ubuntu-24.04、Git、Python 3、Node.js/npm 和 Codex CLI。
2. 在 Ubuntu 终端克隆仓库。
3. 运行 `bash scripts/install.sh --dry-run` 查看目标。
4. 运行 `bash scripts/install.sh --force`；已有受管文件会先备份。
5. 运行 `bash scripts/verify.sh --installed` 和 `bash scripts/doctor.sh`。
6. 在 Codex 应用中确认智能体环境选择“适用于 Linux 的 Windows 子系统”，然后按应用要求重启。

## 当前机器

当前机器的 WSL 网络配置已经由外部流程设置。不要因为仓库迁移而覆盖 `C:\Users\<用户>\.wslconfig`、VPN、DNS 或代理；只在 `doctor.sh` 报告实际问题并确认差异后再手动处理。

## 回滚

安装器创建的 `.portable-backup-*` 文件可以手动恢复。Git 仓库的历史提交也仍然保留；本次重构没有删除仓库或重写历史。
