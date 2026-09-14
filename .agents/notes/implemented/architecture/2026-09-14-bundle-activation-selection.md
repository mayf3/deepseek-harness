# Agent Note: Bundle activation selection

Status: implemented

English | [中文](2026-09-14-bundle-activation-selection.zh.md)

## Problem

An installed package can remain unused as a bundle, either because the user has never enabled it or because they turned it off. Dependency reconciliation must preserve that choice when another package is installed or an existing package gains a bundle patch.

## Decision

**The ordered bundle list owns activation intent.** `dependencies` records installed packages; `dsh.profile.bundles` selects whole patch layers. An installed bundle absent from the list is not enabled. Enable and disable operations only add or remove its name in that list. Runtime diagnostics still describe whether the selected rows actually activated.

**Reconciliation preserves existing selections.** Only dependencies added by the current operation are candidates for its automatic-enable option. Existing dependencies stay out until explicitly enabled, including a package whose update first declares `dsh.bundle`. Removed or bundle-less dependencies leave the enabled list. Template layers are retained independently of profile dependencies.

## Alternatives considered

**Keep a separate disabled list to veto automatic activation.** This distinguishes never-enabled packages from explicitly disabled ones, but the management UI treats both as off. Scanning every installed dependency for activation makes unrelated package operations change that choice. Preserving the enabled list avoids a second persistent selection and its cleanup rules.

## Consequences

Bundle updates cannot implicitly opt an existing package into the application. A package that gains a bundle patch needs an explicit enable operation. The manifest does not retain whether an unused bundle was previously enabled; that history has no current consumer. Ordinary library dependencies are not treated as disabled bundles.

## Verification

`external-bundles.spec.ts` covers disabled and never-enabled packages during another installation, package updates that add a bundle patch, explicit re-enablement, dependency removal and template-layer preservation. The built CLI regression exercises reconciliation through a forwarded pnpm command with locally materialized package versions.
