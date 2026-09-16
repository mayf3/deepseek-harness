# Agent Note: One card per delivered changed file

Status: proposed

English | [中文](2026-09-16-delivered-file-single-card.zh.md)

## Problem

A finished turn ends with two file surfaces: the [changed-files card](../../implemented/feature/2026-09-11-turn-changed-files-card.md) lists every file the turn changed with its line counts and opens the [review tab](../../implemented/feature/2026-09-15-changed-file-diff-preview.md) on that file, and a delivery card for every file the model declared through [present](../../implemented/feature/2026-09-08-present-workspace-source-files.md) previews it in the Sidebar and opens it natively. A file the turn both changed and delivered appears in both, and the second appearance tells the user nothing new; the recorded `changed-files-turn` scenario shows four files as four rows and four cards.

The two surfaces differ in what they offer and how long they live. The row carries counts and the comparison; the card carries the model's description, the preview, and the native actions. The card's content lives only in the Host process, so a conversation reopened after a Host restart has no changed-files card, while `deliverables/presented` events persist in the Session log and their cards come back.

## Proposal

Render a file the turn both changed and delivered once, on its delivery card. The changed-files card drops that file's row and keeps its header, which still names the turn's complete file count and summed counts and still opens the review on the turn; when every changed file was delivered only the header remains. The delivery card gains the file's added and deleted lines, or its binary or oversized label, beside the file name, and that label opens the review tab on the file, so the comparison, the preview, the native actions, and the description stay available from one place. Files only changed or only delivered render as before, and turns never share data.

Matching is lexical, on the Client, at render time: separators normalized to `/`, `.` segments dropped, `..` folded, and an absolute path under the Session working directory stated relative to it. Repeated deliveries of one file in a turn merge under the same key, keeping the latest description. Two spellings that meet only through a symbolic link stay distinct.

Nothing durable changes: no Session event, no Host route, and no recorder change; the merge lives in `packages/client/ui-deliverables` beside the card derivation. After a Host restart the changed-files card is absent and the delivery cards render as today, without a special case.

## Alternatives considered

**Keeping the row and dropping the card** costs less code, but turns a deliverable's default entry from the preview into the comparison: a report or SVG becomes one diff row, and a binary deliverable becomes a `binary` label with no preview at all.

**Asking the model not to `present` files the changed-files card will list** cannot work: the `workspace/changes` event is never model-visible and its coverage depends on git, ignore rules, the file cap, and temporary-directory exclusion; `present` is shared by the `standard`, `ptc`, and `cordis` presets whose headless and SDK consumers have no changed-files card; and after a Host restart an undelivered file has no entry at all. The tool description also requires delivering every requested output, which the [delivery decision](../../implemented/feature/2026-09-08-present-workspace-source-files.md) settled.

**One combined card** that lists every changed file with delivery actions on the delivered rows would merge two surfaces with different lifetimes into one and reopen the card design; the proposal keeps both surfaces and moves only the duplicate.

## Acceptance criteria

- A file both changed and delivered in one turn renders one delivery card and no changed-files row; the header count and totals still cover it.
- The delivery card shows the file's counts, and that label opens the turn's review tab on the file; preview, native actions, and the description remain.
- Repeated deliveries of one file in a turn render one card; files with the same basename in different directories render separately.
- Reloading the page renders the same result as the first render; after a Host restart the delivery cards render without the changed-files card.
- The `changed-files-turn` and `present-svg` recorded scenarios and the package unit tests cover the merge.

## Risks

- A delivery spelled through a symbolic link, or with an absolute path outside the working directory that the recorder spelled differently, is not matched and renders twice; the README lists this as a known limitation.
- A changed-files card reduced to its header may read as incomplete; the header keeps the complete count so the review still lists every file.
- The counts label on a 60px delivery card competes for space with long file names; the design of that label is open until a design is agreed.
