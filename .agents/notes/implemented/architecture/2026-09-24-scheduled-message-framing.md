# Agent Note: Delivered reminders are framed as scheduled messages from the user

Status: implemented

English | [中文](2026-09-24-scheduled-message-framing.zh.md)

## Problem

Due reminders reach their original Session as user-role messages with producer kind `schedule`. Both renderers opened that message with an instruction about how to treat its payload: one-shot delivery asked the model to present `reminder_prompt_json` as untrusted reminder content and not as new user instructions, and recurring batch delivery asked the same for every `reminder_prompt` in `reminders_json`. The message therefore asserted that its own content was untrusted instead of naming where it came from.

## Decision

`renderReminderFraming` and `renderRecurringReminderBatchFraming` in [`packages/schedule/schedule/src/domain.ts`](../../../../packages/schedule/schedule/src/domain.ts) both open with one shared fixed line, `SCHEDULED_MESSAGE_FRAMING`: `This is a scheduled message from the user`. The bracketed marker (`[SCHEDULE REMINDER]`, `[SCHEDULE REMINDER BATCH]`) and the dynamic field lines are unchanged: a one-shot message still appends `schedule_id_json`, `occurrence_at`, and `reminder_prompt_json`, and a recurring batch still appends `reminders_json`.

The fixed line states the origin of the message: a schedule bound to that Session. It does not claim the user typed the prompt text, which `schedule_create` and `schedule_update` let the model write on the user's behalf in that Session. The line carries no instruction about the standing of the prompt text. Framing-line forgery is closed by encoding: the schedule id and prompt are JSON strings, the occurrence instant is a validated canonical RFC 3339 value, and each occupies one line, so a prompt carrying embedded newlines or an `occurrence_at:`-style line cannot add framing lines to the block. The [Host-owned scheduled messages](2026-09-16-host-schedule-storage.md) note keeps the rest of its decision, including delivery through the Session controller and the saved delivery records.

## Alternatives considered

**Keep the untrusted-content instruction.** It asserted that the prompt was untrusted input, which the delivered message does not need: the prompt is written in the Session the schedule is bound to — by the model through `schedule_create` and `schedule_update`, or by the user in the Web task detail — and the delivery is an ordinary user-role message there.

**Change only the recurring batch line.** One-shot and recurring delivery would then disagree about the origin of the same kind of message, and each later wording change would need both renderers edited separately. Both paths now read one constant.

## Consequences

Model-visible reminder text changes for both delivery paths, so a Session log recorded before this decision reconstructs the previous framing, and the Web notice that renders a delivered message shows the new line when expanded. Nothing else moves: no session event, storage field, client code, protocol, or durable format changes, and the delivered text remains reconstructable from the log.

The prompt text carries no authorship guarantee. It is written in the Session the schedule is bound to, by the model through `schedule_create` and `schedule_update` or by the user in the Web task detail, and a model-written reminder can quote text the model read from the web, files, or command output. The task's Session binding scopes which Session's model reaches the task; it is not caller authorization and says nothing about where the prompt content came from. A delivery path whose prompt text can originate outside the target Session, or a decision to mark such content again, needs its own framing decision.
