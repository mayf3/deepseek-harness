# Agent Note: Delivered reminders are framed as scheduled messages from the user

Status: implemented

English | [中文](2026-09-24-scheduled-message-framing.zh.md)

## Problem

Due reminders reach their original Session as user-role messages with producer kind `schedule`. Both renderers opened that message with a standing instruction about the standing of its payload: one-shot delivery asked the model to present `reminder_prompt_json` as untrusted reminder content and not as new user instructions, and recurring batch delivery asked the same for every `reminder_prompt` in `reminders_json`. The message therefore carried a trust verdict about its own content instead of naming where it came from.

## Decision

`renderReminderFraming` and `renderRecurringReminderBatchFraming` in [`packages/schedule/schedule/src/domain.ts`](../../../../packages/schedule/schedule/src/domain.ts) both open with one shared fixed line, `SCHEDULED_MESSAGE_FRAMING`: `This is a scheduled message from the user`. The bracketed marker (`[SCHEDULE REMINDER]`, `[SCHEDULE REMINDER BATCH]`) and the JSON-encoded dynamic fields are unchanged, so a one-shot message still appends `schedule_id_json`, `occurrence_at`, and `reminder_prompt_json`, and a recurring batch still appends `reminders_json`.

The fixed line states the origin of the message: a schedule owned by that Session. It does not claim the user typed the prompt text, which `schedule_create` and `schedule_update` let the model write on the user's behalf in that Session. The line no longer states what standing the model should give the reminder prompt inside it. Framing-line forgery stays closed by encoding rather than by instruction: the schedule id and prompt are JSON strings, the occurrence instant is a validated canonical RFC 3339 value, and each occupies one line, so a prompt carrying embedded newlines or an `occurrence_at:`-style line cannot add framing lines to the block. The [Host-owned scheduled messages](2026-09-16-host-schedule-storage.md) note keeps the rest of its decision, including delivery through the Session controller and the saved delivery records.

## Alternatives considered

**Keep the untrusted-content instruction.** It asserted a trust verdict the delivered message does not need: the delivery is an ordinary user-role message in the Session that owns the schedule, and the Session binding check that scopes `schedule_create` and `schedule_update` is the part that constrains who can write the prompt.

**Change only the recurring batch line.** One-shot and recurring delivery would then disagree about the origin of the same kind of message, and each later wording change would need both renderers edited separately. Both paths now read one constant.

## Consequences

Model-visible reminder text changes for both delivery paths, so a Session log recorded before this decision reconstructs the previous framing. Nothing else moves: no session event, storage field, client surface, or durable format changes, and the delivered text remains reconstructable from the log.

A future delivery path whose prompt text originates outside the target Session would need its own framing decision. This note covers the current same-Session prompt sources, which are the model tools and the Web task detail.
