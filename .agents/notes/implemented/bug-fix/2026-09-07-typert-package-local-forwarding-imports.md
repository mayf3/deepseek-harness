# Agent Note: Follow package-local forwarding modules in Typert references

Status: implemented

English | [中文](2026-09-07-typert-package-local-forwarding-imports.zh.md)

## Problem

`WorkspaceAnalyzer` resolves every type reference to its original declaration before classifying it, then reads only the referencing file's own `import` statement to decide whether the reference crossed a package through a public export. A package that re-exports another package's type from one of its own modules, and imports that module by relative path elsewhere, therefore fails with `crosses a package without an explicit package import` although the package import exists one hop away. The failure is deterministic for every batch size and package order; it surfaces in whichever analysis selects the referencing package as a root, which is why [issue 3525](https://github.com/deepseek-harness/deepseek-harness/issues/3525) observed it as batch-dependent.

## Decision

[`targetForReference`](../../../../packages/typert/generator/src/analyzer.ts) resolves a relative specifier with the program's module resolution and follows it only while the resolved file stays inside the referencing package. In each forwarding module it locates the `export` edge that carries the requested name: a named re-export with a specifier, a star re-export whose module exports the same symbol, or an `export { local }` backed by that module's `import`. The walk stops at the first package specifier and feeds that identity and export name to the existing `packageExportName` check, so a forwarded type must still be public at the package subpath the forwarding module names. The reference model is unchanged: the target remains `declaration` for a same-face owner and `cross-face` for another face.

The walk yields no package import, and the reference fails as before, when a relative specifier resolves outside the referencing package, when a forwarding module re-exports a namespace, or when a forwarding chain revisits a file.

## Alternatives considered

**Treat a relative import whose alias chain ends in another package as implicitly public.** Rejected: it would accept `../../other/src/file.ts` and any forwarding module that itself reaches the other package by relative path, removing the public-export check the generated Remote declarations rely on to name an importable subpath.

**Record the forwarding module as the reference target.** Rejected: emitters and cross-face links need the original declaration's package and public subpath; a package-local module has no public identity of its own.

**Make batched and whole-workspace analysis select the same roots.** Rejected as a fix: root selection does not change the verdict on a reference, only whether the reference is visited, so aligning the callers would hide the incorrect classification rather than remove it.

## Consequences

Packages may keep one forwarding module for foreign types and import it relatively, matching how their own modules are organized. Each cross-package relative reference costs one module resolution per hop, cached by the shared compiler host. [`type-model.spec.ts`](../../../../packages/typert/generator/tests/type-model.spec.ts) pins named, renamed multi-hop, import-then-export, star, and namespace-import forwarding, a forwarded private export, a forwarding module that crosses by relative path, cross-face forwarding, and equality of whole and batched analysis for the forwarding fixture across batch sizes and package orders.
