# Agent Note: Desktop standard macOS window menus

Status: implemented

English | [中文](2026-09-16-desktop-window-menus.zh.md)

## Problem

The Desktop shell replaces Electron's default application menu with a custom template that listed only the application and Edit menus. Electron builds only the roles a template declares, so macOS lost the File and Window menus the default template supplies, including Close Window (⌘W) and Minimize (⌘M). Both shortcuts did nothing in the Desktop application while other macOS applications respond to them, so users could not make the main window leave the screen with the shortcut they already knew.

## Decision

On macOS the template declares `{ role: 'fileMenu' }` before the Edit menu and `{ role: 'windowMenu' }` after it. Close Window (⌘W), Minimize (⌘M), Zoom, Bring All to Front, and the open-window list come from those roles; Electron localizes their labels from the application locale, so the Desktop dictionaries stay unchanged. Windows and Linux keep the application and Edit menus.

Closing the main window takes the same path as the window's traffic-light button: the dsh Host keeps running, and the Dock icon or `activate` recreates the window. `window-all-closed` still quits only on non-macOS platforms.

## Alternatives considered

**Bind ⌘W to minimizing the window.** The feedback asked for ⌘W, but macOS reserves Minimize for ⌘M and every comparable application closes the front window with ⌘W. Binding minimization to ⌘W would contradict the platform convention the report appealed to.

**Declare only the Window menu.** That menu supplies Minimize and Zoom but no Close, so the reported ⌘W would stay dead.

**Add a bare `{ role: 'close' }` item to the application submenu.** It avoids a File menu containing a single command, but places a window command among the app-wide Plugins, Updates, and Quit items where no macOS application puts it.

**Declare the File and Window menus on every platform.** The same template declares Ctrl+W there; with one window, closing it invokes `window-all-closed` and quits the application, turning a window shortcut into an unrequested quit path.

## Consequences

macOS regains the window commands the custom menu suppressed, at the cost of two menu roles the [Desktop README](../../../../apps/desktop/README.md) must keep explaining. Role labels follow Electron's locale rather than the Desktop dictionaries, which is also true of the existing Edit menu.

## Testing

A `apps/desktop/tests/main-startup.spec.ts` case pins the declared menu roles on macOS and on Windows and Linux. Role-based menu items execute natively, so a programmatic `click()` and the vitest Electron mock cannot exercise the shortcuts; a real Electron 44 run of the same template showed Close Window (⌘W) and Minimize (⌘M) present only after this change.
