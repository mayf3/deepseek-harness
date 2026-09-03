# Agent Note: Remove the string-replacement editor

Status: implemented

English | [中文](2026-09-03-remove-str-replace-editor.zh.md)

## Problem

No shipped profile still needs the standalone `str_replace_editor` interface. General-purpose profiles already expose `read`, `write`, and `edit`, while the next-generation minimal contract exposes only its persistent shell. Keeping the dormant package would still ship its implementation, dependency closure, configuration surface, generated catalog entries, client presentation branches, and model-schema snapshots.

A hidden or unmounted tool is not a complete removal. User-authored configuration could still mount it, and future composition changes could accidentally restore the schema.

## Decision

Delete `@deepseek-ai/dsh-tool-str-replace-editor` from the workspace and distribution. Remove its shared-base row, disabled Web override, CLI and Python runtime dependencies, TypeScript project aliases, tool-catalog registration, client-specific diff and produced-file handling, package documentation, tests, and recorded scenario. Regenerated configuration catalogs, module graphs, composition diagrams, and request snapshots must contain no package or model-visible tool entry.

No compatibility alias, hidden registration, or replacement package is retained. General-purpose profiles keep `read`, `write`, `edit`, `glob`, and `grep`; minimal profiles keep their platform-selected persistent shell. Historical unknown tool events can use the existing generic client fallback, but the project does not advertise or test the removed contract.

This decision supersedes the editor half of [the original persistent-tool decision](../feature/2026-07-29-persistent-bash-str-replace-editor.md), [the standalone-package exception](2026-08-10-default-presets-single-editor.md), and [the minimal-profile scope boundary](2026-09-03-minimal-profiles-persistent-shell-only.md). The original note continues to own persistent Bash behavior; the minimal-profile note continues to own the one-shell contract.

## Alternatives considered

**Keep the package for explicit custom compositions.** Rejected because there is no current shipped consumer, and an opt-in package still expands the supported and published surface.

**Leave the registration in place and filter it from model requests.** Rejected because presentation settings could restore the capability and every runtime would continue carrying inactive code.

**Provide an alias or compatibility shim over `read`/`write`/`edit`.** Rejected because the project is pre-release and a shim would preserve the schema and maintenance cost this change removes.

## Consequences

Existing user-authored configurations that name the deleted package fail loudly and must migrate to `read`, `write`, `edit`, or a shell. This is an accepted v41 pre-release compatibility break.

The removed interface can return only through a new decision with a distinct current consumer, explicit composition owner, package and runtime closure, model-visible documentation, and tests. Until then, source, published manifests, generated catalogs, and current snapshots contain no `str_replace_editor` tool.
