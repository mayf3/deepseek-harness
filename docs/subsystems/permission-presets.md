# Permission Presets

English | [中文](permission-presets.zh.md)

The permission-preset layer of [dsh-permission-presets](../../packages/interaction/permission-presets) (`ctx.permissionPresets`, `PermissionPresetService`) bundles the two independent enforcement knobs — [sandbox mode](sandbox.md) (`sandbox/mode`) and [approval policy](approval.md) (`approval/policy`) — into named presets a client offers as one Permissions selector. The configured table owns future-session defaults, while an effect-scoped integration may contribute a current-session-only preset with a synchronous admission check. The layer is optional and owns no execution policy: prompt narration and replay keep reading their knob folds, while a contribution such as [Auto review](../../packages/interaction/auto-review/README.md) owns any extra enforcement. The [package README](../../packages/interaction/permission-presets/README.md) owns composition status and limitations; the [sandbox switching design](../../.agents/notes/implemented/feature/2026-07-06-sandbox.md) owns the original knob rationale.

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)

## The preset table

A preset maps one stable key to a sandbox/approval bundle plus optional client presentation. The default configured table ships `workspace-write` (`workspace-write` + `ask`) and `danger-full-access` (`danger-full-access` + `never`); `custom` and `auto` are reserved and cannot be configured.

```ts type-equiv
/** One preset's sandbox/approval bundle and optional client presentation. */
interface PresetSpec {
  /** The `sandbox/mode` value the preset writes through. */
  sandbox: SandboxMode
  /** The `approval/policy` value the preset writes through. */
  approval: ApprovalPolicy
  /** The display label a client shows for this preset; the raw table key when omitted. */
  name?: string
  /** One user-facing sentence on what the preset means; omitted when not configured. */
  description?: string
}
```

```ts type-equiv
/** The {@link PermissionPresetService} config: preset table and composition default. */
interface Config {
  /**
   * The preset table: name → knob bundle. Defaults to `workspace-write`
   * (workspace-write + ask) and `danger-full-access` (danger-full-access +
   * never). The names `custom` and `auto` are reserved for derived state and
   * the Auto review integration respectively.
   */
  presets?: Record<string, PresetSpec>
  /**
   * Default for new sessions. When omitted, the preset matching the composed
   * sandbox and approval defaults is used.
   */
  defaultPreset?: string
}
```

The service requires a confining `ctx.shell` executor and `ctx.approval`, and misconfiguration fails at plugin load: configured entries named `custom` or `auto` throw, and composing over a bash executor that does not confine (no `sandboxMode` capability fact) throws because presets bundle a sandbox mode.

## Current-session contributions

An integration registers one contribution for its effect lifetime. Contributions appear after configured presets in registration order, never enter the `permission.defaultPreset` settings schema, and disappear when the effect is disposed. The synchronous `admit` callback runs before a selection mutates the Session. The reserved Auto identity additionally requires its live contribution and admission before a stored Auto Session can publish, so a missing or closing integration does not rewrite the durable identity.

```ts type-equiv
/** One effect-scoped current-session preset supplied by an integration. */
interface PermissionPresetContribution {
  /** Canonical preset name recorded in `permission/preset`. */
  readonly name: string
  /** Sandbox and approval values written by the normal preset path. */
  readonly spec: PresetSpec
  /**
   * Synchronously admit one live selection. The reserved Auto contribution is
   * also called before a stored Auto session publishes. Throwing leaves the
   * session unchanged or vetoes Auto publication.
   * @param session - session selecting this contribution or restoring Auto.
   */
  readonly admit: (session: Session) => void
}
```

## Current preset and the derived `custom`

`current(session)` derives the effective preset from the required `permissions` projection. The unit folds the session's sandbox mode, approval policy, and recorded selection; values absent within that state fall back to the executor's configured mode and the approval service config, then `ask`. A missing projection key fails explicitly. The service prefers a still-matching selection, then the first matching configured entry, then the first matching live contribution, and otherwise returns `CUSTOM_PRESET` (`'custom'`). `custom` is derived-only: clients may display it as the current value, but it is never a switch target or an event payload.

`names` lists configured presets in declaration order followed by live contributions in registration order. `optionOf(name)` builds the option a client renders for an available key (label falls back to the key) or for `custom`, and throws for any other name.

```ts type-equiv
/** The select-option shape a presentation layer advertises for one preset (or for the derived `custom` state). */
interface PresetOption {
  /** Stable option value: the table key, or `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means; omitted when not configured. */
  description?: string
}
```

## Switching and the `permission/preset` event

`set(session, name)` resolves the preset (unknown names throw), runs a contribution's admission callback when applicable, appends a log-only `permission/preset` event unless `name` is already the effective preset, then writes each knob through its own setter — `setSandboxMode` from [dsh-sandbox-policy](../../packages/sandbox/sandbox-policy) and `setApprovalPolicy` from [dsh-user-approval](../../packages/interaction/user-approval) — only when that knob's effective value changes. The selection event precedes the knob events in the same turn, and re-selecting the effective preset appends nothing.

`permission/preset` is durable, log-only user intent: it stays out of the model transcript (the knob events own the model-visible consequences through their consumers), and it exists so `current()` can preserve which preset the user chose when two presets share a bundle. The `permissions` projection folds that selection with both knob events and retains the `session/end-seed` boundary used to distinguish a restored empty seed from a fresh session; replay needs no catch-up state or raw-log rescan. A restored `auto` selection requires the Auto contribution before Agent publication. The complete event declaration is in the [persistence log event catalog](../persistence-catalog.md); the method signatures are in the generated [service catalog](#ctxpermissionpresets--permissionpresetservice).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpermissionpresets--permissionpresetservice"></a>

### `ctx.permissionPresets` — `PermissionPresetService`

Owns the deployment's configured and contributed permission presets and their write path. Requires a confining `ctx.shell` executor and `ctx.approval`; unmatched knob values are reported as CUSTOM_PRESET, not an error.

```ts cordis-catalog
/**
 * Register one current-session-only preset for the calling integration's
 * effect lifetime.
 * @param contribution - preset identity, knob bundle, and synchronous admission gate.
 * @returns the async effect disposer that removes exactly this contribution.
 */
register(contribution: PermissionPresetContribution): () => Promise<void>

/**
 * Resolve the preset matching the effective knob values. A still-matching
 * last selection wins shared-bundle ties; otherwise the first configured
 * match, then the first contributed match, wins. Returns
 * {@link CUSTOM_PRESET} when no available preset matches.
 * @param session - the session whose knob state is read.
 * @returns the effective preset name, or `custom` when nothing matches.
 */
current(session: Session): string

/**
 * Build the whole select value for one folded knob state: configured options
 * in declaration order, live contributions in registration order, and
 * `custom` appended exactly while derived.
 * @param state - the folded knob overrides.
 * @returns the `permissions` projection payload.
 */
selectFor(state: KnobState): PermissionSelect

/**
 * Resolve an available preset's knob bundle.
 * @param name - the preset name to resolve.
 * @returns the configured bundle.
 * @throws when `name` is neither configured nor currently contributed.
 */
resolve(name: string): PresetSpec

/**
 * Build the client option for an available preset or {@link CUSTOM_PRESET}.
 * A missing label falls back to the preset key.
 * @param name - a configured or contributed preset key, or `custom`.
 * @returns the option a client renders.
 * @throws when `name` is neither a table key nor `custom`.
 */
optionOf(name: string): PresetOption

/**
 * Record a changed preset, then update each changed knob through its own
 * setter. Selecting the effective preset again appends nothing.
 * @param session - the session the switch belongs to.
 * @param name - the preset to switch to; unknown names throw.
 */
set(session: Session, name: string): void
```

Types: [Session](session.md)

Source: [`packages/interaction/permission-presets/src/index.ts`](../../packages/interaction/permission-presets/src/index.ts)
<!-- END GENERATED cordis-surface -->
