# Agent Note: A settings namespace resolves per scope

Status: implemented

English | [中文](2026-09-04-settings-namespaces-resolve-per-scope.zh.md)

## Problem

The settings seam registered a namespace once per process. That fit host rows, which exist once, and broke for agent presets, which mount the same plugin under several standing scopes: the second preset's `ctx.settings.register` threw "already registered" inside a `ctx.inject` continuation, the throw vanished into a nested fiber, and the second preset read the first's value. A person who wanted `skill-filesystem` to scan one extra root for the `research` preset only had no place to say so — the document had one section per namespace, and the plugin manager's per-preset configuration story needed one.

## Decision

**`dsh-scope` names scopes.** `createScope(ctx, key, { id })` records a stable name on the key, and `scopeIdOf(ctx)` answers the nearest named scope along a context's parent chain, so an agent's context resolves to the preset it joined. `dsh-agent-presets` names its standing scopes `preset/<id>`. Settings depends on `dsh-scope` alone and never on presets.

**A namespace is a kind; a registration is an instance under a scope.** `register` reads the caller's scope through `scopeIdOf(this.ctx)` — the traceable service proxy binds `this.ctx` to the caller — and files the instance under it, the global scope being the absence of a name. Every registrant of a kind must carry the same schema envelope (`schema.toJSON()` compared with the seam's equality); a different one fails loud, as does a second instance under one scope. The first registrant's `validate` and `applies` are the kind's.

**Four layers.** An instance resolves schema defaults, its own composition `base`, the document's global section, and its scope's section (`scopes.<id>.<ns>`) in that order, with the existing field-level merge. A global write re-resolves every instance of the kind, each gated on its own resolved value, so a scope that overrides the changed field is not disturbed; a scoped write commits that instance alone. Revisions are per section, kept off the registrations so a section written for a scope nothing has registered yet — a preset no session composed — is versioned like any other; such a write is accepted when the kind exists and is judged by the shared schema. `scopes` is a reserved namespace.

**Describe per scope.** `describe()` answers one descriptor per kind under the global scope; `describe({ scope })` one per kind under a named scope, with `registered`, the scope's own `user` section, and `inherited` — the value without that section — so a surface can mark a field as overridden, inherited, or default. A scope no owner registered resolves over the global instance's composition base, because a schema may require what only a composition supplies, and a description never throws: layers the schema refuses describe as the layers beneath them, down to an empty section. The controller's `describe(scope?)` and its three write verbs take the same optional trailing `scope`, and both events carry the scope as a trailing argument that is absent for the global instance, which keeps every existing listener and the forwarded-event carrier unchanged.

**`skill-filesystem` is the first consumer.** Its `customSkillDirs` resolves through `installSection` with the composition value as base; a change replaces the provider's roots and invalidates the catalog, so a person adds a root for one preset from the settings document while the process runs.

## Alternatives considered

**A per-preset settings document.** Rejected: the document is one file with one provider; a second file per preset would need its own watcher, lock, and reload path for the same format.

**Keying instances by the preset id inside the settings seam.** Rejected: settings would then know presets; a named scope is the general form, and a future named scope — a workspace, a team — costs nothing.

**One registration per kind with the scope passed on every read.** Rejected: a plugin reads its handle without knowing it runs in a preset; the instance's context already says where it is.

## Consequences

Two presets mounting one plugin keep separate values, and the silent collision is gone. A settings surface can offer "all presets" and "this preset" over one namespace. The global `describe()` still answers one row per kind, so the existing settings page renders unchanged while the plugin manager's page (next PR) reads per scope. A kind's `validate` judges every instance, and a scope-only instance appears in the global view as `registered: false`.

## Testing

`packages/settings/settings/tests/scopes.spec.ts` pins registration under a named and an inherited scope, kind-level schema agreement, duplicate and reserved refusals, scoped resolution, global-write fan-out with deep-equal gating, scoped writes through the handle and the provider, per-section revisions and conflicts, writes to an unregistered scope, external scope edits, malformed scope sections, and the scoped and global describers with redaction. `packages/settings/settings-file/tests/scopes.spec.ts` pins the `scopes.<id>.<ns>` layout in YAML and JSON with comments intact. `packages/api/settings-controller/tests/settings-controller.host.spec.ts` pins the scoped Remote reads and writes; `packages/core/scope/tests/scope.spec.ts` the named-scope resolution; `packages/preset/agent-presets/tests/overlay.spec.ts` the preset scope name; `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` the live root change through settings.
