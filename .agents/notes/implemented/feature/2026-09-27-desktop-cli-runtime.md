# Agent Note: Desktop-installed CLI runtime

Status: implemented

English | [中文](2026-09-27-desktop-cli-runtime.zh.md)

## Problem

Desktop already carries the DSH command and its production dependencies, but terminal use requires a separate installation. CLI commands also own process lifetimes that can extend beyond the Desktop window, so replacing shared application files must account for those users.

## Decision

A native terminal launcher runs the private Desktop CLI entry through the installed Electron executable in Node mode. The entry delegates to the public CLI dispatcher; it preserves ordinary profiles, arguments, working directory, environment, streams, and exit status. It does not start the Desktop Host or reuse its reserved profile.

The CLI supplies bundled pnpm through the existing package-operation configuration. Its pre-mount callback uses Cordis configuration resolution to provide physical Office resources only when the Office plugin is enabled. Explicit resource settings and CLI opt-out remain authoritative. The callback adds no profile rows and rewrites no user configuration. Desktop Host startup and ASAR packaging retain their existing behavior.

## Runtime use and installation

Each command holds a shared operating-system lock on the installation's lease file. The native update controller requires the exclusive lock, so running commands reject update preparation and new commands cannot enter during it. Windows places the CLI child in a job before it starts, forwards console input, and settles its remaining process tree before releasing the lock.

Before the GUI hands off to its native updater, the controller atomically records the generation being replaced in a sibling file outside the application. That record survives GUI and controller exit and blocks only the old generation. A complete replacement carries a new generation and lease inode; no second runtime is retained. Cancellation removes only the matching transaction. An installation failure after the GUI exits requires reopening Desktop and completing the update before the old generation's CLI can run again.

The update coordinator accepts this controller as an optional installation dependency. The controller commits its handoff before the native installer starts and cancels it after declined or failed preparation. Installation identity is independent of DSH_HOME. Admission verifies that the retained lease still belongs to the current installation. Disposal waits for in-flight CLI admission, cancels an unstarted installer handoff, and prevents a late callback from starting the installer.

## Alternatives considered

**Another npm installation.** It duplicates the dependency tree and can drift from the Desktop release.

**Standalone Node and an external package tree.** Ordinary Node cannot load the existing ASAR tree. Relocating it changes Desktop packaging and thousands of filesystem entries; the requested feature preserves the existing application.

**Forward commands to the Desktop Host.** The Host owns a different profile and IPC lifecycle, and a terminal command must work while the GUI is closed.

**Process snapshots without admission locking.** A command can start after a snapshot. A GUI-owned lock alone also ends before an asynchronous native installer finishes.

**Retain old runtime versions.** It permits concurrent replacement but adds payload retention and cleanup that this installation does not need.

## Consequences

The command's runtime version follows Desktop. The [Electron runtime decision](../architecture/2026-09-11-desktop-electron-node-runtime.md) continues to own Electron/OpenSSL and third-party native-addon limitations. The [primary runtime](2026-09-14-desktop-primary-runtime.md) supplies Office's independent Node executable without adding another payload.

Native command tests exercise streams, quoting, exit status, simultaneous CLI users, preparation cancellation, and the generation handoff. Office coverage uses the real Loader and checks explicit configuration, reloads, and disposal. Packaged native and platform signing qualification remain release obligations.
