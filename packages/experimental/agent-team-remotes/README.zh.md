# @deepseek-ai/dsh-agent-team-remotes

[English](README.md) | 中文

Agent Teams Typert Remote contribution 的私有 Client assembly。它的 Client entry 导入生成式 `@deepseek-ai/dsh-team/remote` runtime value，通过稳定 `ctx.remote.$mount()` service 挂载，并重新导出为 `ctx.remote.teams` 增加类型的 declaration merge。

该 contribution 提供 `teams/view`、`teams/createTask` 与 `teams/updateTask`。生成式 codec 校验参数和结果，Team service 仍是 roster 与 task 状态的唯一 owner。本包不包含 Host resolver 或 transport 逻辑；`@deepseek-ai/dsh-api-remotes` 提供稳定 Remote service 与 Agent identity policy。

Root export 不执行行为，因为本包只在 Client 环境挂载。[`@deepseek-ai/dsh-agent-team-web-profile`](../agent-team-web-profile/README.md) 会先于 Team UI 插入本包，确保 UI 激活时 namespace 已存在。

## 模型体验

无直接影响，因为该 Client assembly 只挂载 typed Remote method，不注册面向模型的输入。

#### KV Cache 影响

无直接影响；被调用的 Team method 及其面向模型的 consumer 负责后续任何影响。

## 已知限制与暂缓事项

- **固定 contribution 集合**：增加 Team Remote method 时，需要重新生成 Team artifact 并重建这个显式 assembly。
- **仅限源码 checkout**：正式发布会排除这个私有包。
