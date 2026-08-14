# subagent/：subagent 能力家族

[English](README.md) | 中文

本家族允许一个 agent（智能体）将工作委派给子 agent。多个具名提供方可在同一上下文中共存。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`subagent/`](subagent/README.md) | 定义提供方注册、委派和继续执行 | `ctx.subagents` |
| [`subagent-inprocess/`](subagent-in-process-driver/README.md) | 提供共享的进程内运行驱动器 | 无 |
| [`subagent-spawn-in-process/`](subagent-spawn-in-process/README.md) | 启动全新的进程内子 agent | 注册到 `ctx.subagents` |
| [`subagent-fork-in-process/`](subagent-fork-in-process/README.md) | 从父 agent 已完成的历史记录启动进程内子 agent | 注册到 `ctx.subagents` |
| [`subagent-acp/`](subagent-acp/README.md) | 通过 ACP（Agent Client Protocol）启动进程外子 agent | 注册到 `ctx.subagents` |
| [`subagent-codex/`](subagent-codex/README.md) | 启动真实的 Codex app-server 子 agent | 注册到 `ctx.subagents` |
| [`subagent-claude-code/`](subagent-claude-code/README.md) | 通过官方 Claude Agent SDK 启动真实的 Claude Code 子 agent | 注册到 `ctx.subagents` |
| [`subagent-dsh-sdk/`](subagent-dsh-sdk/README.md) | 通过 TypeScript SDK 启动进程外 Harness 子 agent | 注册到 `ctx.subagents` |
| [`tool-subagent/`](tool-subagent/README.md) | 向模型公开委派操作 | 注册到 `ctx.tools` |
| [`tool-subagent-control/`](tool-subagent-control/README.md) | 向模型公开子级消息发送和列举操作 | 注册到 `ctx.tools` |
| [`tool-subagent-report/`](tool-subagent-report/README.md) | 提供从子级到父级的报告通道 | 注册到子级作用域 |

Claude Code 包也是一个可选的 Profile Bundle。使用 `dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code` 安装后重启该 Profile；该包只注册休眠的 Host provider，而复制出的 Agent Preset 会单独把默认禁用的工具模板授予新 Session。移除该包后，下一次 Profile 启动会撤回对应 provider。Codex 包仍须作为 Host 插件显式挂载，并使用 `PATH` 中的宿主 `codex`。

参见有关[能力家族](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)、[可继续执行的子级](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md)和[控制工具](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md)的决策。

子系统参考——启动请求、结果、实时运行、提供方约定、可续跑后台子 agent——见 [docs/subsystems/subagent.md](../../docs/subsystems/subagent.md)；设计依据见 [subagent 能力 seam](../../.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.md)、[可续跑后台 subagent](../../.agents/notes/implemented/feature/2026-07-21-continuable-background-subagents.md)与[合并 subagent 控制服务](../../.agents/notes/implemented/simplification/2026-07-26-merge-subagent-control-service.md) Agent Note。
