# Agent Note: Markdown file preview links

Status: implemented

English | [中文](2026-09-15-markdown-file-preview-links.zh.md)

## Problem

Assistant explanations link to existing source files that the turn does not modify or deliver. Restricting clickable references to produced-file mentions prevents readers from opening those sources beside the answer.

## Decision

Settled Assistant Markdown passes explicit local link destinations to the Chat file opener. The renderer recognizes absolute and workspace-relative paths, decodes percent escapes once, and separates `#L24` or `#L24-L30` into a first-line navigation request. A file control preserves the authored label and shows a file-category icon. It never navigates the browser to the authored path.

The existing [Sidebar navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md) owns Session addressing, tab reuse, and preview selection. The Host file service retains access checks and missing-file errors. Inline-code produced-file matching remains independent. External URLs retain their protocol allowlist; queries, fragment-only destinations, unsupported fragments, malformed escapes, and invalid line ranges remain inert.

The Web file-reference prompt asks for a link on every existing-file mention outside commands, configuration expressions, and code blocks, including repeats and tables. Names default to a basename or clear alias with minimal disambiguating parents. Precise labels use `filename:24` or `filename:24–30`, while destinations keep the parser's `#L24` or `#L24-L30` syntax. The renderer preserves model-authored text; it does not rewrite labels to enforce the prompt.

## Alternatives considered

**Relative browser anchors.** They navigate the application URL instead of requesting Session file content.

**Require a produced-file entry.** This excludes ordinary read-only explanations.

**Add a preview service.** Chat already supplies the required opener and line parameter.

**Filename-first or display-only prompt variants.** The three-variant development comparison favored A for occurrence-level link coverage and the user preferred its output. B produced more answers with no missing links, so these observations do not establish a universal winner. Visible `#L` suffixes were rejected in favor of the familiar colon notation; retaining anchor syntax in destinations preserves existing navigation.

## Consequences

Source references need no new Session event. The static Web guidance is logged through the existing system-message mechanism. Links become active when the message settles. A range selects its first line; the preview does not highlight a multi-line selection. Unit tests cover destination parsing and callback wiring; the keyless `markdown-file-links` Web snapshot covers file content, colon labels, line navigation, and tab reuse through the shipped composition. The package tests check the guidance in every Web prompt sidecar and keep the final colon treatment aligned with the shipped paragraph. Historical input hashes and the evaluation runner’s keyless checks run in Linux PR CI. The evaluation runner waits for live process-group members to terminate, excluding zombies that can retain a group id after exit; a PID-existence probe cannot establish running work.

## Prompt evaluation

The development comparison ran four read-only tasks three times per variant. E counts eligible existing-file mentions, L valid links, M missing links, and I invalid links; E = L + M + I. A timed out once without a final answer; that attempt remains a failure and is excluded only from content denominators. These descriptive measurements are neither a weighted quality score nor a holdout evaluation.

| Metric | A | B | C |
| --- | ---: | ---: | ---: |
| Completed first answers / attempts | 11/12 | 12/12 | 12/12 |
| Valid-link coverage L/E | 453/476 (95.2%) | 539/585 (92.1%) | 467/592 (78.9%) |
| Missing / invalid links | 23 / 0 | 45 / 1 | 124 / 1 |
| Answers with M = I = 0 | 2/11 | 5/12 | 4/12 |
| Unnecessary directory labels / named labels | 149/373 | 200/471 | 166/403 |
| Full-path labels / named labels | 44/373 | 89/471 | 118/403 |
| Balanced 11-answer coverage | 95.2% | 93.0% | 79.0% |

The colon revision is a separate development run. Its first three answers contained 28 mixed `:start-Lend` suffixes, retained as failures. Explicitly forbidding both `#` and `L` in the suffix yielded 51 structurally valid links in one repeated explanation, but no colon labels, three missing links, and 27 unnecessary directory qualifiers. A subsequent user-accepted demo produced 18 structurally valid links, including three colon labels and no mixed suffix. Neither run establishes reliable compliance or exhaustive factual accuracy. Authentication failures, the timeout, and all first answers remain in the local experiment archive; the [committed metrics](../../../../packages/client/ui-deliverables/evals/file-references/results/2026-09-16/metrics.md) carry the extended 69-row metrics and task-rubric tables.

Reusable [evaluation inputs and rubrics](../../../../packages/client/ui-deliverables/evals/file-references/README.md) live beside the prompt owner, with compact historical observations and failure records. Their manual runner uses the supported headless profile and keeps generated outputs outside version control. Package ownership keeps prompt changes and their regression criteria together; the repository performance benchmark tree has different input and timing requirements.
