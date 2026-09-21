# Agent Note: Opt-in Windows uninstall data removal

Status: implemented

English | [中文](2026-09-18-windows-opt-in-uninstall-data.zh.md)

## Problem

Desktop and CLI share conversations, credentials and settings in the Harness home. Counting profile directories cannot establish exclusive Desktop ownership: CLI profiles are created on demand. Browser storage and updater downloads also live outside that home.

## Decision

Windows uninstallation preserves data by default. The user can select desktop browser data and update caches, only `profiles/desktop`, or the entire Harness home. Whole-home selection requires a native warning with the actual path and CLI impact, defaults to Cancel, and forces the desktop child selection. Removing the parent selection restores the child's earlier independent state. Silent and upgrade uninstalls never opt into data removal.

The last packaged Desktop launch writes its resolved home to an INI file under Electron user data. A length field detects truncated NSIS reads. Missing legacy records select the default home; an invalid record cannot authorize home deletion. The native remover rejects protected roots and installation overlap, holds directory handles against replacement during traversal, and unlinks descendant reparse points without traversing their targets. Failure stops uninstallation and discloses possible partial deletion. This remains a current-user operation, not an all-users purge.

The [earlier proposal](../../rejected/feature/2026-09-08-desktop-uninstall-preserve-dsh-home.md) is superseded by explicit selection rather than unconditional external-data removal. macOS cleanup is outside this implementation. Existing Desktop packaging and profile ownership decisions remain applicable.

## Alternatives considered

**Delete the whole home when desktop is the only profile.** Profile presence does not establish whether shared data is needed by CLI or a future reinstall.

**Always retain the home and automatically delete external caches.** Browser storage includes drafts and preferences; users choose whether to remove it. Users can also explicitly choose to discard all shared data.

**Use electron-builder's delete-app-data switch.** It lacks the selection hierarchy, shared-home warning and updater-cache inventory; cleanup belongs to the interactive custom page.

## Consequences

Desktop-only cleanup can retain Office runtimes and shared data. The complete-home option deletes every file under its displayed root, including user additions. Other historical homes, arbitrary plugin outputs and user projects outside selected roots are not discovered or deleted.

Qualification uses isolated product identities. Source regressions cover INI persistence and template adaptation; native fixtures cover retention, selective removal, junction targets and upgrade/silent behavior. The development host's Application Control blocks the unsigned test uninstaller, so native execution, installed release inventory and high-DPI visual acceptance remain unverified on that host. Compilation alone is not release qualification.
