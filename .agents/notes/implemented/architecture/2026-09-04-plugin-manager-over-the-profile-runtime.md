# Agent Note: The plugin manager drives the profile runtime

Status: implemented

English | [中文](2026-09-04-plugin-manager-over-the-profile-runtime.zh.md)

## Problem

The CLI and Web need the same installation checks, while only a running application can apply bundle changes or inspect active rows. Keeping both responsibilities in the Web host would make the CLI depend on that host or duplicate its installer. Profile manifests, user patches and pnpm operations also need coordinated mutation so concurrent requests cannot overwrite each other's intent.

## Decision

**One business manager, one Remote adapter.** `dsh-plugin-manager` belongs beside app-boot. `PluginInstaller` operates on profile files and pnpm without a running Loader; `PluginManager` adds bundle and row operations over the live profile. The CLI shares the installer. `dsh-host-plugin-manager` supplies per-call readers for the profile runtime and running-agent count, relays methods, and maps `PluginOperationError` codes to Remote errors. Missing profile runtime reports `plugins/unavailable` when called. The manager reads running-agent counts without depending on the agent implementation.

**One mutation at a time.** An overlapping mutation receives `plugins/busy` rather than entering a queue with stale assumptions. Installation and removal reject with `plugins/agents-running` while an agent is running because pnpm rewrites modules those agents import. Bundle and row edits leave `node_modules` alone and do not use that guard. Every operation reads the profile manifest afresh: dependencies record installation, and `dsh.profile.bundles` records enablement.

**pnpm retains its normal launch environment.** The installer uses the standalone `subprocess-local/spawn` process owner and Windows shell handling for the `.cmd` shim. Registry credentials and proxy configuration remain available. Output streams as `plugins/install-log` under a job id, with terminal colours when requested; spawn failures, timeouts and nonzero exits report `plugins/install-failed` with a bounded log tail. A failed add restores the saved manifest and lockfile after process exit; package files and the shared download store are not restored. Static declaration and bundle-conflict checks follow installation; unknown packages remain installed, and new bundles remain disabled unless the caller requests enablement. No discovery-cache directory is owned.

**Enablement selects a layer; diagnostics describe actual rows.** Bundle enablement and nontransactional recomposition follow [native entry diagnostics](2026-09-11-native-entry-diagnostics.md). The manager keeps per-row issues distinct from the enabled choice. `retry` removes the complete layer, awaits cleanup, and adds it again; unchanged row options alone do not restart a failed plugin. `list` derives each package view from the manifest, static declarations and current Loader state.

**Rows go through the patch-file writer.** `setRowDisabled` writes or removes `disabled: true`, restoring the author's original gate when the user withdraws a denial. Global changes recompose the live tree.

**Runtime notifications follow diagnostics.** Native entry and fiber events share one pending reader. It waits for Loader and profile recomposition, then compares row identity, module, fiber phase, failure stage and message. Only a changed diagnostic set emits `plugins/changed` with reason `runtime`; healthy status churn and repeated identical failures stay silent. Management operations retain their own completion notifications. Events arriving during a read request another pass, and disposing the adapter cancels publication.

**Cancellation is a manager operation.** A caller-generated request id identifies one installation across its pnpm commands. `cancelInstall` bypasses the mutation guard to signal only that installation, then joins its cleanup and lock release. Configuration application closes the cancellation window. The separate request preserves a Host acknowledgement: aborting the add RPC alone would stop the browser waiting before file recovery completes. The installer reuses the subprocess process-group owner instead of maintaining a second termination ladder; it remains usable before any runtime starts.

## Alternatives considered

**Run pnpm through `ctx.subprocess`.** Its implicit environment scrub removes registry credentials, and it lacks the Windows shell mode this caller needs. Extending the tool subprocess service for package installation would enlarge an unrelated interface.

**Restart one failed row directly.** This bypasses whole-layer composition and does not account for the bundle's groups and overrides. Removing and adding the layer gives its Loader entries a complete lifecycle.

**Keep business operations in the Web host or app-boot entry file.** The host would become a CLI dependency; putting installation, streaming and dependency inspection in the boot entry would couple every launcher to management implementation. A separate boot-group package serves both consumers.

**Broadcast after every fiber transition.** Most transitions do not change a plugin diagnostic. Unconditional notifications make clients reread package files and rerender during unrelated work. Diagnostic comparison preserves failure discovery and recovery notifications; explicit management operations already report their own changes.

## Consequences

Live profiles support bundle and row changes without restarting. Updated module code still requires a restart because Node caches ESM modules. `dependents` reports injection relationships, not arbitrary application dependencies, and `engines.dsh` is advisory. Runtime notifications do not promise to describe every healthy configuration-file change; they report diagnostic changes, while operation notifications report management mutations.

## Testing

Manager integration tests use real profile files and a native Loader tree; CLI tests exercise the shared installer. Adapter tests cover Remote forwarding, failure changes and recovery, unchanged-diagnostic suppression, one pending read during event bursts, profile-recomposition barriers, and disposal during settlement.
