# @deepseek-ai/dsh-agent-team-profile

[English](README.md) | 中文

在 `@deepseek-ai/dsh-base` 之上启用 [Agent Teams](../team/README.md) 的私有 profile bundle。它的 patch 会插入 Team domain 与 scoped 工具、禁用名称重叠的全局 continuable-child control，并保留普通的一次性 fresh／fork delegation 工具。必须从源码 checkout 将本包显式安装到 profile；正式发布会排除本包。

## Profile 安装

在本仓库 checkout 中，将本包添加到已初始化的 profile：

```sh
pnpm dsh plugin --profile headless add ./packages/experimental/agent-team-profile
pnpm dsh --profile headless "Use Agent Teams to split this task between two teammates, wait, and summarize."
```

profile 必须已经包含 `@deepseek-ai/dsh-base`，本层会使用其中的 Subagent service 与 provider 配置行。执行 `dsh plugin --profile <name> remove @deepseek-ai/dsh-agent-team-profile` 移除本包时，bundle 也会从 profile 的有序层列表中移除。

## Model Experience

### Team 策略与工具

#### 模型会看到什么

Team 策略与 schema 由 [`@deepseek-ai/dsh-tool-team`](../tool-team/README.md) 所有。本 bundle 只改变 composition：Team-scoped `list_agents` 与 `send_message` 会替代已禁用的全局 continuable-child control，而 `subagent` 与 `subagent_fork` 仍作为一次性 delegation 工具可用。

#### Token 影响

本 bundle 会加入 `dsh-tool-team` 描述的 Team 策略与工具 schema；它自身不增加提示词文本。

#### KV Cache 影响

只要 bundle patch、Team identity 与配置的工具 schema 不变，本 bundle 的 composition 就保持前缀稳定。

## Known Limitations and Deferred Work

- **仅限源码 checkout**：正式 npm、CLI、Web 与 Python 发布产物都不包含这个私有包。
- **共享 checkout**：所有 teammate 都观察同一个工作目录；本 bundle 不提供 worktree 隔离或文件系统锁。
