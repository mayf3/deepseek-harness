# Agent Note: Preset-scoped time context

Status: implemented

English | [中文](2026-09-24-preset-scoped-time-context.zh.md)

## Problem

`packages/bundle/web-app/cordis.patch.yml` lists `time-context` among its Host rows, and a Host row serves every preset in the profile. The `minimal` preset composes only a persona and a persistent shell: it declares no reminder tool, and no row in it turns the reading into a scheduled target, so switching that Host row on would append one user message per eligible step that nothing in the `minimal` composition consumes.

## Decision

`packages/bundle/web-app/presets/standard.patch.yml`, `ptc.patch.yml`, and `cordis.patch.yml` each declare `time-context` among their Agent-context rows; `minimal.patch.yml` does not. `packages/bundle/web-app/cordis.patch.yml` keeps the Host `time-context` row disabled beside `schedule` and `ui-schedule`, and the optional bundle switches only `schedule` and `ui-schedule` on. `packages/bundle/web-app/package.json` keeps declaring `@deepseek-ai/dsh-time-context`, which `verify-cordis-config` requires for the bare row name in a bundle patch.

The boundary this states is that an injection carrying time belongs to the preset that consumes it. A preset decides whether its Agents receive a clock reading, so the reading travels with the reminder tools that consume it; the `schedule` Host service row and the `ui-schedule` client row are preset-independent surfaces and stay in the Host roster. [The opt-in Schedule bundle](2026-09-24-schedule-opt-in-optional-bundle.md) owns which Host rows and client surfaces the `web` profile mounts; this record owns the reading's preset placement.

The plugin is unchanged: it still appends the sampled instant, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message, at the configured minimum interval.

## Alternatives considered

**Keep the row in the Host row list.** `minimal` would keep receiving a model-visible message that nothing in its composition consumes, contradicting the rule that moved the reminder tools to preset declarations ([preset-scoped Schedule tools](2026-09-24-preset-scoped-schedule-tools.md)).

**Declare the row in `minimal` too.** That would make the placement uniform across presets, but it keeps the same unused durable message in the capability-poor composition, so it pays the cost the change removes.

**Give the Schedule Host service the clock instead.** The service validates an offset-bearing `at` value or an explicit `time_zone`; it reads no browser, Session, process, or model context, and the reading reaches the model only as prompt content. The Host service row therefore does not need the injection, and moving clock sampling into storage would couple two independently owned decisions.

## Consequences

- A `minimal` session appends no time-context message, so its model receives no clock reading and must ask for any date or time the user leaves unqualified.
- `standard`, `cordis`, and `ptc` sessions keep the reading at the shipped 10-minute minimum interval, and the four reminder tools stay in the same three presets.
- The reading is model-visible and durable, so it replays, compacts, and appears in exported Session logs; `snapshots/web/minimal-preset/session.v4.jsonl` no longer records one.
- A profile patch layer cannot disable or reconfigure the row by id: `applyEntryPatches` reaches a loaded entry or a group's children, and a preset's declared plugins sit inside the preset row's `config.plugins`. Changing the row means restating that row, which is how the Web editor saves preset edits.
- A preset mount reaches that preset's subagents, so a `standard`, `cordis`, or `ptc` child receives the reading its parent receives.

## Testing

`apps/web/tests/schedule-after.e2e.ts` pins the shipped roster: `schedule` as a Host row, `time-context` in the `standard`, `ptc`, and `cordis` preset declarations and absent from `minimal`. Its every-step overlay restates `preset-standard`'s declared plugins instead of patching the row by id. `apps/cli/tests/profiles/web/tests/web-default-isolation.expected.e2e.ts` pins the Host rows by name and settled state, where `time-context` no longer appears.
