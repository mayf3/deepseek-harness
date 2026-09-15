# Agent Note: Turn changed-files card

Status: implemented

English | [中文](2026-09-11-turn-changed-files-card.zh.md)

## Problem

After a turn, users want to see which files the model changed and by how much. The Web turn tail listed only the paths of successful `write`, `edit`, and `str_replace_editor` calls, without line counts, and missed every file a shell command changed; the per-call diff cards in the message flow answered the question one call at a time.

## Decision

The Host [workspace-changes](../../../../packages/deliverables/workspace-changes/README.md) plugin summarizes each top-level turn's changed files, announces the summary with a `workspace/changes` Session event that carries only the turn number, and serves the summary through its `workspaceChanges` service until the Session is disposed; the [deliverables plugin](../../../../packages/client/ui-deliverables/README.md) reads the served summary and renders it as the changed-files card in place of the mutation-call row. The event is log-only and never model-visible.

The recorder snapshots the working tree with git at turn start and turn end: `add --all` into a private index seeded from the repository's index, then `write-tree`. Both write into a temporary object directory owned by the Session while the repository's object store is attached as a read-only alternate, so the user's repository gains no objects; keeping every captured byte outside the workspace follows the workspace change journal POC (#2973) and costs nothing measurable because the stat cache lives in the index. The two tree ids are diffed with `diff-tree -r -M --numstat`, so the summary contains exactly the turn's changes — the user's earlier uncommitted work, staged or not, is part of the baseline — and commits the model makes mid-turn cannot hide changes. The repository's own index, objects, work tree, and refs are never modified. On a 10k-file repository one snapshot costs about 60 ms and the diff about 10 ms; the baseline runs concurrently with the first model request, and tool execution waits for it.

Git is the default executable on `PATH`; no environment plugin is consulted. Outside any repository, or without git, no snapshot is taken and the summary lists the file-tool edits alone, with the working directory as the workspace, so the card still appears but misses shell edits. Nested repositories and submodules are gitlinks and are not descended into.

Changes outside snapshot coverage are handled by source. File-tool edits to ignored files and to files outside the work tree join the same list with counts summed from the hunks the tools persist with their results, or from the call's arguments when a result persists none, as a `write` that creates a file and every `str_replace_editor` mutation do; no extra baseline is captured. Files under the temporary directories are omitted unless they lie inside the working directory; a file left in `/tmp` needs `present` to reach the user. Shell edits outside coverage are a known limitation.

The list sorts by a display path in code-unit order: the path relative to the working directory, `../` for repository files above it, `~` under the home directory, otherwise absolute; parent and absolute paths therefore lead without a separate group. The card shows the total count with summed added and deleted lines in its header, three rows before a fold, and a collapse control at the bottom once expanded. With a Host desktop the header opens the deepest workspace folder containing the listed files — computed over workspace-relative paths and falling back to the workspace root — and each row opens its file in the default application; without one, rows preview in the right Sidebar.

The recorder appends inside the turn on `agent/turn-stopping` and again after `turn/end` only when tool results settled after the last record, so aborted, failed, and steered turns are covered. The Client keeps the latest announcement per turn and reads its summary once through the authenticated summary route.

The log deliberately carries nothing but the turn number. Summaries, snapshot trees, and the tree ids a later content comparison needs live only as long as the Session in the Host process: the summaries in the recorder, the objects in a temporary directory removed on disposal. A conversation reopened after a Host restart has no card for its earlier turns. The product decision is that a card whose content the Host can no longer open should not appear at all, so the card's lifetime equals the content's lifetime rather than the log's. Whether to keep content across restarts, and for how many turns, is left to #3822.

## Alternatives considered

**Extending the mutation-call row with hunk counts** kept a second, weaker implementation beside the per-call diff cards and still missed shell edits; git sees every write regardless of the tool.

**Diffing against `HEAD` at turn end** needs one command but attributes the user's uncommitted work to the turn.

**A git tag or `stash create` per turn** leaves refs in the user's repository or omits untracked files; a tree written through a private index does neither.

**A pure-JavaScript git or a bundled binary for hosts without git** adds megabytes and a platform matrix for users who mostly run without the card; until git exists the card lists file-tool edits only.

**Recording the pre-edit file content at first touch** would make hunk counts exact and enable full-file diffs for uncovered files, but requires the file tools to hand their pre-read content to the recorder; the persisted hunks already carry the before and after text of each edit for that purpose.

**Recording the file list and counts in the event** was the first implementation: the card would then render from the log forever, while the content it opens would not survive. It was replaced by the announcement-only event so that the card and its content share one lifetime.

**A snapshot object store under the Harness home with a byte bound** was the first implementation's placement: one store per repository, shared by every Session, discarded when it outgrew the bound. It survived Host restarts that the summaries no longer do, needed two configuration fields, and made a Session's snapshot fail when another Session discarded the store; a per-Session temporary directory removes all three.

**An environment-provider seam for locating git** was raised by the team but not settled; the plugin uses `PATH` and keeps its lookup in one place.

**A shadow repository for working directories outside any repository** — a git directory under the Harness home with the work tree pointing at the working directory — would add shell edits to those users' card without adding a `.git`, but a shadow repository has no `.gitignore`, and a configured exclude list cannot reliably keep build outputs, caches, and dependency trees out of every project layout. It is deferred until that exclude policy is settled; the recorder already treats the repository as an input, so adding the tier changes only where the snapshot goes.

## Consequences

Every turn with tool results costs two snapshots and one diff on the Host, and writes blob and tree objects for the changed files into the Session's temporary directory, which disposal removes. Edits the user makes during a turn are attributed to it. Hunk-based counts for uncovered files are sums over edits rather than a first-to-last diff.

The Web bundle alone mounts the recorder, so headless, SDK, and ACP logs are unchanged; recorded Web scenarios gain the event and the card only when their workspace is a git repository, which one dedicated scenario seeds. The card replaces the Chinese and English "Files changed" row; prose file mentions still resolve against mutation-call paths and deliveries.

Focused tests cover repositories with real git, directories outside any repository, coverage classification with the metadata the tools really persist, an interrupted turn overlapped by the next, ordering, caps, disposal, the macOS stub, the changed-file and folder routes, the card's fold and gesture states, and a Loader composition. The keyless Web scenario replays the recorder end to end, including a created file the repository ignores.
