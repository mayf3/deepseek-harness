# Agent Note: Schedule as an opt-in optional bundle

Status: implemented

English | [中文](2026-09-24-schedule-opt-in-optional-bundle.zh.md)

## Problem

The shipped Web composition mounted `time-context`, `schedule`, and `ui-schedule`, so every Web session carried four Schedule tool schemas and one durable clock message per eligible step whether or not the deployment wanted reminders, and the capability had no switch on the product surface.

## Decision

`packages/bundle/web-app/cordis.patch.yml` carries none of `time-context`, `schedule`, and `ui-schedule`, so the shipped Web composition mounts none of the three.

`@deepseek-ai/dsh-experimental-schedule-bundle` (`packages/experimental/schedule-bundle/`) inserts the three rows in its `cordis.patch.yml` and depends on their packages, as every other optional bundle inserts the rows it ships. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names the package, and `apps/cli` declares it as a runtime dependency, so every installation ships it switched off. The [experimental-as-optional-bundles decision](2026-09-21-experimental-capabilities-as-optional-bundles.md) owns the `OPTIONAL_BUNDLES` conventions and the localized `icon` and `meta.title` / `meta.description` metadata the Web Plugins page renders in its Official group.

The bundle's manifest sets `dsh.bundle.rowSwitches: false`. The plugin manager's `listBundles` reports it as `rowSwitches`, and the Plugins page then lists the three rows with their state and offers no switch per row: the Host rows and the client row work only together, so the bundle's own switch is their only control. A bundle that omits the field keeps a switch per row.

Enabling the bundle inserts `time-context` (a per-step clock reading with the sampled instant, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message), `schedule` (durable reminders plus `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` on live root Agents), and `ui-schedule` (the Session reminder catalog and the Automation tasks page). The [Schedule subsystem](../../../../docs/subsystems/schedule.md) owns the durable records, delivery, and management operations; the [Web bundle](../../../../packages/bundle/web-app/README.md) owns the composition the bundle adds the rows to. Disabling the bundle restores the shipped composition, and the Host stops scheduling while the `schedule` row is absent; stored task records remain in the Schedule domain.

## Alternatives considered

**Ship Schedule on by default.** Every Web session then pays four tool schemas in each request header and one durable user message per eligible step, and a conversation that never creates a reminder pays both costs. The arrangement also left the capability without an off switch on the product surface.

**Keep the rows in the Web composition with `disabled: true` and switch them on with id-targeted patches.** Selecting the bundle could not insert a row a second time, but the plugin manager lists only the rows a bundle inserts, so the bundle's page reported no components and needed a second listing path for overridden rows, while every other optional bundle inserts its rows. A profile that inserts one of the rows itself mounts it twice once it selects any bundle that inserts the same row, so the override form removed that case only for this bundle.

**Offer a switch per row, as other bundles do.** Switching `schedule` off while `ui-schedule` stays on leaves the task page without its service, and switching `time-context` off leaves reminders the model cannot place in time; the three rows are one capability.

**Hide row switches for every optional bundle in the Official group.** That removes per-row control from the other optional bundles as well; the manifest field keeps the choice with each bundle's author.

## Consequences

- A default `dsh web` session carries no Schedule tool schemas, no Session reminder catalog, no Automation tasks page, and no per-step clock reading. An installation that wants them enables the optional bundle from the Plugins page or lists the package in a profile's `dsh.profile.bundles`.
- An enabled installation adds four tool schemas to every live root Agent and one durable clock message per eligible step; the reading is model-visible and durable, so it replays, compacts, and appears in exported Session logs like any other user message.
- The Plugins page lists the three rows under the bundle with the titles their packages' `locale/*.json` declare and their state, and no row switches.
- A profile that inserts one of the three rows itself mounts that plugin twice when it selects the bundle, because profile patches append inserted rows without merging them by id.
- The switch is configuration-only: `src/index.ts` is an empty module, the patch carries the runtime content, and the package owns no mutable runtime state, so it publishes no invariant companion.
