# Agent Note: Session Controller 分叉排除下一次 inbox 变更

Status: implemented

English | [中文](2026-09-11-session-controller-fork-turn-cut.md)

## Problem

用户输入会先进入持久化 inbox，再出现对应的 `turn/start`。如果已结束轮次的分叉继续复制后面的轮次间事件，就可能复制下一条输入的入队事件，却没有复制其后的出队事件。继续子会话时，就会执行选中轮次之后的输入。

## Decision

[Session Controller](../../../../packages/api/session-controller/README.zh.md) 选择已结束的 `turn/end`，复制其连续前缀及后续事件，直到第一条 `turn/start` 或 `agent/inbox/spliced` 之前，不包含该停止事件。显式锚点选择位于锚点或其后的第一条结束事件；省略锚点或锚点超出日志末尾时，选择最后一条结束事件。next-turn 和 next-step 两种 inbox 变更都会停止扩展。

这会保留第一次 inbox 变更之前的标题和模型设置事件，与[纯日志事件决策](../simplification/2026-07-28-remove-synthetic-log-only-turns.zh.md)一致。底层 `SessionStore.fork()` 保留其显式稳定事件语义。

## Alternatives considered

**严格截到选中轮次的结束事件。** 即使后面没有输入，这也会丢弃轮次结束后记录的独立标题和模型设置事件。

**复制尾部后清空子会话 inbox。** 清空操作会添加子会话事件，以取消本可从分叉种子中排除的输入。

## Consequences

异步标题或插件事件可能出现在 inbox 变更之后；分叉会将它与该尾部的其余事件一起排除。事件顺序不保证每个延迟的插件结果都会被继承。显示的源标题可用时，客户端会据此独立设置分叉标题。已经位于选中已结束轮次前缀内的事件保留通常的回放语义；本决策不重新定义在选中结束事件之前入队的待处理输入。

## Verification

控制器测试执行生产循环，检查从 A 分叉后发送 C 时，子会话历史不包含父会话后续的 B，并且只产生一次模型请求，同时保留 A 结束与 B 入队之间的标题。消息、结束事件、省略及越界锚点共用此断言。模型路由覆盖保留两种 inbox 目标变更之前的设置，并排除之后的标题和设置。Web 消息操作快照将 B 的入队事件放在已结束轮次之间，验证分叉操作创建的子会话不包含 B 或其入队事件。
