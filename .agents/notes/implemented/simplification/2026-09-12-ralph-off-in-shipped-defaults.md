# Agent Note: Ship ralph off in the default compositions

Status: implemented

English | [中文](2026-09-12-ralph-off-in-shipped-defaults.zh.md)

## Problem

The `ralph` tool runs a fixed foreground loop of fresh, unseeded child agents and returns when a worker reports completion or a concrete blocker. Its own model-facing description restricts it to runs the direct human explicitly asked for, and its README records that completion is a worker self-declaration with no independent evaluator and that the loop has no background collection, resume checkpoint, or scheduler.

That tool shipped enabled in `packages/bundle/base/cordis.patch.yml` and in three of the four shipped agent presets. A default session therefore carried a tool whose own description told the model not to reach for it, and the default profile's catalog advertised a capability the Harness does not yet stand behind.

## Decision

`packages/bundle/base/cordis.patch.yml` declares its `tool-ralph` row `disabled: true`, and the `standard`, `ptc`, and `cordis` presets declare their own `tool-ralph` rows the same way. The `minimal` preset carries no such row. The package, its tool contract, and its tests remain: this changes which default compositions mount the row, not whether the capability exists.

The `ptc` preset also declares `workflow-worker-thread` disabled. That preset kept the engine for `ralph` alone after it dropped the general `workflow` tool, so disabling `ralph` left the engine with no consumer in that composition.

Each disabled row carries its restore recipe in a local comment. An overlay row re-enables the capability for a base-backed profile from `$DSH_HOME/cordis.patch.yml` or a `--patch` file. Preset files take no patches (`packages/preset/agent-presets/README.md`), so a Web session that wants `ralph` duplicates the preset into `$DSH_HOME/.agent-presets` and drops `disabled`; in `ptc` that means the tool row and the engine row together, because `tool-ralph` injects `ctx.workflowEngine`.

`packages/bundle/web-app/cordis.patch.yml` keeps its own `tool-ralph` disable even though `base` now ships the row off. `validatePresetPlaneSeparation` in `scripts/verify-cordis-config.ts` collects declared row ids without regard to `disabled`, so deleting that row would return `tool-ralph` to the Web host plane and collide with the same id in every preset.

`snapshots/session/ralph-loop` becomes the owner of a `ralph` composition whose `cordis.yml` and `cordis.snapshot.yml` re-enable the row, so the one recorded scenario that exercises the tool keeps its evidence. A sibling composition does not inherit `text-turn/cordis.snapshot.yml`, so the new replay patch restates those swaps alongside the `ralph` row.

## Alternatives considered

**Add a fifth shipped preset for the demoted surface.** The preset roster offers a real per-session choice, but a shipped preset is discovered and offered to every user the moment it exists, so it cannot express "off by default". The preset layer also has no patch semantics, so a new preset is a full copy of `standard` that drifts from it silently.

**Delete the row instead of disabling it.** The [shared base default file editor](2026-09-05-base-default-file-editor.md) decision removed `str_replace_editor` from the base selection rather than shipping it off, and it states the outcome unambiguously. A deleted row is also unreachable for a user-owned composition, because a patch can only flip `disabled` on a row that already exists.

**Demote in the Web presets only.** The default Web session is the surface under discussion, and this is the smallest diff. It leaves headless, sdk, acp, and custom base-backed profiles shipping a tool the default Web surface rejects, which is the near-copy drift `verify-cordis-config` names as the normal failure.

**Demote the goal tools alongside `ralph`.** Both surfaces defer independent evaluation, so the bar reads the same. Goal tools are the supported long-running path — the `ralph` description points ordinary long-running work at them — and they carry a product surface, so demoting both would leave no supported way to run long work.

**Keep `workflow-worker-thread` enabled in `ptc`.** A user who removes `disabled` from `tool-ralph` in a duplicated `ptc` preset would then need one edit instead of two. It retains a provider with no consumer in the shipped composition, which `packages/AGENTS.md` rejects; the restated comment names the dependency instead.

**Document the opt-in recipe in `docs/`.** A guide page would reach users who never open a composition file. The recipes differ by plane and are three lines each, so the row comments carry them at the point of use.

## Consequences

A default Web, headless, sdk, acp, or custom base-backed session no longer offers `ralph`, and neither do the `standard`, `ptc`, and `cordis` presets. To restore it a user edits a composition, so the capability is opt-in rather than merely discouraged. Existing sessions that already logged `ralph` calls still replay and render: the tool package is installed and its event types are unchanged.

`ptc` mode loses the engine as well. A duplicated `ptc` preset that restores `tool-ralph` without restoring `workflow-worker-thread` leaves the tool row with an unresolved injection, which is why both rows carry the dependency in their comments.

## Verification

`packages/preset/agent-presets/tests/shipped-root.spec.ts` pins that every preset carrying `tool-ralph` disables it, that `ptc` disables `workflow-worker-thread`, and that `standard` and `cordis` keep the engine enabled for their `workflow` tool. `apps/cli/tests/web-agent-presets.e2e.ts` and `apps/web/tests/shipped-composition.e2e.ts` pin the exact default and PTC tool catalogs, so a row that stops contributing is a test failure rather than a silently shorter list. `scripts/verify-cordis-config.ts` continues to pass its plane-separation check against the disabled rows.

Every affected recorded-session sidecar was refreshed with `pnpm run test:snapshot:refresh`, and `pnpm run test:snapshot` replays the corpus. `snapshots/session/ralph-loop` passes under its own composition patch, which is the evidence that the demotion removed the row from the defaults without removing coverage of the tool.
