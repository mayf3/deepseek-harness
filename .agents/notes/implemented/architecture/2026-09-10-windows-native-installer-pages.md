# Agent Note: Native Windows installer pages

Status: implemented

English | [中文](2026-09-10-windows-native-installer-pages.zh.md)

## Problem

The Windows installation interface needs branded light and dark pages without introducing another application runtime or replacing the release mechanisms that extract, register, upgrade, and uninstall Desktop.

## Decision

The installer adds custom welcome, progress, and completion pages through electron-builder's NSIS include. The stock script remains responsible for installation and uninstaller generation. A custom full script bypasses electron-builder's separate uninstaller signing path and is therefore unsuitable for this interface change. The [Desktop release decision](2026-08-25-electron-desktop-packaging-and-updates.md) continues to own release identity, update distribution, and signing requirements.

NSIS native controls preserve directory editing, folder selection, checkbox state, and keyboard interaction. An x86 Win32/GDI+ helper retains DWM shadows and draws installation progress on the UI thread while the stock installation worker runs. Stock page visibility is suppressed even when NSIS shows the page after MUI's callback. Windows 11 supplies the outer corner radius; Windows 10 retains its supported frame appearance.

Installation is per-user. Welcome-page leave validation reads the current edit control for mouse and keyboard navigation; the debounced inline hint is not an installation authority. Running-process checks match the affected executable path, leaving other installations independent. Completion-page leave honors the launch checkbox for both mouse and keyboard navigation. Electron-builder resolves the registered directory before custom initialization, so silent updates without `/D=` retain that directory. The installation engine does not add transactional rollback or take ownership of first-launch profile preparation.

## Alternatives considered

**An Electron installer interface** adds a runtime before the application exists and requires a separate installation bridge. Native controls provide the required interaction within the existing installer.

**Replacing the full NSIS script with the lightweight prototype** also replaces upgrade, registry, uninstaller, and signing behavior. The prototype's transaction mechanism requires separate release qualification and is excluded from the UI integration.

**A window region for rounded corners** disables the DWM frame shadow. The system frame preserves the shadow while accepting the platform's corner radius.

## Consequences

Windows packaging additionally requires the x86 Visual C++ compiler and Windows SDK. The helper is signed by the same signer as other Windows artifacts. The preparation hook returns true on every platform: electron-builder treats a falsy return as external dependency ownership and omits its production node_modules collection. The pinned app-builder-lib patch adds optional extraction/copy notifications and a copy hook on the stock worker. Stage callbacks preserve NSIS registers, stack, and error flags. The helper reads the percentage emitted by Nsis7z into a private hidden detail label, avoiding the shared NSIS instruction counter and the plugin callback’s truncated 32-bit byte counts. Windows IFileOperation owns recursive copying and reports completed work through its progress sink; copy failures return to the builder’s retry loop. The helper queues every top-level payload item, including hidden files, and checks both the operation result and the aborted flag. It does not implement recursive file copying. Preparation, registration, and cleanup retain bounded estimates. Stage weights express completed work, not remaining time. Displayed progress never regresses when a source resets or revises its total, and captions follow the displayed stage. NSIS success authorizes a 600 ms fill animation and a brief 100% frame, with a 750 ms transition target; timers cannot authorize success. The frame stays hidden until branded controls are ready and is initialized once; page transitions preserve its position. Finish hides the window before creating the installed process directly under the current user. An explicitly elevated installer retains shell-mediated launch. Launch failure restores the finish page. Application startup time is independent of installer dismissal.

The native installer regression uses a unique product identity and private installation directory to verify path rejection, folder selection, launch choices, upgrade, running-process preservation, hidden stock progress, first-show readiness, and uninstall. Deterministic native progress tests cover fast and slow copy, stalls, revised totals, short cleanup, and success between UI ticks. Native file tests cover recursive copying, Unicode paths, hidden files, replacement, and locked-file failure followed by retry. Its screenshots and expected behavior belong to Desktop tests rather than recorded Session snapshots. Signed release qualification still requires the configured certificate and token, and actual Windows update artifacts.
