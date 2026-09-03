# Codex 工作区入口规范

本文件安装到 `{{WORKSPACE_ROOT}}/AGENTS.md`，是工作区级入口；项目目录内更近的 `AGENTS.md` 可提供更具体的规则。

## 固定入口

- 本机环境与工具：`{{WORKSPACE_ROOT}}/00_本机环境与工具清单.md`
- 项目工作流：`{{WORKSPACE_ROOT}}/01_全局工作台.md`
- Codex 使用说明：`{{WORKSPACE_ROOT}}/02_Codex用户使用说明.md`

## 硬规则

1. `{{WORKSPACE_ROOT}}` 是唯一正式 Codex 工作区。
2. 新项目必须放在 `{{WORKSPACE_ROOT}}/Projects/Project-三位编号-项目名称/`。
3. 修改项目代码前，先阅读项目根目录的 `README.md`、`AGENTS.md`、`00_Project_Brief.md` 和 `99_Retrospective.md`（存在时）。
4. 涉及本机工具、运行环境、依赖、服务、端口或网络时，先阅读 `00_本机环境与工具清单.md`。
5. 凭据、密码、令牌、Cookie、聊天记录和私有配置不得写入工作区文档或项目仓库。
6. 简单问答、一次性命令和临时排查不创建新项目；需要长期保存或多轮交付时才启动项目工作流。

## WSL 工作方式

- Codex 智能体默认运行在 WSL2 Ubuntu + Bash 中；使用 `/mnt/c/...` 和 `/mnt/d/...` 访问 Windows 文件。
- 只有明确需要 Windows 原生能力时才使用 PowerShell 7。
- 不将 `docker-desktop` 作为开发发行版，也不为了网络提示覆盖用户现有 VPN、DNS 或代理配置。

## 修改边界

- 保持目录职责清楚，避免把临时文件散落在工作区根目录。
- 变更完成前运行与改动相匹配的测试、构建或静态检查，并报告实际结果。
- 不为没有明确需求的兼容层、抽象层、依赖或全局配置增加复杂度。
