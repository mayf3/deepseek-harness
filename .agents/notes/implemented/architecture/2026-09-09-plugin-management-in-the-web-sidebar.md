# Agent Note: Plugin management moves to the Web sidebar

Status: implemented

English | [中文](2026-09-09-plugin-management-in-the-web-sidebar.zh.md)

## Problem

[Plugin management in Web settings](2026-09-04-plugin-management-in-web-settings.md) put the manager on a tab of the Settings dialog's Plugins section, beside the configuration tab. Settings is a modal over the current Session, while a person managing what is installed has no Session in mind; the dialog's width and its one-section-at-a-time shell also leave no room for a package page, an install run, and the list side by side. The layout has since gained root-scoped main panels behind sidebar entries ([global main panels](2026-09-08-global-main-panels.md)), which is the lifetime and the room the manager needs.

## Decision

**Management is a sidebar entry; configuration stays in Settings.** `ui-settings-plugin-manager` registers a `sidebar.panellist` entry and the `main` panel it opens under one id, `plugins`: the sidebar renders the localized **Plugins** label, this package the icon and the page. The page is root-scoped and bound to no Session; it carries its own heading, intro, refresh, and **Add plugin**, and scrolls inside the main column. What the page shows did not change: the packs and plugins, each package's page, the install dialog, and the confirmations are the former tab's. The Settings **Plugins** section keeps plugin configuration, and `ui-settings-plugins` renders a single `settings.plugins.tab` contribution as the page itself, without a tab strip, so the section reads as the configuration page it now is. The preset detail page in Settings keeps its **Capabilities** section over the same store.

**Configuration does not move.** A plugin's configuration binds a settings namespace under a scope — the global instance or one preset's — and the Settings shell owns that scope machinery, one selection serving the section and every preset's detail page. Moving the cards onto the management page would duplicate the shell's scope selection and split settings across two entry points, while a person looks for a value in Settings. The plugin's own page will instead point at its configurable sections once Settings can be opened on one section, which needs only a deep link.

## Alternatives considered

**A settings section that opens the management page.** Rejected: the dialog covers the main column, so such an entry would have to close Settings to show the page.

**Configuration on the plugin's page.** Rejected for now, for the reasons in the decision; it becomes a link from the plugin's page once Settings can be opened on one section.

## Consequences

The web bundle's panel list is no longer empty: the **Plugins** entry sits between New Session and the workspaces. The Settings Plugins section shows the configuration page without tabs. `apps/web/tests/plugin-manager.e2e.ts` reaches the manager through the sidebar, and the `plugin-config` and `settings-chrome` scenarios and goldens follow.

## Testing

`packages/client/ui-settings-plugin-manager/tests` pin the two registrations under one id and the page's rendering; `packages/client/ui-settings-plugins/tests` the tab-less single contribution; the web e2e scenarios above drive the panel and the section over a scaffold.
