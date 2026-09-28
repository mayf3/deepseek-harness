# Agent Note: Bundle and plugin display metadata

Status: implemented

English | [中文](2026-09-28-bundle-and-plugin-display-metadata.zh.md)

## Problem

One package can export several plugins. Its npm introduction and image identify the package, not every exported plugin. Display text must also remain available before activation and after a plugin fails to load.

## Decision

Ordinary plugins reuse `meta.title` and `meta.description` in their exported locale JSON. They do not read package manifests for display text or custom images. The [localized metadata decision](2026-09-18-localized-package-metadata.md) retains ownership of locale resource identity, English discovery, per-field language fallback, diagnostics, and non-activation; this decision supersedes its ordinary-plugin package fallback.

Bundles use the same locale resources and can additionally read exported package-manifest text and icons. The manifest `icon` field retains its existing relative-path meaning and takes priority; only omission enables the independent `./icon` resource. Node exports select locale and fallback icon paths, so authors can relocate assets without changing public resource addresses. An exported fallback icon needs no manifest export. The [package cookbook](../../../../docs/cookbook/adding-a-package.md#plugin-display-metadata) owns the authoring format and image restrictions.

The manager passes the bundle directory it already resolved. Manifest icons stay inside the declaring manifest's directory, including for remapped manifests. Exported fallback icons stay inside the real bundle root, allowing sibling asset directories while rejecting symlinks outside the package. Invalid declared icons report a diagnostic without discarding valid text or trying the lower-priority export. Ordinary plugin rows and their details use generic artwork.

No metadata lookup evaluates a plugin entry. Disabled and failed plugins retain locale text, and each full plugin specifier and resolution parent keeps its own resource identity. Publication checks validate ordinary plugin locales as well as bundle locales, selected image resources, and publication coverage.

## Alternatives considered

**Export a JavaScript `meta` value.** Reading it requires module evaluation and makes metadata depend on loading. Existing locale JSON already supports disabled plugins and independent subpath metadata.

**Use package metadata for every plugin.** A package-wide introduction or image need not describe each plugin it exports. Ordinary plugins own their locale text; bundles own package-level display resources.

**Use only an icon export.** Replacing the manifest field would invalidate existing bundle declarations. The exported resource is additive and has lower priority, preserving those declarations and their relative paths.

**Require a manifest export for the fallback image.** Text fallback and exported image publication are independent. The already-resolved bundle root confines exported images without exposing another resource.

## Verification

Focused reader and publication tests cover manifest-first precedence, remapped legacy manifests, exported fallback targets, absent exports, invalid resources, size limits, confinement, and locale-only ordinary reads. Consumer and browser tests cover localized disabled rows, distinct manifest and export images, generic ordinary artwork, and retained diagnostics.

## Consequences

Existing bundle icon declarations need no migration. Authors may add `exports["./icon"]` as a lower-priority alternative and include its target in `files`. Ordinary authors who want package-description text on their plugin rows publish it in locale `meta.description`; otherwise the description is absent. The Host reads no extra JavaScript and needs no Cordis or Loader metadata API. Session logs and management-tool display exclusions remain unchanged.
