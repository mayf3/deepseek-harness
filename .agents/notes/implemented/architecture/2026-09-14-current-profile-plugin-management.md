# Agent Note: Current-profile plugin management shares CLI transactions

Status: implemented

English | [中文](2026-09-14-current-profile-plugin-management.zh.md)

## Problem

Web and agent controls need to change a running profile without creating an independent package installer or overwriting user-authored YAML. A file watcher can otherwise load the intermediate manifest written during package installation, or report success before removed plugins finish releasing resources.

## Decision

[Plugin Manager](../../../../packages/boot/plugin-manager/README.md) and `dsh plugin` call the same asynchronous package operations. The launcher supplies `ctx.profileContext` as data: profile and resolution locations, startup bundles and invocation overlays. Shared functions compose the current files; this interface contains no callbacks or mutation methods. CLI and service mutations hold the profile manifest's writer lock; [DSH HMR](../../../../packages/boot/hmr/README.md) serializes module replacement, Include refresh, profile recomposition and service mutations through one queue. HMR registers the profile watches and `hmr/before-reload` file-lock wrapper during its own initialization, then waits for application readiness before processing edits. The final YAML composition controls whether HMR runs; the launcher installs no fallback. Package mutations take that same file lock inside `hmr.runExclusive()`. Each generation re-reads the manifest, bundle layers and user patches while retaining invocation overlay precedence.

Configuration watches use Chokidar write stabilization by default. Its ordinary change handler discards a second event within 50 ms, so a write immediately after activation can leave the previous bundle running. Stabilized delivery observes the final file instead; file-driven updates pay the stability delay, while direct manager transactions do not. A regression feeds consecutive changes through Chokidar’s real normalization and verifies both applied states.

Profile files remain the persisted state: entry toggles edit only `disabled` in the YAML document, and bundle toggles edit the ordered string list. Dependency updates do not reactivate retained disabled bundles. A service removal first applies the composition without the bundle and waits for old fibers to finish before deleting the dependency. Saved configuration, pnpm completion and runtime activation have separate outcomes; failure preserves the actual partial state and a diagnostic path.

This extends the [profile bundle composition decision](2026-08-05-profile-plugin-bundles.md). Profiles without HMR keep their process composition, and Desktop package management remains shell-owned. Web controls and explicitly enabled agent tools call the same service, whose batched durable notices inform live Agents without waking them. The agent tool is disabled by default in the base bundle and shipped presets. The browser-only worker preview has no host package installer; its module-proxy table refuses `execa` calls explicitly while retaining the management module for inventory discovery.

CLI calls inherit the terminal and authentication environment; service calls retain the subprocess credential scrub and bounded diagnostics. Management records carry error codes and parameters for locale-owned Web presentation. Reconciliation compares entry identity, fiber identity, configuration and diagnostics before and after updating: unchanged inactive entries remain warnings, while newly affected failures reject the operation. Explicit enablement targets must activate.

## Alternatives considered

**Spawning another dsh process from the service.** This duplicates lifecycle coordination and cannot establish that the current Loader finished unloading before pnpm removes files. Sharing the operation module retains one implementation while letting each caller own its presentation.

**Restoring existing packages after failure.** Package versions, dependency trees and install-script effects cannot be reconstructed reliably from the previous manifest. Failed installation permits one removal attempt for an unambiguously identified new dependency. Existing dependencies and successful installations whose activation fails remain in place. Invalid leftover packages stay visible and removable.

**Source-module hot replacement for package updates.** Configuration changes can reuse the loaded module cache, whereas replacing installed JavaScript needs a new process generation. Replacing an existing dependency reports a required restart.

## Consequences

The same profile can be managed through CLI, Web and tools, with file-level coordination and preserved patch precedence. Operators must repair failed package operations using the reported files and diagnostics. A startup process must stop before its loaded packages can be removed through CLI. Management components remain protected against service-initiated removal.
