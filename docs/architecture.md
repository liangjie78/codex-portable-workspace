# 当前工作流架构

## 目标

以当前已经验证的 WSL2 Ubuntu-24.04 + Bash 为唯一默认开发运行层，让 Windows 只承担宿主机和 Windows 专属任务。仓库公开的是可恢复的规则与脚本，不是整机镜像。

## 文件职责

| 路径 | 安装目标 | 负责内容 |
| --- | --- | --- |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md`，以及检测到的 Windows Codex home | Codex 用户级通用规则 |
| `codex/config.fragment.toml` | Codex `config.toml` 的受管字段 | 只确保智能体运行在 WSL |
| `workspace/AGENTS.md` | `D:\Workspace\AGENTS.md` | 工作区入口规则 |
| `workspace/00_...template.md` | `D:\Workspace\00_...md` | 本机环境记录模板 |
| `workspace/01_...md` | `D:\Workspace\01_...md` | 项目工作流 |
| `workspace/02_...md` | `D:\Workspace\02_...md` | 面向使用者的说明 |
| `wsl/.wslconfig` | 仅作为当前配置参考 | mirrored、代理和 DNS tunneling 示例 |
| `scripts/` | 不安装到用户目录 | 安装、备份、诊断和验证 |

## 运行层与终端层

Codex 的智能体运行环境和集成终端 Shell 是两个独立设置。当前机器已经验证智能体运行在 WSL2；集成终端仍可按用户需要显示 PowerShell。仓库安装器只管理智能体的 WSL 开关，不擅自改终端偏好。

## 配置策略

- 规则文件使用模板变量渲染，不写死用户名和本机盘符。
- 现有 `config.toml` 只更新 `[desktop]` 下的 `runCodexInWindowsSubsystemForLinux`；其他模型、插件、MCP、项目信任和用户字段原样保留。
- 覆盖受管文件前创建相邻 `.portable-backup-*` 备份；不删除用户文件。
- `.wslconfig` 默认不由安装器覆盖，因为 VPN、DNS 和代理属于机器私有网络状态。
- 认证、Cookie、会话、缓存、任务数据、日志和本机知识库始终留在机器本地。

## 可验证结果

`doctor.sh` 应能看到 Linux、WSL2、Ubuntu-24.04、Bash、Codex 和 bubblewrap；`codex sandbox -- /bin/bash -lc 'printf ...'` 必须实际返回成功标记。网络检查只报告当前状态，不把一次 VPN 超时误判为 WSL 配置失效。
