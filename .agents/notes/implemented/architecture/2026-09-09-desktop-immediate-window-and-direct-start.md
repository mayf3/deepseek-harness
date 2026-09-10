# Agent Note: Show the Desktop window before starting the Host

Status: implemented

English | [中文](2026-09-09-desktop-immediate-window-and-direct-start.zh.md)

Profile staging, directory-swap recovery, and automatic rollback described here are superseded by the [in-place profile decision](2026-09-09-desktop-in-place-profile.md). Other decisions remain active.

## Problem

Waiting for backend readiness leaves users without a window during profile preparation and module loading. A complete staged health-check process repeats backend startup before the application starts its serving process, while plugin startup can still fail in the serving process.

## Decision

Electron creates the main window with a local loading page before profile reconciliation or Host startup. The page depends only on packaged shell assets and receives starting, ready, or error state through the owned preload. Readiness loads the product UI in that window; an actual startup failure displays its diagnostic, retry, and plugin-management actions there. Closing during loading cancels further startup work and waits for the pending child to exit.

The main window owns recovery because the failed Host cannot supply its own controls. Every error page retains diagnostics and exposes restart, disable-third-party-plugins, and reset-Desktop actions, plus reinstallation guidance. The actions remain available regardless of error classification. Reset removes all profile contents except its held lock, without a backup; shared product data and the Harness-home environment file remain intact. The lock lives inside the profile, and reset preserves its directory so another transaction cannot acquire a replacement lock during cleanup. Disabled third-party package files cannot block startup when no third-party bundles are enabled. Self-contained shell recovery controls use intercepted form navigation so a failed preload cannot disable them.

Profile activation starts the actual Host after journaled directory replacement. Desktop does not boot and stop a separate health-check backend. Dependency metadata and graph validation, reviewed lifecycle builds, runtime identity checks, transaction locking, and profile rollback remain in place. A failed actual startup can restore the previous profile; rollback cannot undo plugin side effects or durable Session writes.

This partially supersedes staged backend probes and waiting to create the main window in the [packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md) and [bundled-runtime decision](2026-09-08-desktop-bundled-runtime-and-external-plugins.md). Those notes retain release, signing, transport, resource ownership, and dependency-transaction rationale. Full runtime file verification remains a packaging operation.

## Alternatives considered

**Keep a complete staged health check.** It can reject a startup failure before replacing the active profile, but executes plugin initialization twice and cannot guarantee that the subsequent serving process will start. The actual startup result and journaled rollback provide recovery without the extra probe.

**Keep the main window hidden until readiness.** This avoids presenting a loading page but gives users no visible progress or interaction while the backend loads. A shell-owned page can remain available when Host startup fails.

## Consequences

Users can see startup progress and recover from failures before the product UI is available. A responsive window does not imply that the backend is ready, and startup latency still requires installed-artifact measurement. Activation can fail after profile replacement; the journal retains recovery for profile files.

Verification covers a delayed Host with a visible loading page, one serving startup for a fresh profile, failure and retry in the same window, plugin management during recovery, and closing while a child is starting. Installed GUI evidence complements lifecycle and transaction tests.
