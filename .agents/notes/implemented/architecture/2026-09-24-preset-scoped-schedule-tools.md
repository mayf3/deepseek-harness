# Agent Note: Preset-scoped Schedule tools

Status: implemented

English | [中文](2026-09-24-preset-scoped-schedule-tools.zh.md)

## Problem

`@deepseek-ai/dsh-schedule` registered `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` itself, attaching them to every live root Agent from an `agent/created` listener whose only filter was membership in `ctx.agents.roots()`. That predicate says nothing about the Agent preset, so `minimal` — composed for a capability-poor agent — carried all four schemas and paid their fixed request-context token cost. Storage, delivery, and the preset mechanism were each correct; the availability decision sat in the package that owns the storage service.

## Decision

`@deepseek-ai/dsh-tool-schedule` (`packages/schedule/tool-schedule`) contributes the four tools as a preset-level Consumer. It declares `inject = ['tools']` and registers the definitions on `ctx.tools` from inside `ctx.inject(['schedule'], …)`, so the mounting scope is the one that owns them and the registration waits for the Host Schedule service in that same scope. The shipped Web profile mounts the row in its `standard`, `cordis`, and `ptc` presets and omits it from `minimal`. Cordis effect ownership disposes the definitions with the mount, and a composition that never resolves `schedule` registers none of them. [The opt-in Schedule bundle](2026-09-24-schedule-opt-in-optional-bundle.md) owns which Host rows and client surfaces the `web` profile mounts; this record owns the reminder tools' preset placement.

`@deepseek-ai/dsh-schedule` keeps the version-1 storage domain, the Host timer and serialized queue, Host delivery through the Session controller, the Automation page's backing reads, and the `ctx.schedule` interface. `dsh-tool-schedule` is the model-facing consumer of that interface: it checks selector and identity constraints before the service call, reads `exec.agent` for the Session binding, and maps failures that are not `ScheduleInputError` to `internal_error` so storage details never reach the model.

## Alternatives considered

**Keep registration in the Host service behind a `Config` flag.** An `exposeTools` field would move a composition choice into the storage plugin, where no preset can state it, and every preset would still need an edit to change the outcome.

**Register the tools whenever `ctx.schedule` is present.** The optional bundle switches the `schedule` Host row on for the whole deployment, `minimal` included, so that condition restores the coupling between storage and model surface that this decision removes.

## Consequences

- `minimal` request headers and tool lists carry no reminder tool schema.
- Each preset that mounts the row pays the four schemas' fixed token cost, and tool availability is read from the composition instead of inferred from the Host service's presence.
- A deployment can mount `dsh-schedule` for storage and delivery without granting its agents model-driven reminder management.
- `dsh-schedule` injects no `ctx.tools` and registers no model-facing tool.
- A preset mount reaches that preset's subagents: an in-process child joins its parent's preset standing mount through `composeFrom`, so `standard`, `cordis`, and `ptc` children see the four tools as well.
- A Session whose live Agent subagent routing owns can never receive a delivered reminder, so `ScheduleService.create` and `ScheduleService.update` reject it with `subagent_session`; the rule sits in the service, so other consumers reach it too — the Automation surface included.

## Testing

`packages/schedule/tool-schedule/tests/tool-schedule.spec.ts` pins the four definitions and their error mapping. `apps/cli/tests/web-agent-presets.e2e.ts` asserts the `minimal` preset's tool list, and `snapshots/web/minimal-preset/tool-schemas.expected.json` records its bash-only tool table.
