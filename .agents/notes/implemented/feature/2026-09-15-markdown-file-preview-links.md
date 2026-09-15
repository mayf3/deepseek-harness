# Agent Note: Markdown file preview links

Status: implemented

English | [中文](2026-09-15-markdown-file-preview-links.zh.md)

## Problem

Assistant explanations link to existing source files that the turn does not modify or deliver. Restricting clickable references to produced-file mentions prevents readers from opening those sources beside the answer.

## Decision

Settled Assistant Markdown passes explicit local link destinations to the Chat file opener. The renderer recognizes absolute and workspace-relative paths, decodes percent escapes once, and separates `#L24` or `#L24-L30` into a first-line navigation request. A file control preserves the authored label and shows a file-category icon. It never navigates the browser to the authored path.

The existing [Sidebar navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md) owns Session addressing, tab reuse, and preview selection. The Host file service retains access checks and missing-file errors. Inline-code produced-file matching remains independent. External URLs retain their protocol allowlist; queries, fragment-only destinations, unsupported fragments, malformed escapes, and invalid line ranges remain inert.

## Alternatives considered

- Allow relative browser anchors: those navigate the application URL instead of requesting Session file content.
- Require a produced-file entry: this excludes ordinary read-only explanations.
- Add a new preview service: Chat already supplies the required opener and line parameter.

## Consequences

Source references need no new Session event or model prompt. Links become active when the message settles. A range selects its first line; the preview does not highlight a multi-line selection. Unit tests cover destination parsing and callback wiring; the keyless `markdown-file-links` Web snapshot covers file content, line navigation, and tab reuse through the shipped composition.
