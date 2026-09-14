# Agent Note: Native entry diagnostics

Status: implemented

English | [中文](2026-09-11-native-entry-diagnostics.zh.md)

## Problem

Third-party plugin failures must leave the application’s management endpoints available without declaring a broken required composition ready. Native Loader groups retain successful siblings after a row fails. A separate group implementation would duplicate that behavior, while checking package exports during discovery would execute third-party code before the user mounted it. Requested options can also differ from a still-active fiber’s validated config after an update fails.

## Decision

**Startup strictness remains consumer-owned.** App-boot uses the [global required entry ids](2026-09-09-consumer-owned-startup-strictness.md) and the bootstrap Include identity. Package origin does not change the audit: all other rows may fail with a warning. Bundle metadata has no trust or stage policy. Row ownership only attributes diagnostics and management operations; nested Includes inherit their owning entry’s package without matching unrelated root ids.

**Bundle enablement selects a whole patch layer.** Native rows and author-written groups retain their explicit ids and parents. Anonymous bundle rows receive deterministic ids on detached execution copies. Disabling a bundle removes its inserts and overrides across every target group; persistent user row overrides survive re-enablement. Ownership is checked before loading: bundle layers claim ids in their listed order, collisions omit the whole losing bundle, and conflicting user inserts are omitted per row. Prefixing explicit ids would break author expressions and user patches; relying on authors to avoid collisions permits silent Loader reparenting.

**Diagnostics describe attempts and running instances separately.** `Entry.lastFailure` passively retains import, activation or update errors where the Loader already catches or propagates them. It does not restore transactions or change native continuation. Asynchronous activation failures come from `fiber.await()`, pending dependencies from injection state, and disabled-expression failures from evaluating the effective gate. An active old fiber can coexist with an update failure. Removed entries need no separate failure registry. Nested continuation failures remain advisory; readiness does not promise every nested plugin callback succeeded.

**Recomposition is serialized and nontransactional.** The launcher provides `ProfileRuntime` before startup auditing. Preparation rejects malformed files before mutation. Accepted updates settle current Loader work and await removed fibers before publishing composition facts and returning issues. Old fiber references are necessary because removed entries are absent from Loader task enumeration. Successful sibling changes remain applied after another entry fails. Fresh patch copies prevent a later override from mutating data reused by another composition. `ProfileRuntime` declares Loader as a required injection so both root and plugin-context handles can reconcile and inspect the tree.

**Metadata discovery does not execute installed code.** `readPackageMetadata` reads package identity and bundle patch rows. A bundle’s metadata describes its declared composition; packages without a bundle patch remain installed and unknown. Physical Cordis peer resolution is advisory and cannot detect an inlined copy. Config validation and execution diagnostics belong to actual mounted rows.

**Unhandled process failures stay fatal.** `installFailLoud` remains until shutdown. Only duplicate rejections already observed by an entry audit are coalesced through its process checkpoint. Unrelated detached rejections retain master’s teardown-and-exit policy. No in-process group protects against `process.exit`, a blocked event loop, native crashes or OOM. Preset generation owners retain their own strict mount-and-cleanup behavior.

**Public helpers serve launcher and management operations.** Composition, conflict checks, diagnostics and package management expose their inputs and results. Per-row diagnostic helpers and intermediate bundle analysis stay package-private so callers depend on operation results rather than analysis steps. Ownership analysis returns row owners and conflicts without retaining unused per-bundle results.

## Alternatives considered

**Wrap every bundle in a synthetic parent group.** Native entries retain both successful siblings and failed rows. A wrapper adds another entry identity, while whole-bundle enablement already follows the selected patch layers. Preserving author-written ids keeps their expressions and user patches valid.

**Import inside the Host with try/catch.** Rejected because discovery could execute irreversible side effects, exit the Host or block its event loop. Catching exceptions cannot restore that isolation. Parsing source to infer plugin exports would add another JavaScript interpreter with incomplete results.

**Select startup strictness from package origin.** Rejected because installation source does not establish whether an application endpoint can work. The consumer-owned required-id list already captures that requirement, including providers whose failure leaves a required consumer pending.

**Recover by rolling back every live update or ignoring all post-boot rejections.** Neither can establish a safe restored state after plugin effects run. Per-row outcomes and retained user choices are observable; process-level detached failures cannot be attributed reliably to a row and remain fatal.

## Consequences

Installed metadata, enabled layer selection and current runtime health are independent. An enabled bundle may be partially running, pending or failed; updating a row may leave old behavior active with a visible diagnostic. Whole-bundle disable removes its patch effects without requiring a synthetic parent group. Startup can still fail when an optional provider leaves a required consumer pending.

## Verification

`packages/boot/app-boot/tests/entry-issues.spec.ts` covers required-id policy, import/config/apply/disabled/pending failures, nested-entry and anonymous-row bundle ownership, active old config after failed updates, recovery, and awaited removed-fiber teardown. Composition tests cover duplicate ownership and unchanged parents. Static metadata tests use an import-time file-writing fixture and assert no execution, retain unknown packages, and ignore unrelated manifest fields. Inventory tests verify actual Loader failures and composition conflicts without a historical failure registry. Process-guard and user-patch tests retain fatal detached failures and best-effort live reload diagnostics.
