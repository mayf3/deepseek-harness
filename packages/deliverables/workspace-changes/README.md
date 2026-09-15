---
description: "Summarize each top-level turn's changed files from git working-tree snapshots, announce them with a workspace/changes Session event, and serve the summary while the Session lives; configuration, repository requirement, and coverage rules."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-changes

English | [中文](README.zh.md)

## Summary

This plugin summarizes which files each top-level turn changed, with per-file added and deleted line counts: git snapshots of the working tree at turn start and turn end are diffed, and the file-tool edits git does not cover are added. Outside a git repository, or without git, the summary lists the file-tool edits only. The Session log receives one `workspace/changes` event naming the turn; the summary stays on the Host, served through the `workspaceChanges` service until the Session is disposed. The Web changed-files card renders it; the model never sees it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web bundle mounts this plugin. Mount it in any composition with the `subprocess` capability and a git executable on the Host:

```yaml
- name: '@deepseek-ai/dsh-workspace-changes'
  config:
    maxFiles: 500
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `30000` | Milliseconds one git command may run before the turn's record is abandoned |
| `outputMaxBytes` | `8388608` | Bytes of git output retained per command; a larger diff listing abandons the record |
| `maxFiles` | `500` | Maximum files carried by one summary; `total` still reports the complete count |

Every Session with a working directory and no subagent origin is recorded; subagent Sessions are not. Snapshots are written through a private index into a temporary object directory owned by the Session, with the repository's own object store attached as a read-only alternate; the repository's index, objects, work tree, and refs stay untouched, and the user's earlier uncommitted changes never enter a summary. Session disposal removes the directory. Nested repositories and submodules inside the working directory are recorded as gitlinks, so their internal changes do not appear. A working directory outside any git repository takes no snapshots. Without git — or, on macOS, with only the developer-tools stub at `/usr/bin/git` — no repository is located either, and the plugin logs that once. Either way the summary lists the file-tool edits alone, as described next, with the working directory as the workspace; shell edits are absent.

Files the file tools changed but the snapshots do not cover are added from the hunks those tools persist with their results, or from the call's own arguments when the result persists none — a `write` that creates a file and every `str_replace_editor` mutation: files matching an ignore pattern and files outside the repository. Files under `/tmp` or the platform temporary directory are excluded unless they lie inside the repository. Line counts for these files sum over the recorded hunks, so repeated edits to one file in a turn can count a line more than once. Changes made through shell commands outside the snapshot coverage are not recorded.

Each file carries a durable `path` — relative to the working directory inside it, absolute elsewhere — and a `display` path used for ordering and labels: the relative path, a `../` path for repository files above the working directory, a `~` path under the home directory, otherwise the absolute path. Files sort by `display` in code-unit order, which lists parent and absolute paths before the working directory's own files. The `workspace/changes` event carries only the turn number; `ctx.workspaceChanges.summary(sessionId, seq)` returns the summary the event with that sequence announced, or undefined once the Session is disposed or when this Host process never recorded it. A conversation reopened after a Host restart therefore has no card for its earlier turns.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `TurnRecorder` per Session serializes its git work. `turn/start` queues the baseline: `rev-parse` locates the repository once per Session and the Session's temporary object directory is created, then `add --all --ignore-errors` into a temporary index seeded from the repository's index and `write-tree` produce the tree id; an unreadable file is skipped and reported through git's exit code 1, which the snapshot accepts. Each turn holds its own state object, so a record still running for an interrupted turn keeps that turn's files when the next turn starts. Every command runs with `GIT_OBJECT_DIRECTORY` pointing at the temporary directory and `GIT_ALTERNATE_OBJECT_DIRECTORIES` at the repository's objects, so committed content is read from the repository and new objects never land there. Every `tools/pre-execute` waits for that queue before a tool runs, so no mutation can precede its baseline. `tool/call` events keep each mutation call's argument-derived hunks and `tool/result` events collect the persisted ones, preferring the latter. `agent/turn-stopping` records inside the turn: a second snapshot, `diff-tree -r -M --numstat` between the two trees, `check-ignore` for hunk paths inside the work tree, the appended event, and the summary kept under the event's sequence. `turn/end` records again only when tool results settled after the last record attempt, which covers aborted, failed, and steered turns without repeating a failed attempt; an empty list after an earlier record supersedes it. The repository's index is only read.

Git runs through the `subprocess` capability with a scrubbed environment, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, the configured timeout, and bounded output. A failing step abandons that turn's record with a warning; the next turn starts afresh. Session disposal and plugin disposal abort queued work, forget the summaries, and remove the temporary directory.

**Runtime invariant:** No companion is published. Event listeners are effect-owned and the recorder owns both the summaries and the snapshot trees for its Session's lifetime; no independent observation can diverge from them.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web deliverables](../../client/ui-deliverables/README.md) — the changed-files card that reads the served summary and opens its files.
- [Subprocess capability](../../subprocess/README.md) — the seam git runs through.
- [Turn changed-files card decision](../../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.md) — snapshot design, coverage rules, the deferred shadow repository, and rejected alternatives.

<a id="model-experience"></a>
## Model Experience

None, as the recorder appends a log-only `workspace/changes` event that only clients read and registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Summaries and snapshot trees live only as long as their Session in this Host process; earlier turns of a conversation reopened after a Host restart have no card. This is the decided behavior: a card whose content the Host can no longer open is not shown.
- Two git features still write into the repository's own git directory during a snapshot: `core.splitIndex` writes `sharedindex.*` files, and git-lfs runs its clean filter on changed files and stores their objects under `.git/lfs`.
- git 2.13 or later is required for `rev-parse --absolute-git-dir`; an unsupported repository format or another git failure abandons the turn with a warning rather than being treated as a plain directory.
- The first snapshot of a Session writes every untracked, non-ignored file of the work tree into the Session's temporary directory; a repository without a `.gitignore` that carries large build outputs costs that much temporary space until the Session is disposed.
- Edits the user makes during a turn are attributed to that turn.
- A working directory outside any git repository lists file-tool edits only, so shell edits are missing from its card; a shadow repository under the Harness home is deferred until its exclude rules can replace a missing `.gitignore` reliably.
- Hunk-based counts for files outside snapshot coverage are sums over edits, not a first-to-last diff, and cover file tools only.
- Windows paths keep native separators in `path`; `display` is always slash-separated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
