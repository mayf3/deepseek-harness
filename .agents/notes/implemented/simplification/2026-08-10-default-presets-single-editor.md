# Agent Note: One editor family in general-purpose presets

Status: implemented

English | [中文](2026-08-10-default-presets-single-editor.zh.md)

## Problem

The `standard`, `code`, and `cordis` presets exposed both the `read`/`write`/`edit` filesystem tools and `str_replace_editor`. The two interfaces overlap for ordinary file inspection and editing, so every request carried an additional tool schema without adding a distinct default capability. The `minimal` preset originally retained `str_replace_editor` beside persistent `bash` as a separate composition exception.

## Decision

The `standard`, `code`, and `cordis` preset configurations mount `dsh-tool-fs` and `dsh-tool-fs-search`, but do not mount `dsh-tool-str-replace-editor`. PTC mode therefore omits `str_replace_editor` from both its registry and generated SDK. The later [persistent-shell-only decision](2026-09-03-minimal-profiles-persistent-shell-only.md) removes the editor from the shipped `minimal` and `sdk-minimal` compositions. Deployments and user-authored presets may still mount the plugin explicitly.

This decision narrows the preset roster rather than removing the tool package or its Python runtime support. The earlier [shared-roster decision](../feature/2026-07-31-even-out-shipped-tool-rosters.md) continues to own why surface-neutral tools live in preset composition; this note owns the editor exception.

## Alternatives considered

**Keep both editing interfaces in the general-purpose presets.** Rejected because the overlapping model-visible schemas increase tool choice without supplying a separate default operation.

**Remove the `str_replace_editor` package from the distribution.** Rejected because explicit deployments remain valid consumers of the standalone plugin.

## Consequences

General-purpose agents use `read`, `write`, and `edit` for filesystem mutations, while minimal agents use their persistent shell. Preset composition tests pin `str_replace_editor`'s absence from every shipped preset and the PTC mode SDK.
