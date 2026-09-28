# Agent Note: Schedule as an opt-in optional bundle

Status: implemented

English | [中文](2026-09-24-schedule-opt-in-optional-bundle.zh.md)

> Supersedes [Schedule in the shipped Web composition](../../archived/architecture/2026-09-24-web-default-schedule-composition.md): the Web composition now carries no Schedule row, and this bundle inserts the `schedule` and `ui-schedule` rows it ships.

## Problem

The Host Schedule service and its client surface add four tool schemas to the live root Agents of the `standard`, `cordis`, and `ptc` presets and an Automation tasks page to the product surface, so the shipped Web composition must not mount them by default. A person using the shipped Web profile still needs a product-surface switch to turn them on; a profile patch layer or a `--patch` overlay is a configuration file that person cannot reach.

## Decision

`packages/bundle/web-app/cordis.patch.yml` carries no `time-context`, `schedule`, or `ui-schedule` row, so the shipped Web composition mounts no Schedule service and opens no Automation tasks page. The clock reading and the four reminder tools belong to the presets instead: `standard`, `cordis`, and `ptc` declare `time-context` and `@deepseek-ai/dsh-tool-schedule`, and `minimal` declares neither. Those presets' clock reading is active whether or not the bundle is enabled, and `dsh-tool-schedule` stays inert until `ctx.schedule` resolves in its own scope ([preset-scoped time context](2026-09-24-preset-scoped-time-context.md), [preset-scoped Schedule tools](2026-09-24-preset-scoped-schedule-tools.md)).

`@deepseek-ai/dsh-experimental-schedule-bundle` (`packages/experimental/schedule-bundle/`) inserts the two rows it ships, `schedule` and `ui-schedule`, in its `cordis.patch.yml`, and depends on their packages, as every other optional bundle inserts the rows it ships. It neither inserts nor mounts `time-context`. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names the package, and `apps/cli` declares it as a runtime dependency, so every installation ships it switched off. The [experimental-as-optional-bundles decision](2026-09-21-experimental-capabilities-as-optional-bundles.md) owns the `OPTIONAL_BUNDLES` conventions and the localized `icon` and `meta.title` / `meta.description` metadata the Web Plugins page renders in its Official group.

Enabling the bundle inserts `schedule` (durable reminders) and `ui-schedule` (the Session reminder catalog and the Automation tasks page), and the four reminder tools then register in the `standard`, `cordis`, and `ptc` presets that declare `@deepseek-ai/dsh-tool-schedule`; `minimal` receives neither a tool nor a clock reading. The [Schedule subsystem](../../../../docs/subsystems/schedule.md) owns the durable records, delivery, and management operations; the [Web bundle](../../../../packages/bundle/web-app/README.md) owns the composition the bundle adds the rows to. Disabling the bundle restores the shipped composition, and the Host stops scheduling while the `schedule` row is absent; stored task records remain in the Schedule domain.

## Alternatives considered

**Ship Schedule on by default.** Every live root Agent in the `standard`, `cordis`, and `ptc` presets then carries four tool schemas in each request header, and a conversation that never creates a reminder pays that cost. The arrangement also left the capability without an off switch on the product surface.

**Keep a `--patch` overlay file.** An overlay is a launch-time argument rather than a product-surface switch, so a person using the shipped Web profile cannot reach it. Re-declaring the rows through its `insert` list does not override them: `applyEntryPatches` appends that list without de-duplicating ids, and the Loader collapses the composed list to one entry per id with the last declaration winning, so the overlay replaces the Web bundle's rows instead of setting fields on them.

**Keep the rows in the Web composition with `disabled: true` and switch them on with id-targeted patches.** The bundle would then set fields on existing rows, but the plugin manager lists only the rows a bundle inserts, so the bundle's page reported no components and needed a second listing path for overridden rows, while every other optional bundle inserts its rows. A profile that also declares one of the ids resolves the same way as for any other bundle: the Loader keeps the last declaration.

**Lock the two rows to the bundle switch.** A bundle manifest field that makes the plugin manager refuse to switch the rows one by one adds a plugin-manager concept only this bundle would use. The bundle's page offers a switch per row, as for every other bundle, and the bundle README records that the two rows work only together.

## Consequences

- A default `dsh web` session mounts no Schedule service: its live root Agents carry no `schedule_*` tool schema, no Session reminder catalog appears, and no Automation tasks page opens. The `standard`, `cordis`, and `ptc` presets keep appending their per-step clock reading. An installation that wants the service enables the optional bundle from the Plugins page or lists the package in a profile's `dsh.profile.bundles`.
- An enabled installation adds four tool schemas to the live root Agents of the `standard`, `cordis`, and `ptc` presets, and `minimal` receives none of them. The clock reading is model-visible and durable, so it replays, compacts, and appears in exported Session logs like any other user message.
- The Plugins page lists the `schedule` and `ui-schedule` rows under the bundle with the titles their packages' `locale/*.json` declare, their state, and, while the bundle is on, a switch per row; switching one of them off leaves Schedule without that part.
- A profile patch or `--patch` overlay that targets the `schedule` or `ui-schedule` id matches no row while the bundle is not selected, and the loader warns `patch: entry <id> not found` for it; selecting the bundle replaces switching those rows on by id.
- The switch is configuration-only: `src/index.ts` is an empty module, the patch carries the runtime content, and the package owns no mutable runtime state, so it publishes no invariant companion.
