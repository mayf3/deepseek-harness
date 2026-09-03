# Agent Note: 用户独占的 goal 暂停并暴露实时激活态

Status: implemented

[English](2026-09-03-user-owned-goal-pause-activation.md) | 中文

## 问题

[宿主发起的 goal 暂停中止当前轮次](2026-09-01-host-goal-pause-aborts-turn.zh.md) 修复了当前模型轮次不停止的问题，但之后的人类轮次仍可通过 `update_goal resume` 解除持久的 `paused` goal。Web 条带也只读取持久的 `goal` 投影，因此 active-but-disarmed 的 goal 与 armed 的 goal 渲染相同，并提供相同的暂停动作。

## 决策

`ctx.goals.get` 现在是一个只读 Remote 方法。`GoalService` 在进程本地 activation 变化时发出 `goal/activation-changed`，载荷为 `{ sessionId, goal: { id, revision, activation } }`，clear 后则不携带 goal。API Remote 允许列表把这份 JSON 载荷转发给 Web 客户端。

GoalBar 通过 `ctx.remote.goals.get` 播种进程本地 activation，应用 `goal/activation-changed`，并在持久 revision 或会话 running 状态变化时重新读取。Active goal 仅在 armed 时渲染 `Ongoing Goal`；active-but-disarmed goal 渲染 `Inactive Goal`，暴露 resume 而不是 pause；持久 paused goal 继续暴露 resume。暂停权威仍属于 goal 领域和人类 `/goal resume` 命令，它们仍可恢复每个可恢复 phase。

`update_goal resume` 会在调用 goal 服务前用 `GOAL_TOOL_RESUME_PAUSED` 拒绝持久 paused goal。它仍会在会话恢复或 fork 后恢复 active-but-disarmed goal，并在人类要求继续时恢复 blocked goal。模型提示词和工具描述说明持久 paused 的恢复由用户独占。

## 考虑过的替代方案

**把 activation 存入持久 `GoalSnapshot`。** 否决：按 goal 领域约定，activation 是进程本地的，绝不能跨恢复或 fork 存活。

**把 activation 加入持久 session projection。** 否决：投影状态会写入检查点；缓存的 `armed` 会在武装它的进程消失后继续错误存在。

**把完整的 scoped `goal/changed` 事件转发给客户端。** 否决：其 `Agent` 载荷不是 JSON wire 数据。专用 activation 事件只携带客户端需要的 session id、goal ref 与 activation。

**允许模型从自然语言轮次恢复持久 paused goal。** 否决：人工暂停是用户控制，仅靠提示词约束仍会把同轮撤销能力留给模型。

## 后果

Web 无需持久化 activation 就能区分运行中、disarmed 与 paused goal。持久 paused goal 只能通过 Web 控件、`/goal resume` 或其他直接调用 goal 服务的调用方恢复；模型 `update_goal resume` 仅限 disarmed-active 与 blocked goal。API 表面新增一个读取和一个转发 live 事件；持久 goal change 载荷与投影 stateVersion 不变。人类取消现在也需要面向用户的恢复路径。

## 测试

Goal 单元测试固定 create、session start 与 resume 过程中的 activation 事件。工具测试固定后续人类轮次中持久 paused goal 的拒绝，同时保留已恢复 disarmed-active goal 的恢复。API Remote 测试固定 JSON 转发。Web 单元测试固定 armed 显示 pause、disarmed 显示 resume 与事件应用；组装的 goal-bar 浏览器场景仍固定 armed golden。完整构建的 Host typecheck 与 client typecheck 通过。
