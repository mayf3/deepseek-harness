# Agent Note: 投递的提醒以「用户安排的定时消息」为固定文本

Status: implemented

[English](2026-09-24-scheduled-message-framing.md) | 中文

## Problem

到期的提醒以生产者 kind 为 `schedule` 的 user-role 消息进入其原 Session。两个渲染器都用一句关于其载荷地位的固定指令开篇：单次投递要求模型把 `reminder_prompt_json` 作为不可信的提醒内容呈现、而不是新的用户指令；周期批次投递对 `reminders_json` 中的每个 `reminder_prompt` 提出同样的要求。于是这条消息对自身内容附带了一个信任判定，而没有说明它来自哪里。

## Decision

[`packages/schedule/schedule/src/domain.ts`](../../../../packages/schedule/schedule/src/domain.ts) 中的 `renderReminderFraming` 与 `renderRecurringReminderBatchFraming` 都以同一条固定行开篇，即模块常量 `SCHEDULED_MESSAGE_FRAMING`：`This is a scheduled message from the user`。方括号标记（`[SCHEDULE REMINDER]`、`[SCHEDULE REMINDER BATCH]`）与 JSON 编码的动态字段不变：单次消息仍追加 `schedule_id_json`、`occurrence_at`、`reminder_prompt_json`，周期批次仍追加 `reminders_json`。

这条固定行说明消息的来源，不再说明模型应给其中的提醒提示词何种地位。伪造固定行的通道仍由编码而非指令封闭：每个动态字段都是单独一行上的一个 JSON 字符串，因此带有换行或形如 `occurrence_at:` 的提示词无法向该块增加固定行。[Host 拥有的定时消息](2026-09-16-host-schedule-storage.zh.md) 记下的其余决策不变，包括通过 Session controller 投递以及保存的投递记录。

## Alternatives considered

**保留「不可信内容」指令。** 它对投递的消息断言了一个并不需要的信任判定：提醒提示词写在该 Session 之内——由模型通过 `schedule_create` 与 `schedule_update` 写入，或由用户在 Web 任务详情中写入——而投递本身是该 Session 中的普通 user-role 消息。约束提示词写入者的是限定这些工具范围的 Session 绑定校验。

**只改周期批次那一行。** 单次与周期投递会对同类消息的来源给出不同说法，此后每次改措辞都要分别改两个渲染器。现在两条路径读同一个常量。

## Consequences

两个投递路径的模型可见提醒文本都改变，因此在该决策之前记录的 Session 日志重建出的是旧的固定文本。其余不动：没有 session 事件、存储字段、客户端界面或持久化格式变化，投递文本仍可从日志重建。

未来若出现提示词文本来自目标 Session 之外的投递路径，它需要单独决定自己的固定文本。本记录覆盖当前同一 Session 内的提示词来源，即模型工具与 Web 任务详情。
