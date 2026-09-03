# Agent Note: One editor family in general-purpose presets

Status: implemented

English | [中文](2026-08-10-default-presets-single-editor.zh.md)

## Problem

The `standard`, `code`, and `cordis` presets exposed both the `read`/`write`/`edit` filesystem tools and `str_replace_editor`. The two interfaces overlap for ordinary file inspection and editing, so every request carried an additional tool schema without adding a distinct default capability. The `minimal` preset originally retained `str_replace_editor` beside persistent `bash` as a separate composition exception.

## Decision

The `standard`, `code`, and `cordis` preset configurations mount `dsh-tool-fs` and `dsh-tool-fs-search`, but do not mount the standalone editor. PTC mode therefore omits that editor schema from both its registry and generated SDK. The later [persistent-shell-only decision](2026-09-03-minimal-profiles-persistent-shell-only.md) removes the editor from the shipped `minimal` and `sdk-minimal` compositions. The [complete-removal decision](2026-09-03-remove-str-replace-editor.md) subsequently deletes the standalone package and its runtime support.

This decision originally narrowed only the preset roster. The later complete-removal decision owns the package and Python runtime deletion. The earlier [shared-roster decision](../feature/2026-07-31-even-out-shipped-tool-rosters.md) continues to own why surface-neutral tools live in preset composition; this note owns the earlier preset exception.

## Alternatives considered

**Keep both editing interfaces in the general-purpose presets.** Rejected because the overlapping model-visible schemas increase tool choice without supplying a separate default operation.

**Remove the editor package from the distribution.** Rejected at the time because explicit deployments were treated as valid consumers. The later complete-removal decision accepts that compatibility break for v41.

## Consequences

General-purpose agents use `read`, `write`, and `edit` for filesystem mutations, while minimal agents use their persistent shell. The complete-removal decision now guarantees the obsolete editor cannot be mounted from the distribution.
