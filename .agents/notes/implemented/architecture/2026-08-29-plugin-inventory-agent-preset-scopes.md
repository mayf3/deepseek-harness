# Agent Note: The plugin inventory carries every agent preset's composition

Status: implemented

English | [中文](2026-08-29-plugin-inventory-agent-preset-scopes.zh.md)

## Problem

[Per-session agent presets](2026-08-03-per-session-agent-presets.md) moved every model-facing row onto the agent plane, and the settings plugin list kept projecting `ctx.loader.entries()` alone. The surface therefore hid the plugins sessions actually run — a directly-plugged preset subtree never appears in the Loader's entries — and actively misled about the rest: the web overlay's deliberate `disabled: true` tombstones (`tool-bash`, `tool-fs`, `plan-mode`, …) rendered as two dozen plainly "disabled" rows while the same modules ran in every standard-preset session. Beside it, General settings carried a default-preset dropdown that wrote the same `agent-presets.default` field as the roster section's own make-default action — two editors for one fact, one of them blind to the roster it was choosing from.

## Decision

**The inventory speaks for both planes.** `pluginInventory/list` gains an optional `agentPresets` block — one group per roster preset with id, display name, default marking, health, and flattened composition rows — supplied by the new `AgentPresets.compositionInventory()`: a preset with a live standing mount answers from its newest generation's Loader entries, and one never composed since boot answers from its composition file. `dsh-host-plugin-inventory` resolves the roster as an optional peer through `ctx.get('agentPresets')` (the `plugin-package-inventory-deepseek` pattern) and only maps root-fiber states onto its public phase vocabulary, so deployments without a roster keep serving Loader entries alone with the field absent.

**File answers are evaluated, not guessed, and reading never mounts.** `!!js` disabled gates are platform/environment conditions the [Loader itself evaluates at every mount decision](2026-08-11-loader-entry-disabled-interpolation.md), so the file read evaluates them against the Loader context and reports the decision a mount on this host would make; a gate the evaluator refuses stays `'conditional'` with its expression text carried for display. The read parses and evaluates only — no import, no compose — so listing every preset's plugins activates none of them, and a regression test pins `livePresetMounts()` empty after a full inventory read.

**The list is grouped by scope, with the misleading rows given their own state.** The preset group renders first behind a display-only switcher that opens on the default preset and writes no settings — inspecting `minimal` must not change what new sessions run. The global group follows collapsed, failures float first, and a global entry that is disabled while at least one preset row for the same module specifier is actually enabled folds into a "session plugins" drawer that names its providers — a third state instead of the generic "disabled" that started this. The provider rule is strict `enabled === true`: counting conditional declarations would claim per-session provision `tool-pwsh` never delivers on POSIX. Search spans both groups, forces the disclosures open, and points at matches sitting in unselected presets.

**The General row is deleted, not relocated.** The default keeps two surfaces that can still act on it — the roster section's make-default beside the visible roster, and the new-session chip for the session about to start — so `ui-agent-preset` drops the row, its menu, and the write/writability half of its settings store, which slims to the display roster the header label reads.

## Alternatives considered

**Render every preset as its own always-open section.** Four shipped presets already put ~100 rows behind the fold; the switcher keeps one composition in view while the drawer's provider list and the search pointers preserve the cross-scope answer the all-at-once layout was buying.

**Keep file-state gates unevaluated (`conditional` until first mount).** Honest but it re-created the misleading reading this change removes: on a cold host the default preset's `tool-bash` read as "conditional" and its host row fell back to plain "disabled" until the first session mounted the preset.

**A structured composition viewer in the Agent presets section.** A second home for the same rows; the section keeps its raw-YAML viewer for authors and the plugin list owns the structured view.

**Enable/disable toggles in the same change.** Writing a row's `disabled` back into a custom preset's `agent.cordis.yml` needs comment-preserving partial YAML edits, applies-to-new-sessions messaging, and a copy-then-edit path for shipped presets — deliberately its own change; this one is read-side truth.

## Consequences

Searching "bash" now answers the question that motivated the change in one screen: enabled in the standard preset, provided per session where the global plane disabled it, plainly disabled only where nothing enables it. The wire snapshot's row enablement is the union `boolean | 'conditional'` with the gate expression beside it, and the settings-chrome goldens pin the grouped layout. `ui-agent-preset` loses `AgentPresetRow` and `PresetMenu`; the `settings.agentPreset` locale namespace declaration moved to the plugin entry, and the `settings-chrome` English scenario probes locale resolution through the nav label instead of the deleted row.
