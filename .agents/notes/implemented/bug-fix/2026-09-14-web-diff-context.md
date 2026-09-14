# Agent Note: Web diff cards compare contextual content

Status: implemented

English | [中文](2026-09-14-web-diff-context.zh.md)

## Problem

Filesystem result metadata carries before/after fragments that include unchanged context. Treating each complete fragment as removed or added mislabels shared lines and inflates both card and collapsed-row totals.

## Decision

The Web primitive derives line patches with the maintained `diff` library. Each change includes up to three context lines on either side; distant changes use separate hunks. Context appears once in a neutral tone and contributes to neither total. The card and `diffTotals` use the same patch derivation. This remains Client presentation under the [tool presentation ownership decision](../architecture/2026-08-23-client-derived-tool-presentation.md), without changing persisted metadata or public props.

## Alternatives considered

Trimming only a common prefix and suffix cannot recognize unchanged lines between replacements. Extending durable metadata with row kinds would require producers and historical readers to change for a display-only correction. A custom diff algorithm adds maintenance without a distinct requirement.

## Consequences

The browser build includes `diff`. Comparing very large replacements is synchronous and can delay rendering even for collapsed summaries; the row height cap does not bound this work. An approximate replacement fallback is excluded because it can mislabel unchanged lines. The existing content-line rule treats a trailing newline as a terminator, so newline-only differences remain unrepresented. Component regressions cover shared and distant context, repeated lines, insertion/deletion, copied prefixes, and summary totals.
