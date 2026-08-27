# Agent Note: 将 Web 已排队消息转为活动轮次的 steering（中途引导）

Status: implemented

[English](2026-07-30-web-queue-steer-action.md) | 中文

## 问题

Web composer 原本会在 agent（智能体）运行期间把所有 Enter 提交作为 Queue 入队。QueueDock 已经为每条待处理消息提供可寻址的行，持久 transcript（文本记录）也已能把消费后的 steer 事件渲染为用户样式气泡，但 Web 既没有连接这两个界面的操作，也没有让用户从 composer 直接选择当前轮次 steering 的手势。

如果 Web 先在客户端删除该行，再调用 `session.prompt(mode: 'steer')`，就会把用户的一次意图拆分到两个 RPC 中。驱动器可能在两次调用之间先认领该项，steering 投递也可能在删除后失败；现有尽力而为的 `agent.steer()` 回退还可能在原单次入队项被移除后，静默追加一个新的 Queue 项。因此，立即发送操作必须区分当前轮次 steering 与 Queue 前移，并在 steering 已不可用时保留原行。

## 决策

### 产品约定

普通会话中每个非编辑态的 QueueDock 行都会提供名为「插话发送」的向上箭头操作。仅当会话报告 agent 正在运行时，该操作才会启用；包含混合内容的消息仍可使用，因为 steering 会转发完整且不可变的 `UserMessage`，而非该行的文本投影。已寻址 subagent 的 Queue 投影保持只读，因为其继续执行传输不提供 Queue 变更。

触发该操作会针对对应的 `MessageId` 请求当前轮次 steering。操作成功后，消息会从 `inbox['next-turn']` 移入 `inbox['next-step']`；QueueDock 移除其行，ChatView 则在 `Deep diving...` 运行状态行之后渲染同一条待处理 steering，提供复制但不提供 fork。AgentLoop 排空该项后，持久删除会移除待处理气泡，现有 `user/message` 事件则进入普通 Conversation Node 路径，并携带时钟与复制操作。

running 标志位既是交互提示，也是 Host 的同步准入检查。如果 Agent 已不再运行，操作会保持 Queue 消息不变并返回类型化的 `steer-unavailable` 错误，随后原唤醒消息会经 Queue 继续执行。如果驱动器已经认领该消息，则返回现有的 `queue-item-not-found` 错误，且独立轮次投递已经开始。UI 会把两种竞态都视为已收敛的 Queue 投递，不显示失败通知；传输和未知错误仍会显示。

Composer 对新输入采用另一套尽力而为约定。所寻址会话空闲时，Enter 和 Cmd/Ctrl+Enter 都执行普通 Queue 发送。主会话运行期间，General Settings 偏好会把普通 Enter 分配为 Queue（默认值）或 Steer，Cmd/Ctrl+Enter 则执行另一种行为；Shift+Enter 用于换行。已寻址 subagent 会让这两个手势都使用其仅支持 Queue 的继续执行传输。Host settings 文档会在共享同一 DSH home 的 Web origin 之间持久化该偏好，并且它只影响支持 steering 的繁忙态手势对。如果 composer 直接发出的 Steer 错过当前 next-step 窗口，AgentLoop 会自动将其接纳为下一条唤醒 Queue 轮次，Web 不显示失败。

### Agent 与生命周期边界

`session.updateQueue` 会在 `Inbox.nextTurn` 中定位 `MessageId`，并要求 Agent 正在运行。随后，它会移除对应消息，并同步把同一个不可变 `UserMessage` 传给 `Agent.steer()`。这两次 Inbox 变更会在没有 await 或第二次 RPC 的情况下，先追加一条 canceled `next-turn` 删除，再追加一条 `next-step` 插入，同时保留消息 id、内容与来源。选择 steering 会把投递方式从经独立接纳的轮次改为当前轮次的 next-step 输入；它既不会取消当前工作，也不会重新排序 Queue 中的剩余项。

### Host 与客户端边界

`session.updateQueue` 会携带 `steer` 操作，并把两种负面结果映射为类型化 RPC 错误。这项转换是一对同步 Inbox 操作；Host 绝不会通过组合移除与提示词 RPC 来重建它。

AgentRegistry 的标准 `inbox` 会话投影是唯一的 Web 待处理输入权威。它无需查询 live Agent 即可折叠持久 `agent/inbox/spliced` 事件，并携带原始 `next-turn` 与 `next-step` 列表。QueueDock 渲染 `next-turn`，ChatView 则在会话流末尾、`Deep diving...` 运行状态行之后渲染用户来源的 `next-step` 消息，提供复制操作，但不提供 fork、编辑或删除操作。通用投影传输层会提供实时推送、历史尾页的重连基线、冷日志折叠与进程重启恢复，因此这项可见性既不需要客户端乐观展示，也不需要仅适用于 live 状态的镜像。

AgentLoop 认领待处理 steering 时，对应纯删除 splice 会从 `next-step` 移除消息。匹配的持久 `user/message` 随后进入普通 Conversation Node 投影，并根据已记录的事件时间与序号恢复时钟和复制操作。客户端 Inbox 折叠或投影拥有的交接列表都不参与其中。

现有 `session.prompt(mode: 'steer')` 对主会话新输入仍采用尽力而为的约定：在 next-step 窗口之外，它会变为唤醒 agent 的后续轮次。Composer 会让显式 `queue | steer` 模式经过 slash 裁决与引用序列化，再调用该约定。浏览器提交策略拥有实时繁忙态 Enter 偏好，而 Host settings 服务拥有持久性；该策略只为支持 steering 的会话把普通 Enter 与加速 Enter 解析为互补手势，Settings 行和 InputBar 共享该策略，不重复实现存储或投递窗口权威。只有 Queue 行操作采用严格语义，因为任一种负面结果都会经原 Queue 单次入队项收敛。

### 验证

AgentLoop 约定覆盖保持提示词接纳窗口打开，转换一个精确的 queued 单次入队项，并证明替代它的 steering 单次入队项保留消息值和投递回执、以 `user/message` 的形式排空，且绝不启动原本的独立轮次。该覆盖还钉住窗口不可用时保留原项、拒绝已被认领的地址，以及可重入取消下的生命周期守恒。

Host schema 和代理测试覆盖新操作、两种类型化错误、Inbox 投影快照、重连重放与持久删除顺序。客户端测试覆盖两种语义竞态的静默收敛、真实错误报告、只读 subagent 行和仅支持 Queue 的 subagent 手势。运行时与 ChatView 测试覆盖直接渲染待处理 Inbox；Web ARIA 快照则覆盖运行状态行之后的待处理 steering 与后续持久节点。

无密钥 Web steering 场景在第一次响应流式输出期间，通过真实 composer 排队一条消息并触发行上的箭头，再用 `ask_user_question` 作为稳定的待处理 steering 屏障。该场景证明 Host 支撑的待处理气泡会在准入前出现，在回答后交接为唯一一条持久插话，并影响下一次模型请求。组装后的 composer 场景证明默认模式下的 Cmd+Enter 无需创建 Queue 行，也会进入同一条待处理与持久路径；Steer 模式下的 Cmd+Enter 则会创建 Queue 行。Settings 与提交策略覆盖会固定默认值、持久化、仅限繁忙态的作用域和互补手势映射；Queue 编辑／删除场景继续证明这些操作没有变化。

## 考虑过的替代方案

**在 Web 中删除该行，再调用 `session.prompt(mode: 'steer')`。** 不予采纳，因为两个 RPC 无法让删除和 steering 成为原子操作；失败和驱动器认领竞态可能丢失或重复用户消息。

**恢复向上箭头对应的 Queue 前移操作。** 不予采纳，因为把某个项移到队首仍然会创建一个独立接纳的轮次。该控件承诺的是当前轮次 steering，而不是 Queue 内的优先级。

**为 Queue 行使用现有尽力而为的 `agent.steer()` 行为。** 不予采纳，因为关闭的 next-step 窗口会创建新的 queued 单次入队项，而且位置和标识可能不同。严格拒绝会保留原单次入队项，让 UI 能将其视为同一次已接纳的 Queue 投递。新输入的 composer 消息没有需要保留的现有 Queue 单次入队项，因此有意采用尽力而为行为。

**让每个调用方使用的 `agent.steer()` 都采用严格语义。** 不予采纳，因为 TUI 和插件调用方会针对新提交的输入使用其安全的后续轮次回退。queued 行具有这些调用方不具备的可恢复状态。

**在改变 placement 时生成第二个行标识。** 不予采纳，因为 `MessageId` 已经可以跨两份 Inbox 列表寻址持久待处理消息。让同步删除与插入保持该标识，即可由同一份投影表达投递变化，无需单次出现包装层。

**增加专用的待处理 steering 投影和客户端 store。** 不予采纳，因为 queued 与 steering 消息已经共享标准持久 `inbox` 投影。各客户端界面选取自己呈现的列表与消息来源，无需重复重连状态或顺序权威。

**取消活动轮次并运行选中的 Queue 项。** 不予采纳，因为这会破坏无关的进行中工作，并且会启动新轮次，而不是 steering 当前轮次。

## 后果

`inbox` 是领域拥有的持久会话投影。待处理 steering 会从 `next-step` 立即出现，能在重连与进程重启后恢复；认领后，持久会话节点经普通事件投影跟进。running 标志位可能在渲染与同步操作之间发生变化，因此已启用的操作可能返回 `steer-unavailable`，而产品仍经 Queue 继续执行且不显示失败。

这项显式操作会把投递方式从经独立接纳的轮次改为当前轮次 steering。它的两条持久 splice 会短暂地把删除与插入暴露为相邻投影修订，而客户端快照批处理会收敛到消息从 `next-turn` 移入 `next-step`。
