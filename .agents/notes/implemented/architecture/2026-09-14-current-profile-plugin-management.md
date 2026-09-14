# Agent Note: Current-profile plugin management shares CLI transactions

Status: implemented

English | [中文](2026-09-14-current-profile-plugin-management.zh.md)

## Problem

Web and agent controls need to change a running profile without creating an independent package installer or overwriting user-authored YAML. A file watcher can otherwise load the intermediate manifest written during package installation, or report success before removed plugins finish releasing resources.

## Decision

[Plugin Manager](../../../../packages/boot/plugin-manager/README.md) and `dsh plugin` call the same asynchronous package operations. The launcher supplies the current profile and resolution locations. CLI and service mutations hold the profile manifest's writer lock; [DSH HMR](../../../../packages/boot/hmr/README.md) serializes module replacement, Include refresh, profile recomposition and service mutations through one queue. The launcher registers the `hmr/before-reload` file-lock wrapper before plugin startup. Package mutations take that same file lock inside `hmr.runExclusive()`. Each generation re-reads the manifest, bundle layers and user patches while retaining invocation overlay precedence.

Profile files remain the persisted state: entry toggles edit only `disabled` in the YAML document, and bundle toggles edit the ordered string list. Dependency updates do not reactivate retained disabled bundles. A service removal first applies the composition without the bundle and waits for old fibers to finish before deleting the dependency. Saved configuration, pnpm completion and runtime activation have separate outcomes; failure preserves the actual partial state and a diagnostic path.

This extends the [profile bundle composition decision](2026-08-05-profile-plugin-bundles.md). Startup profiles keep their process composition, and Desktop package management remains shell-owned. Web controls and agent tools call the same service, whose batched durable notices inform live Agents without waking them.

[Client HMR](../../../../packages/client/hmr/README.md) applies Host module-graph changes to the connected browser: removed entries drain their effect disposers before cached factories and styles are removed; added entries load through the existing Client module system. Plugin-owned aggregate interfaces follow their declared client entry, so disabling an internal Host child does not imply removing part of an aggregate client.

## Alternatives considered

**Spawning another dsh process from the service.** This duplicates lifecycle coordination and cannot establish that the current Loader finished unloading before pnpm removes files. Sharing the operation module retains one implementation while letting each caller own its presentation.

**A second desired-state database or automatic rollback.** These require synchronizing package-manager side effects with another state store. Profile files remain inspectable and repairable; partial installation and loading failures are reported rather than concealed by an incomplete rollback.

**Source-module hot replacement for package updates.** Configuration changes can reuse the loaded module cache, whereas replacing installed JavaScript needs a new process generation. Replacing an existing dependency reports a required restart.

## Consequences

The same profile can be managed through CLI, Web and tools, with file-level coordination and preserved patch precedence. Operators must repair failed package operations using the reported files and diagnostics. A startup process must stop before its loaded packages can be removed through CLI. Management components remain protected against service-initiated removal.
