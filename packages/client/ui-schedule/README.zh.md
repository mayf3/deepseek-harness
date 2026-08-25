# @deepseek-ai/dsh-client-ui-schedule

[English](README.md) | 中文

当前 Session 活动 Schedule 记录的只读 Web 目录。插件向 `conversation.session.header.actions` 贡献一个入口，位置在静态 Agent 与 Subagent 上下文之后、后台 Jobs 入口之前。它通过标准 Session hook 读取 `openState`，通过 `useProjection` 读取完整的 `schedule` 值；不发 RPC，也不接收 mutation callback。

只有 Session 已成功打开且 projection 至少包含一条记录时才显示触发器。弹层宽 336px，内容过高时在内部纵向滚动；每条 prompt 都以可完整换行的纯文本显示。每行把状态与三项元数据分开呈现：本地化的「单次」或 Every 间隔可整除的最大完整单位、浏览器本地目标时间，以及按浏览器时钟派生的相对时间。间隔绝不舍入。逾期记录排在最前，随后按 `scheduledAt` 排序；完全并列时保留 projection 中的创建顺序。

只有原生按钮进入 Tab 顺序。Enter 与 Space 使用按钮的正常激活行为；Escape 关闭弹层并把焦点交还触发器；在外部按下指针也会关闭。若 live projection 更新移除了最后一条记录，组件会关闭并卸载，但不会主动把焦点移到另一个 header action。

该目录不是交付回执。它不显示 Schedule id、原始 UTC、详情、mutation、Retry、Toast 或 Schedule 专属 transcript 卡片。到期提醒仍只通过普通 Assistant 对话输出到达；Session 打开失败时，即使此前缓存过目录值，也会隐藏入口。

行为与归属边界记录在[只读 Web Schedule 目录 Agent Note](../../../.agents/notes/implemented/feature/2026-08-25-read-only-web-schedule-catalog.zh.md)中。

## 模型体验

无，因为本包只为人类渲染已经完成的客户端 projection，从不改变 prompt、消息、schema、流或工具结果。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与暂缓事项

- **仅含活动记录**——终结性的 delete 与 dispatch 转换会移除对应行；普通 transcript 仍是唯一的提醒交付历史。
- **浏览器派生时间**——本地时间与相对时间标签使用当前浏览器的 locale、时区和时钟。它们是呈现值，不是持久 Schedule 事实。
- **只读界面**——创建、删除和检查面向模型的交付状态仍归 Schedule 工具；本包有意不提供操作控件。
