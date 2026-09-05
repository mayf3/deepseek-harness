---
description: "Loader patch-list files: the shared parser for cordis.patch.yml layers and a comment-preserving key-level writer with lock, atomic replace, and readback."
kind: "package-reference"
---

# @deepseek-ai/dsh-patch-file

English | [中文](README.zh.md)

## Summary

`dsh-patch-file` owns the file format every composition layer of the harness is written in: a `cordis.patch.yml` is a top-level YAML sequence of Loader patch entries — id-targeted overrides such as `disabled: true` or a `config` replacement, and `insert` lists of new rows — in the Loader's own dialect, where a `!!js` scalar is an expression the row's fiber evaluates. `parsePatchList` is the one parser the profile launcher, bundle layers, `--patch` overlays, and agent-preset user layers read through, so a file one of them accepts is a file all of them accept. `PatchDocument` edits such a file at the key level while keeping its comments, blank lines, and `!!js` scalars as the author wrote them, and `mutatePatchFile` commits one edit under the cross-process writer lock, through an atomic replace, and reads the written text back through the parser before reporting what every reader will now load.

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

Read a patch layer with `parsePatchList` (text in hand) or `readPatchListFile` (absent file reads as `undefined`). Both anchor a relative `insert` row name such as `./plugin.js` to the file's own directory and fail loud on anything that is not a sequence of mappings, because a patch file that cannot be applied at all is a misconfiguration; a patch whose target row is absent stays a per-entry Loader warning.

Write through `mutatePatchFile`. The callback receives a `PatchDocument` and edits it by row id, the way the Loader addresses rows:

```ts
import { mutatePatchFile } from '@deepseek-ai/dsh-patch-file'

const file = '/home/me/.dsh/profiles/web/cordis.patch.yml'
await mutatePatchFile(file, (document) => {
  document.setRowField('tool-web', 'disabled', true)      // the id-targeted patch is created when absent
  document.deleteRowField('tool-web', 'config')           // a patch reduced to its id is removed whole
  document.appendInsert({ id: 'tool-foo', name: 'dsh-tool-foo' })          // into the root list
  document.appendInsert({ id: 'sql', name: 'dsh-sql' }, 'agents')          // into the group with that id
  document.removeInsert('tool-foo')                       // an emptied insert patch is removed whole
}, { binName: 'dsh', mode: 0o600, dirMode: 0o700 })
```

`setRowField` never accepts `id` or `insert`; `rowField` reads one key back, with a `!!js` scalar returned as its source text. `appendInsert` refuses an id the file already inserts, and `insertedRow`/`removeInsert` find rows inside inserted groups too. Values written are plain data; a `!!js` scalar on another key is left untouched, which is what lets a user layer revert a `disabled: true` it wrote without disturbing a bundle's `!!js` gate on a different row.

`mutatePatchFile` takes the `<file>.lock` sibling the way `dsh-atomic-write` does, reads the file (absent reads as empty), applies the edit, replaces the file atomically with the stated permission bits when the text changed, and returns the patch list as re-read from the written text. An edit that changes nothing writes nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Two parsers, one dialect

Reading uses `js-yaml` with the include's `entryListSchema`, so `!!js` scalars become the expression nodes the Loader interpolates, exactly as the include mounts them. Writing uses the `yaml` package's comment-preserving `Document`: it keeps the unresolved `!!js` tag on the scalar it decorates (reported as a `TAG_RESOLVE_FAILED` warning, not an error) and prints it back verbatim, so an edit to one key never rewrites another key's expression. The written text is parsed back with the reading parser, which is the readback the writer's contract promises.

### Addressing

An id-targeted patch is the top-level item whose `id` matches and that carries no `insert`. An inserted row is searched in every `insert` list, recursing into inserted groups (`group: true` with a `config` list). A top-level item that is not a mapping, or an `insert` whose value is not a list, fails the parse.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `parsePatchList`, `readPatchListFile`, `anchorInsertedPluginNames`, `PatchDocument`, `mutatePatchFile` |
| — | No runtime invariant companion is published; the package holds no runtime state, and its file contract is pinned by unit tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the file format's place in the composition is the question.

- [App boot](../../boot/app-boot/README.md) — the profile launcher that composes bundle layers, user layers, and overlays from these files.
- [Cordis include plugin](../../../vendor/include/README.md) — `applyEntryPatches`, the patch semantics every layer is applied with.
- [Agent presets](../../preset/agent-presets/README.md) — the per-preset user layer written in this format.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package only reads and writes composition patch files; the rows they name own every model-facing registration.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the writer will not do to a file. They are current package constraints, not a task backlog.

- **Key-level, not row-level, merging** — `setRowField('x', 'config', value)` replaces the whole `config` mapping of that patch; a caller that wants one nested field changed reads the current value with `rowField` and writes the merged mapping back.
- **No expression authoring** — the writer emits plain data only; a `!!js` gate is something an author types into the file, never something an API call produces.
- **Lock orphans are an operator action** — a lock file left by a crashed writer is never removed by a contender, which fails after the wait instead; `dsh-atomic-write` documents the same choice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
