# Agent Note: Fail-loud is boot-scoped, and packages are probed in a child process

Status: implemented

English | [中文](2026-09-04-boot-scoped-fail-loud-and-package-probe.zh.md)

## Problem

`installFailLoud` registered a process-wide `unhandledRejection` handler that wrote `fatal load failure` and exited, and the launcher discarded the uninstaller it returned, so the handler lived for the whole process. That is right during startup, where an unhandled rejection is a load failure nobody else will report. After boot it meant that any plugin's stray continuation — one rejected promise a community bundle forgot to await — took every session down with it, and no `uncaughtException` handler existed at all, so a synchronous throw in a timer callback crashed the process with Node's default trace and no origin. Mounting third-party code at runtime, which the plugin manager exists to do, was a bet on the process with these two defaults in place.

Separately, nothing could say what an installed package was without importing it into the host: whether it declared a bundle layer or exported a plugin, which rows its patch would insert, whether it resolved `@deepseek-ai/cordis` to the harness's copy or to one of its own — the actual shape of a "dependency conflict" under the profile's hoisted linker with `autoInstallPeers: false` — and what `Config` schema its main export carried.

## Decision

**Fail-loud ends when the tree is up.** The launcher keeps `installFailLoud`'s uninstaller and calls it once `boot()` returns, then installs `installRuntimeGuards`: an unhandled rejection after boot is reported to stderr as contained and the process keeps running; an uncaught exception is reported with its origin and the process exits, as Node would, because its state is unknown. Both handlers are removed on shutdown.

**Nested failures are reported, not yet fatal.** `warnNestedFiberFailures` walks every runtime's fibers and reports a `FAILED` fiber that belongs to a built-in entry but is not that entry's root fiber — a `ctx.inject()` continuation that threw, which the Loader stamps with the entry but the activation audit never sees. It runs after boot as advisory lines; it becomes part of the fatal audit once shipped compositions are known clean.

**The probe runs the package where it cannot hurt.** `probePackage` reads the installed package's manifest in the host — kind from `dsh.bundle`, the rows and overrides of its patch, `dsh.plugins` declarations, `engines.dsh`, title and description — and spawns one Node child that resolves `@deepseek-ai/cordis` from the package, imports the main export and every declared addable module, and reports whether each is a plugin and what `Config.toJSON()` it carries. A child that throws, exits, or hangs yields `ok: false` with the reason or a rejection naming the timeout; a package whose cordis resolves elsewhere than the harness's own is not enableable. Records are cached under the profile's `.dsh-plugins/` and invalidated by version.

## Alternatives considered

**Attribute a runtime rejection to the plugin that produced it and mark that plugin failed.** The right end state, but a promise carries no fiber, and cordis's effect wrappers cover only what plugins register through them. Deferred: the guard reports and contains now; attribution needs an async-context seam.

**Import the package in the host to learn its shape.** Rejected: import runs code with the host's privileges before the user enabled anything, and a hang or a `process.exit` in a package's module scope would be the host's.

**Keep `installFailLoud` process-wide and ask plugin authors to be careful.** Rejected: the harness cannot review the code it lets users install, and the cost of one missed `await` was every session.

## Consequences

A stray rejection from any plugin after boot is a stderr line, not an exit; a misbehaving package is diagnosed by its probe record before it is enabled. The probe adds one child process per install and per version change, with a 20-second default bound. Runtime attribution of rejections to plugins remains open, so the plugin list cannot yet mark the plugin a reported rejection came from.

## Testing

`packages/boot/app-boot/tests/contained-group.spec.ts` pins `installRuntimeGuards` on a fake process (report without exit for a rejection, exit for an exception, uninstall) and against the real process, and `warnNestedFiberFailures` on a booted tree with a throwing `ctx.inject()` continuation under a built-in entry and under a contained one. `tests/probe.spec.ts` stages packages under a temporary profile: a bundle with gated, anonymous, and nested rows and an override, a plain plugin, a library, a package that throws at import, one that carries its own cordis copy, one whose addable module is missing, a hanging child, an exiting child, an unresolvable package, and a bad Node executable; and the cache round-trip with version mismatch and a corrupt record.
