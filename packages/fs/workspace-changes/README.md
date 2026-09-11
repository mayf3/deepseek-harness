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
| `timeoutMs` | `30000` | Milliseconds one git command may run before the turn's record is abandoned |
| `outputMaxBytes` | `8388608` | Bytes of git output retained per command; a larger diff listing abandons the record |
| `maxFiles` | `500` | Maximum files carried by one event; `total` still reports the complete count |

Every Session whose working directory lies inside a git repository and that has no subagent origin is recorded; subagent Sessions and working directories outside any repository are not. Snapshots go into the repository's object store through a private index, so the repository's own index, work tree, and refs stay untouched and the user's earlier uncommitted changes never enter a summary. Nested repositories and submodules inside the working directory are recorded as gitlinks, so their internal changes do not appear. Without git — or, on macOS, with only the developer-tools stub at `/usr/bin/git` — the plugin records nothing and logs that once.

Files the file tools changed but the snapshots do not cover are added from the hunks those tools persist with their results: files matching an ignore pattern and files outside the repository. Files under `/tmp` or the platform temporary directory are excluded unless they lie inside the working directory. Line counts for these files sum over the recorded hunks, so repeated edits to one file in a turn can count a line more than once. Changes made through shell commands outside the snapshot coverage are not recorded.

Each file carries a durable `path` — relative to the working directory inside it, absolute elsewhere — and a `display` path used for ordering and labels: the relative path, a `../` path for repository files above the working directory, a `~` path under the home directory, otherwise the absolute path. Files sort by `display` in code-unit order, which lists parent and absolute paths before the working directory's own files. The event also carries the two snapshot tree ids.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `TurnRecorder` per Session serializes its git work. `turn/start` queues the baseline: `rev-parse` locates the repository, then `add --all` into a temporary index seeded from the repository's index and `write-tree` produce the tree id. Every `tools/pre-execute` waits for that queue before a tool runs, so no mutation can precede its baseline. `tool/result` events collect the file-tool hunks. `agent/turn-stopping` records inside the turn: a second snapshot, `diff-tree -r -M --numstat` between the two trees, `check-ignore` for hunk paths inside the work tree, and the appended event. `turn/end` records again only when tool results settled after the last record, which covers aborted, failed, and steered turns; an empty list after an earlier record supersedes it. The repository's index is only read.

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

- Snapshot trees are unreferenced objects, so a repository's garbage collection removes them after its prune expiry; the recorded counts survive, the trees needed for a later full-file comparison do not.
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
