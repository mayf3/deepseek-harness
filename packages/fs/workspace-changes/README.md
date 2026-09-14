---
description: "Record each top-level turn's changed files from git working-tree snapshots as a durable workspace/changes Session event; configuration, repository requirement, and coverage rules."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-changes

English | [中文](README.zh.md)

## Summary

This plugin records which files each top-level turn changed, with per-file added and deleted line counts, as a `workspace/changes` Session event. It snapshots the working tree with git when a turn starts and when it ends, diffs the two snapshots, and adds the file-tool edits that git does not cover. Only a working directory inside a git repository is recorded. The Web changed-files card renders the event; the model never sees it.

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
| `dshHome` | `$DSH_HOME`, then `~/.dsh` | Harness home whose `workspace-changes/` directory holds one snapshot object store per repository |
| `objectStoreMaxBytes` | `1073741824` | Bytes one repository's snapshot object store may hold before it is discarded and restarted empty |
| `timeoutMs` | `30000` | Milliseconds one git command may run before the turn's record is abandoned |
| `outputMaxBytes` | `8388608` | Bytes of git output retained per command; a larger diff listing abandons the record |
| `maxFiles` | `500` | Maximum files carried by one event; `total` still reports the complete count |

Every Session whose working directory lies inside a git repository and that has no subagent origin is recorded; subagent Sessions and working directories outside any repository are not. Snapshots are written through a private index into a private object store under the Harness home, with the repository's own object store attached as a read-only alternate; the repository's index, objects, work tree, and refs stay untouched, and the user's earlier uncommitted changes never enter a summary. One store serves every Session of a repository; a Session checks its size when it first locates the repository and discards a store over `objectStoreMaxBytes`, which starts empty. Nested repositories and submodules inside the working directory are recorded as gitlinks, so their internal changes do not appear. Without git — or, on macOS, with only the developer-tools stub at `/usr/bin/git` — the plugin records nothing and logs that once.

Files the file tools changed but the snapshots do not cover are added from the hunks those tools persist with their results, or from the call's own arguments when the result persists none — a `write` that creates a file and every `str_replace_editor` mutation: files matching an ignore pattern and files outside the repository. Files under `/tmp` or the platform temporary directory are excluded unless they lie inside the repository. Line counts for these files sum over the recorded hunks, so repeated edits to one file in a turn can count a line more than once. Changes made through shell commands outside the snapshot coverage are not recorded.

Each file carries a durable `path` — relative to the working directory inside it, absolute elsewhere — and a `display` path used for ordering and labels: the relative path, a `../` path for repository files above the working directory, a `~` path under the home directory, otherwise the absolute path. Files sort by `display` in code-unit order, which lists parent and absolute paths before the working directory's own files. The event also carries the two snapshot tree ids.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `TurnRecorder` per Session serializes its git work. `turn/start` queues the baseline: `rev-parse` locates the repository and its object store once per Session, then `add --all --ignore-errors` into a temporary index seeded from the repository's index and `write-tree` produce the tree id; an unreadable file is skipped and reported through git's exit code 1, which the snapshot accepts. Each turn holds its own state object, so a record still running for an interrupted turn keeps that turn's files when the next turn starts. Every command runs with `GIT_OBJECT_DIRECTORY` pointing at the private store and `GIT_ALTERNATE_OBJECT_DIRECTORIES` at the repository's objects, so committed content is read from the repository and new objects never land there. Every `tools/pre-execute` waits for that queue before a tool runs, so no mutation can precede its baseline. `tool/call` events keep each mutation call's argument-derived hunks and `tool/result` events collect the persisted ones, preferring the latter. `agent/turn-stopping` records inside the turn: a second snapshot, `diff-tree -r -M --numstat` between the two trees, `check-ignore` for hunk paths inside the work tree, and the appended event. `turn/end` records again only when tool results settled after the last record attempt, which covers aborted, failed, and steered turns without repeating a failed attempt; an empty list after an earlier record supersedes it. The repository's index is only read.

Git runs through the `subprocess` capability with a scrubbed environment, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, the configured timeout, and bounded output. A failing step abandons that turn's record with a warning; the next turn starts afresh. Session disposal and plugin disposal abort queued work.

**Runtime invariant:** No companion is published. Event listeners are effect-owned, the Session log owns the recorded summaries, and the git object store owns snapshot trees; no independent observation can diverge from them.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web deliverables](../../client/ui-deliverables/README.md) — the changed-files card that renders this event and opens its files.
- [Subprocess capability](../../subprocess/README.md) — the seam git runs through.
- [Turn changed-files card decision](../../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.md) — snapshot design, coverage rules, the deferred shadow repository, and rejected alternatives.

<a id="model-experience"></a>
## Model Experience

None, as the recorder appends a log-only `workspace/changes` event that only clients read and registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Snapshot trees survive only until their private store exceeds `objectStoreMaxBytes` and is discarded; the recorded counts survive, the trees needed for a later full-file comparison do not.
- The store is shared by every Session of one repository. A Session that discards it while another Session is snapshotting makes that other turn warn and record nothing; the next turn starts afresh.
- Two git features still write into the repository's own git directory during a snapshot: `core.splitIndex` writes `sharedindex.*` files, and git-lfs runs its clean filter on changed files and stores their objects under `.git/lfs`.
- git 2.13 or later is required for `rev-parse --absolute-git-dir`; an unsupported repository format or another git failure abandons the turn with a warning rather than being treated as a plain directory.
- Edits the user makes during a turn are attributed to that turn.
- A working directory outside any git repository has no card; a shadow repository under the Harness home is deferred until its exclude rules can replace a missing `.gitignore` reliably.
- Hunk-based counts for files outside snapshot coverage are sums over edits, not a first-to-last diff, and cover file tools only.
- Windows paths keep native separators in `path`; `display` is always slash-separated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
