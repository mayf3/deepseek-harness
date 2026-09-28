# Agent Note: Bundle and plugin display metadata

Status: implemented

English | [中文](2026-09-28-bundle-and-plugin-display-metadata.zh.md)

## Problem

One package can export several plugins. Its npm introduction and image identify the package, not every exported plugin. Display text must also remain available before activation and after a plugin fails to load.

## Decision

Ordinary plugins reuse `meta.title` and `meta.description` in their exported locale JSON. They do not read package manifests for display text or custom images. The [localized metadata decision](2026-09-18-localized-package-metadata.md) retains ownership of locale resource identity, English discovery, per-field language fallback, diagnostics, and non-activation; this decision supersedes its ordinary-plugin package fallback.

Bundles use the same locale resources and can additionally read exported package-manifest text and an independent `./icon` resource. Node exports select both locale and icon paths, so authors can relocate assets without changing public resource addresses. An icon needs neither a top-level manifest field nor an exported `package.json`. The [package cookbook](../../../../docs/cookbook/adding-a-package.md#plugin-display-metadata) owns the authoring format and image restrictions.

The manager passes the bundle directory it already resolved. Confinement uses that real package root, not the icon's directory or the locale directory: sibling asset directories are valid, while symlinks outside the package are not. A missing icon export is optional; an invalid target or unreadable selected file reports a diagnostic without discarding valid text. Ordinary plugin rows and their details use generic artwork.

No metadata lookup evaluates a plugin entry. Disabled and failed plugins retain locale text, and each full plugin specifier and resolution parent keeps its own resource identity. Publication checks validate ordinary plugin locales as well as bundle locales, selected image resources, and publication coverage.

## Alternatives considered

**Export a JavaScript `meta` value.** Reading it requires module evaluation and makes metadata depend on loading. Existing locale JSON already supports disabled plugins and independent subpath metadata.

**Use package metadata for every plugin.** A package-wide introduction or image need not describe each plugin it exports. Ordinary plugins own their locale text; bundles own package-level display resources.

**Keep a top-level `icon` path.** It adds a separate path declaration outside the existing resource-export mechanism. The fixed `./icon` address allows the same Node resolution and remapping as locale resources.

**Require a manifest export for icons.** Text fallback and image publication are independent. The already-resolved bundle root provides confinement without exposing another resource.

## Verification

Focused reader and publication tests cover remapped and conditional targets, absent exports, invalid resources, size limits, confinement, and locale-only ordinary reads. Consumer and browser tests cover localized disabled rows, bundle images, generic ordinary artwork, and retained diagnostics.

## Consequences

Bundle authors replace top-level `icon` declarations with `exports["./icon"]` and include the target in `files`. Ordinary authors who want package-description text on their plugin rows publish it in locale `meta.description`; otherwise the description is absent. The Host reads no extra JavaScript and needs no Cordis or Loader metadata API. Session logs and management-tool display exclusions remain unchanged.
