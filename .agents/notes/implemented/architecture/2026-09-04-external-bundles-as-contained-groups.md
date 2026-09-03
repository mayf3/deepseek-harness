# Agent Note: External bundles mount as contained, prefixed groups

Status: implemented

English | [中文](2026-09-04-external-bundles-as-contained-groups.zh.md)

## Problem

A bundle installed with `dsh plugin add` mounted its rows exactly like the installation's own: appended to the root entry list, under the ids its patch declared, inside the one Loader transaction that builds the tree. Three consequences followed from the vendored Loader's shape. `EntryGroup.update` is all-or-nothing — one rejected row rolls the group back and rethrows — so a community plugin that no longer compiled against the current harness stopped every `dsh` surface from starting, and the diagnostic named the row, not the bundle. Entry ids are unique per tree (`tree.store`), and a `create()` that finds an existing id moves that entry under the new group and replaces its options, so two bundles that both inserted `id: hello` made the second silently take over the first. Nothing recorded which layer had inserted a row, so the plugin list could not tell a built-in row from an installed one, nor a row the user disabled from one the composition gated.

## Decision

**Every external bundle is one group.** The profile launcher classifies each layer by provenance: a bundle that is a pnpm dependency of the profile is `external`, a template bundle or one the profile lists under `dsh.profile.firstParty` is `builtin`. `composeExternalLayer` renders a `runtime`-stage external layer as one `cordis:contained-group` entry, `bundle/<package>`, holding the bundle's inserted rows with their ids prefixed `<package>/<id>`; inserts into a built-in group nest their own contained group inside the target, and the bundle's id-targeted patches are rewritten to the prefixed ids when they address its own rows and passed through when they address built-in rows. `/` rather than `:` because `:` is the Loader's nested-id separator.

**The contained group isolates row failures.** `ContainedGroup extends Group` overrides `create()`, the one per-row step the transactional `update()` awaits: a rejected row is recorded on the root's `pluginFailures` registry — tree-wide id, declared row id, module, group, stage parsed from the Loader's wrapper, message — and the group activates without it. `assertEntriesActivated` exempts contained rows (a failed or pending one becomes a record) and keeps the fatal path for built-in rows. One fail-safe closes the corner case where isolation would hide a broken core: a built-in row left pending while any bundle is isolated still fails the boot, and the diagnostic names the isolated bundles and the `stage: boot` escape.

**`stage: boot` is the explicit opt-out.** A bundle whose rows provide a service built-in rows inject declares `dsh.bundle.stage: boot` in its manifest, or the deployer sets `dsh.profile.stages` in the profile manifest, which wins; such a layer mounts unwrapped and unprefixed with fatal semantics. An unknown stage value fails profile loading.

**Installed and enabled are two facts.** `reconcileInstalledBundles` no longer appends every bundle-declaring dependency to `dsh.profile.bundles` unconditionally; `autoEnable` keeps the CLI's install-and-enable semantics, and `enableBundle`/`disableBundle` are the manifest operations a plugin manager calls. `dependencies` records the install, `bundles` the enabled layers.

**Provenance is a launcher service.** `ProfileRuntime` (`ctx.profileRuntime`) holds the booted profile, attributes each row to the layer that inserted it (`originOf`, prefixed ids included), reads which rows the user patch files disable with a literal `disabled: true`, and recomposes the tree through the root include — the same path the patch watchers take. The plugin inventory reads it and the failure registry to serve `trust`, `package`, `disabledBy`, and `failure` per row, listing rows the registry alone knows.

## Alternatives considered

**Add an `optional` field to `EntryOptions` and teach the vendored `EntryGroup.update` to skip it.** Precise, but a vendored divergence to log and re-apply on every sync, a new metadata field for `verify-cordis-config` to admit, and it would still not give a bundle an identity in the tree. Rejected: the Loader's own `builtins` seat already lets the launcher substitute the group class, and one group per bundle is the identity every later feature — a package-level switch, per-package failure reporting — needs.

**A second boot phase for external bundles, mounted by a runtime plugin after the built-in tree is up.** Cleanest isolation and no composition rewriting, but every bundle that provides a built-in seam service would need an explicit escape anyway, sessions could start before the second phase landed, and the browser roster would need recomputation. Rejected as the larger change for the same outcome; the contained group keeps one boot transaction.

**Keep ids unprefixed and rely on authors choosing unique ids.** Rejected because the failure mode is silent takeover, not an error.

## Consequences

A community bundle that breaks on a harness upgrade no longer stops `dsh`; the plugin list shows the failed row with its stage and message, and the process keeps serving. Two bundles may declare the same row id. A user patch that targets an external bundle's row must name the prefixed id, and `--dump-config` shows the group; a `!!js` disabled expression that compared `e.options.id` to the bundle's own unprefixed id no longer matches — comparing `e.options.name` is the documented form. A bundle's override of a built-in row stays outside isolation, because it edits that row in place. The nested-fiber audit that would catch a failed `ctx.inject()` continuation under a built-in entry ships as advisory lines; making it fatal waits on a pass over shipped compositions.

## Testing

`packages/boot/app-boot/tests/external-bundles.spec.ts` pins the composition (grouping, prefixing, patch rewriting, nested inserts, no mutation of the layer's patches) and the manifest operations. `tests/contained-group.spec.ts` boots real trees: a failing contained row is recorded while its siblings and the built-in rows run, a pending contained row is recorded, a built-in failure still rejects, a built-in row left pending beside an isolated bundle rejects and names it, and a contained row that fails on a later reload is recorded by the audit. `tests/profile.spec.ts` pins trust and stage resolution including the deployer override and the unknown-stage rejection; `tests/profile-runtime.spec.ts` pins provenance and recomposition; `packages/host/plugin-inventory/tests/inventory.spec.ts` pins the new row fields.
