# Agent Note: Native Windows installer pages

Status: implemented

English | [中文](2026-09-10-windows-native-installer-pages.zh.md)

## Problem

The Windows installation interface needs branded light and dark pages without introducing another application runtime or replacing the release mechanisms that extract, register, upgrade, and uninstall Desktop.

## Decision

The installer adds custom welcome, progress, and completion pages through electron-builder's NSIS include. The stock script remains responsible for installation and uninstaller generation. A custom full script bypasses electron-builder's separate uninstaller signing path and is therefore unsuitable for this interface change. The [Desktop release decision](2026-08-25-electron-desktop-packaging-and-updates.md) continues to own release identity, update distribution, and signing requirements.

NSIS native controls preserve directory editing, folder selection, checkbox state, and keyboard interaction. An x86 Win32/GDI+ helper retains DWM shadows and draws installation progress on the UI thread while the stock installation worker runs. Stock page visibility is suppressed even when NSIS shows the page after MUI's callback. Windows 11 supplies the outer corner radius; Windows 10 retains its supported frame appearance.

Installation is per-user. Paths are validated before installation writes, and a running application is left running while setup exits after a native acknowledgement. Completion launches only when selected. Silent updates retain the existing electron-builder command-line behavior. The installation engine does not add transactional rollback or take ownership of first-launch profile preparation.

## Alternatives considered

**An Electron installer interface** adds a runtime before the application exists and requires a separate installation bridge. Native controls provide the required interaction within the existing installer.

**Replacing the full NSIS script with the lightweight prototype** also replaces upgrade, registry, uninstaller, and signing behavior. The prototype's transaction mechanism requires separate release qualification and is excluded from the UI integration.

**A window region for rounded corners** disables the DWM frame shadow. The system frame preserves the shadow while accepting the platform's corner radius.

## Consequences

Windows packaging additionally requires the x86 Visual C++ compiler and Windows SDK. The helper is signed by the same signer as other Windows artifacts. Progress is an estimate derived from stock NSIS progress, not a remaining-time promise.

The native installer regression uses a unique product identity and private installation directory to verify path rejection, folder selection, launch choices, upgrade, running-process preservation, hidden stock progress, and uninstall. Its screenshots and expected behavior belong to Desktop tests rather than recorded Session snapshots. Signed release qualification still requires the configured certificate and token, and actual Windows update artifacts.
