---
description: "Frozen file-reference eligibility, label judgments, and original-task checks for prompt maintainers."
kind: "package-reference"
---

# File-reference evaluation rubric

## Summary

These checks preserve the user-calibrated R3 rules and four original tasks. Task coverage, supported factual contradictions, unresolved claims, linking, and presentation are separate observations. No weighted score, character cutoff, significance claim, or universal-winner threshold is defined.

## Table of Contents

- [References and labels](#references-and-labels)
- [Original tasks](#original-tasks)
- [Review records](#review-records)
- [GUI and experiment limits](#gui-and-experiment-limits)

## References and labels

Count every reader-facing mention of an identifiable existing file, including repeats, headings, lists, tables, aliases, and bare filenames in inline code. Commands, configuration expressions, code blocks, directories, globs, hypothetical files, and unverified candidates do not enter the verified denominator. Record exclusions and uncertainty with their reasons; false existence claims remain factual issues.

E is eligible mentions, L valid links, M missing links, and I invalid links: E = L + M + I. Zero E is inactive, never 100%. A timed-out attempt remains a failure; an absent answer has no content denominator. Keep all first attempts and report missing reviews explicitly.

One filename followed by plain line numbers is one occurrence. Repeating only a plain line number creates no additional linking obligation. An actual numeric-only Markdown file link counts once. Full workspace-relative and absolute targets are valid; known-line anchors use `#L24` or `#L24-L30`. A displayed colon suffix is not a DSH destination anchor. Check parser acceptance, intended file identity, existence, and range separately from whether the cited text supports the claim.

Labels may use a filename, short suffix, clear alias, or contextual numeric reference. Prefer an identifiable basename over its full repository path. Judge unnecessary directories and same-basename ambiguity in visible nearby context; hidden URLs and tooltips do not establish visible clarity. A basename need not be globally unique. Keep composite README references, generic groups, and unresolved aliases outside decisive counts, with sensitivity bounds where useful.

Report full-path frequency, unnecessary qualifiers, label lengths, distinct files, numeric labels, malformed targets, wrong-file targets, and broken ranges separately. Exclude numeric-only and explicit line-reference labels from filename/alias lengths. Count unlinked full-path mentions too, so missing links cannot masquerade as shorter labels. Use the lower middle observation for even-sample medians and the ceiling rank for P90, matching the historical report.

## Original tasks

Each criterion receives addressed, omitted, contradicted, or unverified, with output spans and source evidence. Covering a topic does not establish correctness. Suggested edits do not violate read-only scope. No requirement to execute tests or produce findings is added to a task that asks for inspection.

| ID | Requirement |
| --- | --- |
| P1 | Minimal Buffer support grounded in implementation, retaining string support. |
| P2 | Address implementation, tests, documentation, and callers; evidence may show a surface needs no edit. |
| P3 | Explain compatibility without requiring an unsupported overload or API design. |
| P4 | Give verification appropriate to the proposed change. |
| P5 | Read-only analysis, no subagents, assessed from execution evidence. |
| D1 | Explain the stale-version sequence and usable investigation steps. |
| D2 | Give the supported retry procedure and current basis for retry. |
| D3 | Explain restored-session differences from source evidence. |
| D4 | Identify relevant implementation, tests, documentation, and useful investigation files. |
| D5 | Invocation examples are optional; supplied examples must agree with implementation. |
| D6 | Read-only analysis, no subagents, assessed from execution evidence. |
| R1 | Inspect or discuss the implementation. |
| R2 | Inspect or discuss the tests. |
| R3 | Inspect README and documented expectations. |
| R4 | Give supported findings or explicitly state no issue was confirmed. |
| R5 | Explain the behaviors checked beyond a bare assertion of correctness. |
| R6 | Verify material findings against preserved source; distinguish confirmed issues, limitations, and speculation. |
| R7 | Read-only analysis, no subagents, assessed from execution evidence. |
| X1 | Explain CLI task origin and entry into Session execution. |
| X2 | Explain source-supported model selection inputs and defaults. |
| X3 | Explain working-directory selection. |
| X4 | Explain output timing relative to execution and completion. |
| X5 | Explain failure handling without unsupported recovery promises. |
| X6 | Explain Session resume and relevant task/model/directory interactions. |
| X7 | Connect the topics into a coherent Session lifecycle account. |
| X8 | Verify material factual claims and citations against preserved source. |
| X9 | Read-only analysis, no subagents, assessed from execution evidence. |

## Review records

For each first answer, review the complete text and retain an occurrence ledger containing line, column, text, identified file, L/M/I classification, exclusions, and ambiguity. Record task-criterion observations and source-supported contradictions separately. Reviewers must not infer E by counting only Markdown links. A self-review is supplemental evidence, not authoritative scoring.

Create `annotation.json` beside a reviewed run's `final.md`, with `finalSha256`, `counts` containing E/L/M/I, and the occurrence/task ledgers. The summarizer verifies the answer hash and arithmetic; it does not validate human identity judgments or semantic claims. Missing annotations remain unreviewed. Historical observations contain aggregate counts imported from the original audit; their full raw ledgers remain in the private experiment archive.

## GUI and experiment limits

Review scanability, informative labels, same-basename clarity, visible/clickable links, correct destinations, wrapping, clipping, tables, line-number placement, and retained task explanation. Match viewport, theme, and zoom across prompts; inspect raw rendered answers without rewriting them. Screenshots alone do not verify clicking. Overall attractiveness and acceptable density require human preference, with no numeric beauty score.

Freeze exact tasks, treatments, permitted resources, and bounds before execution. Keep evaluator material outside the task workspace. Run three fresh repetitions to describe variance; preserve failures and never replace them with silent retries. Known development tasks are not holdouts. An inactive formatting branch remains unverified. Later colon-label revisions and guided GUI demos are separate evidence, not new scores for the original A/B/C cohort.
