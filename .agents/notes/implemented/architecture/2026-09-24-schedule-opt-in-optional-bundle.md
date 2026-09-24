# Agent Note: Schedule as an opt-in optional bundle

Status: implemented

English | [中文](2026-09-24-schedule-opt-in-optional-bundle.zh.md)

## Problem

The shipped Web composition mounted `time-context`, `schedule`, and `ui-schedule`, so every Web session carried four Schedule tool schemas and one durable clock message per eligible step whether or not the deployment wanted reminders. The rows had no switch on the product surface: a deployment that wanted them off edited its own profile patch layer, and the `--patch apps/cli/config/examples/schedule/cordis.yml` overlay could only switch them on from a launch flag.

## Decision

`packages/bundle/web-app/cordis.patch.yml` inserts `time-context`, `schedule`, and `ui-schedule` with `disabled: true`, so the shipped Web composition mounts none of the three. The rows stay in the composition because an id-targeted patch overrides an existing row: a profile patch or a bundle sets a row's `disabled` to `false` without inserting it again.

`@deepseek-ai/dsh-experimental-schedule-bundle` (`packages/experimental/schedule-bundle/`) carries three id-targeted patches in its `cordis.patch.yml`, one per row, each setting `disabled: false`; it inserts no row. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names the package, and `apps/cli` declares it as a runtime dependency, so every installation ships it switched off. The [experimental-as-optional-bundles decision](2026-09-21-experimental-capabilities-as-optional-bundles.md) owns the `OPTIONAL_BUNDLES` conventions and the localized `icon` and `meta.title` / `meta.description` metadata the Web Plugins page renders in its Official group.

Enabling the bundle turns on `time-context` (a per-step clock reading with the sampled instant, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message), `schedule` (durable reminders plus `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` on live root Agents), and `ui-schedule` (the Session reminder catalog and the Automation tasks page). The [Schedule subsystem](../../../../docs/subsystems/schedule.md) owns the durable records, delivery, and management operations; the [Web bundle](../../../../packages/bundle/web-app/README.md) owns the composition that carries the disabled rows. Disabling the bundle restores the shipped composition, and the Host stops scheduling while the `schedule` row stays disabled; stored task records remain in the Schedule domain.

## Alternatives considered

**Ship Schedule on by default.** Every Web session then pays four tool schemas in each request header and one durable user message per eligible step, and a conversation that never creates a reminder pays both costs. The arrangement also left the capability without an off switch on the product surface.

**Keep a `--patch` overlay file.** An overlay is a launch-time argument rather than a product-surface switch, so a person using the shipped Web profile cannot reach it. It cannot re-insert the rows either: `applyEntryPatches` appends an `insert` list without de-duplicating ids, so an overlay that inserts `time-context` and `schedule` mounts each Host plugin a second time.

**Extract the three rows out of the Web composition into the bundle.** The bundle would insert the rows instead of overriding them, so any profile that also inserts a row would mount the same Host plugin twice for the same reason. The disabled rows are what an override-style switch targets.

## Consequences

- A default `dsh web` session carries no Schedule tool schemas, no Session reminder catalog, no Automation tasks page, and no per-step clock reading. An installation that wants them enables the optional bundle from the Plugins page or lists the package in a profile's `dsh.profile.bundles`.
- An enabled installation adds four tool schemas to every live root Agent and one durable clock message per eligible step; the reading is model-visible and durable, so it replays, compacts, and appears in exported Session logs like any other user message.
- The bundle changes nothing in a composition that does not carry the three Web rows, and its package declares no plugin dependency, so enabling it cannot mount a Host service twice.
- The switch is configuration-only: `src/index.ts` is an empty module, the patch carries the runtime content, and the package owns no mutable runtime state, so it publishes no invariant companion.
