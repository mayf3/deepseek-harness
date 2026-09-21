# Agent Note: Windows uninstall retains the Harness home

Status: implemented

English | [中文](2026-09-18-windows-uninstall-retains-harness-home.zh.md)

## Problem

Desktop and CLI share conversations, credentials, settings and plugins in the Harness home. Electron keeps browser storage and caches under `%APPDATA%`, and the updater keeps downloaded installers under `%LOCALAPPDATA%`; the upstream NSIS template leaves both behind unless a command-line flag is passed. Users who uninstall expect the application to leave no residue, while users who reinstall expect their conversations back.

## Decision

Windows uninstallation removes the Electron user-data directory, the `%APPDATA%` product directory and the updater cache together with the application, and never touches the Harness home. No custom uninstaller page exists; silent uninstallation removes the same data, and upgrade uninstallation retains it so automatic updates keep UI preferences. Electron derives its user-data directory from the scoped package name, so the removal targets `%APPDATA%\@deepseek-ai\dsh-desktop` and removes the empty scope directory afterwards. Removal runs through the native helper in `window-frame.dll`, which rejects protected Windows folders and paths overlapping the installation, holds directory handles during traversal and unlinks reparse points without entering their targets. A failure is written to the uninstall log and does not stop uninstallation.

The 2026-09-08 proposal to keep the home and remove external application state is accepted for Windows in this form; its macOS helper and installed-artifact inventory programme were not adopted. Installation also records `InstallLocation` on the Windows uninstall entry so that Uninstall in the Start menu context menu launches the uninstaller directly.

## Alternatives considered

**Opt-in removal on a custom uninstaller page, including the desktop profile and the whole home.** The desktop profile, sessions and credentials belong to the home shared with the CLI and stay in place for reinstallation; the remaining Electron data holds only UI preferences and caches, which does not justify a choice the user must understand, a recorded home path for the uninstaller, and a bilingual native dialog.

**Delete the whole home when desktop is the only profile.** Profile presence does not establish whether shared data is needed by CLI or a future reinstall.

**Leave Electron data in place, matching the upstream default.** Chromium caches grow to hundreds of megabytes and are the residue users report after uninstalling.

**Use electron-builder's `deleteAppDataOnUninstall`.** The upstream `RMDir /r` follows no ownership rules, ignores long paths and enters linked directories; the native helper owns removal instead.

## Consequences

Reinstallation restores conversations, settings and plugins but not UI layout preferences. The desktop profile under the home remains with its packages and lock files. Other historical homes and user projects are not discovered or deleted.

Qualification uses isolated product identities with a scoped package name. Source regressions cover template adaptation; native fixtures cover retention of the home, removal of user data, the scope directory and the updater cache, junction targets, silent and upgrade behavior. High-DPI visual acceptance of the standard uninstaller pages remains unverified.
