# @deepseek-ai/dsh-client-ui-agent-team

[English](README.md) | 中文

私有 Web Agent Teams 呈现包。它向会话页头提供一个包含当前 roster 与共享任务板的 action。Client plugin 挂载由 [`@deepseek-ai/dsh-agent-team-remotes`](../agent-team-remotes/README.md) 提供的生成式 `ctx.remote.teams` contribution；它不扩展稳定 API Proxy，也不存储权威 Team 状态。

打开 panel 会调用 `teams/view`。Roster row 展示持久 name、运行时 status、model 与 diagnostics。选择健康 teammate 时，系统刷新既有直接 child catalog，并打开普通的 `{ parentSessionId, childSessionId, mode: 'continuable' }` address。History 与后续人类 prompt 继续使用稳定 addressed-subagent 会话路径；本包不会向该 address 添加 Team 专用字段。

任务板展示 task identity、owner、blocker、readiness、提示性 write scope 与重叠 warning。人类可以通过 `teams/createTask` 与 `teams/updateTask` 创建、编辑、分配或取消分配、完成、重开和删除任务。每次 mutation 都发送当前显示的 revision。收到 `team-task-conflict` 结果后，UI 仅在重新读取 Team view 成功后显示状态陈旧提示；如果重新读取失败，则保留该错误。Team service 将任务文本或 scope 编辑与 dependency 修改公开为两个独立 action，因此两者仍使用两个连续的 compare-and-set mutation。

Root export 在 Host 上不执行行为。Client export 负责 locale 与 slot 注册，Cordis 会随 plugin fiber dispose 两者。在稳定 Web bundle 与 Host 侧 Agent Teams profile 之后，通过 [`@deepseek-ai/dsh-agent-team-web-profile`](../agent-team-web-profile/README.md) 安装本包。

## 模型体验

无直接影响，因为该浏览器 projection 与任务控制界面不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与暂缓事项

- **Snapshot refresh**：panel 会在打开、显式 refresh 与 mutation 后刷新；它没有实时 event subscription 或 mailbox timeline。
- **普通 child continuation**：导航后发送的人类消息使用稳定 addressed-subagent prompt 路径，而不是 Team peer mailbox。
- **没有 lifecycle 或 workspace control**：panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。
