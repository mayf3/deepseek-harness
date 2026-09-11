# Agent Note: Native entry diagnostics and static plugin declarations

Status: implemented

English | [中文](2026-09-11-native-entry-diagnostics-and-static-plugin-declarations.zh.md)

## Problem

Third-party plugin failures must leave the application’s management endpoints available without declaring a broken required composition ready. Native Loader groups retain successful siblings after a row fails. A separate group implementation would duplicate that behavior, while checking package exports during discovery would execute third-party code before the user mounted it. Requested options can also differ from a still-active fiber’s validated config after an update fails.

## Decision

**Startup strictness belongs to row provenance.** Only rows introduced by an external runtime bundle are optional. Built-in, boot-staged, unowned rows and the bootstrap Include are required. Profile stage overrides author stage, which defaults to runtime; first-party declarations and template provenance determine trust. Stage changes failure policy, not execution timing. A config override retains the target row’s owner. Nested Includes inherit their owning entry’s provenance; their local ids are never resolved against unrelated root rows.

**Bundle enablement selects a whole patch layer.** Native rows and author-written groups retain their explicit ids and parents. Anonymous bundle rows receive deterministic ids on detached execution copies. Disabling a bundle removes its inserts and overrides across every target group; persistent user row overrides survive re-enablement. Ownership is checked before loading: strict layers claim ids first, optional collisions omit the whole losing bundle, and conflicting user inserts are omitted per row. Prefixing explicit ids would break author expressions and user patches; relying on authors to avoid collisions permits silent Loader reparenting.

**Diagnostics describe attempts and running instances separately.** `Entry.lastFailure` passively retains import, activation or update errors where the Loader already catches or propagates them. It does not restore transactions or change native continuation. Asynchronous activation failures come from `fiber.await()`, pending dependencies from injection state, and disabled-expression failures from evaluating the effective gate. An active old fiber can coexist with an update failure. Removed entries need no separate failure registry. Nested continuation failures remain advisory; readiness does not promise every nested plugin callback succeeded.

**Recomposition is serialized and nontransactional.** The launcher provides `ProfileRuntime` before startup auditing. Preparation rejects malformed files before mutation. Accepted updates settle current Loader work and await removed fibers before publishing composition facts and returning issues. Old fiber references are necessary because removed entries are absent from Loader task enumeration. Successful sibling changes remain applied after another entry fails. Fresh patch copies prevent a later override from mutating data reused by another composition.

**Discovery reads declarations without executing modules.** `readPackageMetadata` reads package identity, bundle patches and explicit `dsh.plugins` entries. `.` names the main export; subpaths and default configs remain available for composition editors. Undeclared packages remain installed and unknown. A declaration does not certify importability, Config validity or activation. Physical Cordis peer resolution is advisory and cannot detect an inlined copy. Runtime validation belongs to each actual mounted row, including separate mounts of one module in different presets.

**Unhandled process failures stay fatal.** `installFailLoud` remains until shutdown. Only duplicate rejections already observed by an entry audit are coalesced through its process checkpoint. Unrelated detached rejections retain master’s teardown-and-exit policy. No in-process group protects against `process.exit`, a blocked event loop, native crashes or OOM. Preset generation owners retain their own strict mount-and-cleanup behavior.

## Alternatives considered

**Keep contained groups and child probes.** Contained groups protected against transactional Loader rollback and supplied failure records for removed rows. Native entries retain both siblings and failed rows, so wrapping adds identities without supplying bundle-wide enablement that layer composition lacks. Child probes bounded discovery-time execution and discovered undeclared exports and schemas. Static declarations avoid that execution; automatic main-export detection and pre-mount schemas are given up. A future execution sandbox needs its own process ownership and teardown design, not a discovery probe presented as runtime isolation.

**Import inside the Host with try/catch.** Rejected because discovery could execute irreversible side effects, exit the Host or block its event loop. Catching exceptions cannot restore that isolation. Parsing source to infer plugin exports would add another JavaScript interpreter with incomplete results.

**Use a global list of required plugin ids.** Rejected because ids do not describe provenance, external boot providers, custom profiles or nested Include trees. Existing profile trust and stage declarations already own those distinctions.

**Recover by rolling back every live update or ignoring all post-boot rejections.** Neither can establish a safe restored state after plugin effects run. Per-row outcomes and retained user choices are observable; process-level detached failures cannot be attributed reliably to a row and remain fatal.

## Consequences

Installed metadata, enabled layer selection and current runtime health are independent. An enabled bundle may be partially running, pending or failed; updating a row may leave old behavior active with a visible diagnostic. Whole-bundle disable removes its patch effects without requiring a synthetic parent group. Startup can still fail when an optional provider leaves a required consumer pending. Old probe records are not activation evidence, and plugins need explicit `dsh.plugins` declarations for discovery as addable modules.

## Verification

`packages/boot/app-boot/tests/entry-issues.spec.ts` covers trust and stage, import/config/apply/disabled/pending failures, nested and anonymous provenance, active old config after failed updates, recovery, and awaited removed-fiber teardown. Composition tests cover duplicate ownership and unchanged parents. Static metadata tests use an import-time file-writing fixture and assert no execution, retain unknown packages, and reject malformed declarations. Inventory tests verify actual Loader failures and composition conflicts without a historical failure registry. Process-guard and user-patch tests retain fatal detached failures and best-effort live reload diagnostics.
