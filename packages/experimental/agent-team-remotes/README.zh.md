# @deepseek-ai/dsh-agent-team-remotes

[English](README.md) | 中文

Agent Teams 的私有浏览器 Remote adapter。其 Host service 注册为 `ctx.teamRemote`，并导出独立的 `teams` wire namespace，因此不会替换或扩大 domain 所有的 `ctx.teams` service。Adapter 将所有读取与 mutation 委托给 `ctx.teams`，不持有 roster、mailbox、task 或 lifecycle state。

生成式 contribution 提供 `teams/view`、`teams/createTask` 与 `teams/updateTask`。View 不包含 mailbox 内容或已删除 task tombstone。Task conflict 通过封闭 business result 跨越 Remote；其他 Team rejection 与 carrier 或 Agent lookup failure 保持可区分。`@deepseek-ai/dsh-api-remotes` 提供稳定 Remote carrier 与 Agent identity policy。

[`@deepseek-ai/dsh-client-ui-agent-team`](../client-ui-agent-team/README.md) 通过 `ctx.remote.$mount()` 挂载生成式 Client contribution。[`@deepseek-ai/dsh-agent-team-web-profile`](../agent-team-web-profile/README.md) 会先于该 UI 插入此 Host adapter。

## 模型体验

无直接影响，因为该浏览器 adapter 只委托 typed Remote method，不注册面向模型的输入。

#### KV Cache 影响

无直接影响；被调用的 Team method 及其面向模型的 consumer 负责后续任何影响。

## 已知限制与暂缓事项

- **固定 contribution 集合**：增加浏览器 operation 时，需要修改该 adapter 并重新生成其 Remote artifact。
- **仅限源码 checkout**：正式发布会排除这个私有包。
