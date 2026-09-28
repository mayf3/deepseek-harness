# Agent Note: Bundle and plugin display metadata

Status: implemented

English | [中文](2026-09-28-bundle-and-plugin-display-metadata.zh.md)

## Problem

A Cordis plugin can be a module namespace, function, or service class. It need not own an npm package. Reading a manifest for every plugin assigns package-level introductions and icons to entries that may represent unrelated functions in the same package.

## Decision

Bundles own package display resources and custom icons. Ordinary plugins provide optional title and description through the loaded plugin object's `meta` property: a named export for a function-plugin namespace, or a static property on a default-exported service class. Each field uses the existing literal-string or language-map representation with an English fallback. The [package cookbook](../../../../docs/cookbook/adding-a-package.md#plugin-display-metadata) owns authoring examples.

Each Cordis fiber retains the unwrapped plugin supplied at registration. Loader exposes the current live root fiber's plugin, so HMR replacement and rollback expose the corresponding metadata. Inventory reads project only title and description from that object, including mounted preset entries. Reads never import plugins, resolve their locale resources, or open their manifests. An unloaded entry has no metadata; its module name remains available as the display fallback. Loaded entries waiting for dependencies or retaining an activation error can still supply text. Icons are omitted from ordinary plugin responses and rows.

Bundle metadata remains readable while the bundle is disabled. Exported `locale/en.json` anchors language discovery; fields fall back independently to the accessible bundle manifest, then its complete name without a description. Resource resolution respects package exports and the caller's resolution base. File-addressed metadata requests do not probe neighboring resources. Invalid locale or icon files retain diagnostics and management controls. The icon reader returns a data URL for a supported image contained in the manifest directory, including after symlink resolution.

The Client uses its existing language selection. Full module names, entry ids, search identities, and operation targets remain technical identities. Settings may shorten literal technical-name fallbacks; translated titles remain unchanged. Configuration summaries remain available when a plugin has no description. Registry installation previews, model-facing management output, and Session events do not receive multilingual UI dictionaries.

This decision replaces the ordinary-plugin resource lookup in the [partially superseded metadata decision](2026-09-18-localized-package-metadata.md) and retains its bundle resource rules. Built-in bundle copy stays in exported locale files rather than a manager-owned dictionary. Publication checks validate bundle metadata resources and icons only.

## Alternatives considered

**Require one manifest per plugin.** Subpaths and local modules are valid Cordis plugins; package ownership is not part of their loading interface.

**Import disabled plugins to read exports.** Importing executes module initialization. Opening or refreshing a management page must not execute an otherwise disabled plugin.

**Read sibling locale files or cache package metadata for plugin rows.** Compiled layout and package names do not identify individual plugin behavior. Retaining the actual loaded object preserves per-entry identity and avoids a separate cache invalidation policy.

**Register display text during activation.** Pending plugins would lack metadata even though their module is already loaded. A passive exported value is available independently of service readiness.

**Add a second language fallback policy or download packages for previews.** Existing locale selection covers display text, and registry previews need no additional package execution or downloads.

## Verification

Focused tests cover loaded namespace and service metadata, pending and failed entries, disable/re-enable replacement, HMR replacement and rollback, preset projection, profile-tree row identity, and absent manifest reads for ordinary rows. Bundle tests retain locale fallback and icon validation. Client and browser tests distinguish bundle artwork from ordinary plugin rows. Publication tests reject invalid bundle resources while ignoring unrelated plugin resources.

## Consequences

Disabled or otherwise unloaded plugins display their module names even when their source exports metadata. Authors move ordinary plugin introductions from JSON resources to `meta`; only bundles can supply custom icons.
