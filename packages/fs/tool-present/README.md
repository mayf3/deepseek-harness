---
description: "Declare workspace files as deliverables with present; configuration, Session ownership, and source-file opening."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-present

English | [中文](README.zh.md)

## Summary

Use `present` to declare final workspace files, including files created through shell commands. Users open the current source files in their default application. The tool records paths and optional descriptions without copying file contents.

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

The `standard`, `ptc`, and `cordis` agent presets mount this plugin. Call `present` with `files: [{ path, description? }]` after creating the files. Files must exist inside the Session workspace and be regular files. Missing files, directories, and paths outside the workspace fail the call.

Mount it in an agent's Cordis composition with `tools`, `fs`, and the `turnBoundary` Session projection available:

```yaml
- name: '@deepseek-ai/dsh-tool-present'
  config:
    maxFiles: 8
```

| Field | Default | Meaning |
|---|---|---|
| `maxFiles` | `8` | Positive maximum file count per call |

The file-count limit is validated at mount. The tool requires an agent Session with a workspace and an open turn. Delivery belongs to the calling Session; a parent must call `present` itself to declare files created by a subagent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool resolves paths through the configured filesystem provider and checks workspace containment and regular-file metadata without reading contents. Successful final `tools/result` notifications append `deliverables/presented`, including nested calls. A later enclosing program failure does not revoke an already completed declaration. Blocked results publish none. Each plugin instance records only calls it executed; scoped tools with the same name cannot publish through another instance.

The pure `./types` entry declares `PresentedFile` and the Session event without importing Host runtime code. The Web consumer validates persisted declarations before displaying or opening them. The event stores no Session ID, so forked history resolves relative paths against the viewed Session's workspace.

**Runtime invariant:** No companion is published. Tool and event registrations are effect-owned, and the Session log owns file declarations; the plugin maintains no independent file-content store.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — provider paths and errors.
- [Web deliverables](../../client/ui-deliverables/README.md) — source-file opening and cards.
- [Delivery decision](../../../.agents/notes/implemented/feature/2026-09-08-present-workspace-source-files.md) — Session ownership and required-on-read events.

<a id="model-experience"></a>
## Model Experience

### present

#### What the model sees

The [present schema](../../../docs/tool-catalog.md#present) asks for existing workspace files: “Declare existing workspace files as final deliverables. When a file you create or update is an output the user asked to receive, you must call present after writing it and before your final response, including files created through Bash or code execution. Mentioning its path in your reply does not replace this call. The files must already exist. The user opens the current source files; their contents are not copied or preserved.” Results report `Presented <path>` for each file; the program result and durable event contain paths and optional descriptions.

#### Token effect

One tool schema per mounted agent and one result line per delivered file. File bytes do not enter model messages.

#### KV Cache effect

The tool schema is static for the mount lifetime. Delivery result text extends the conversation without rewriting its prompt prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Path containment checks are best effort; they cannot atomically defend against a concurrent symlink replacement before the desktop application opens the file.
- Edits change what opens. Deleted or moved source files cannot be opened from their declarations.
- Session ZIP exports contain declarations, not file contents. Persistent delivery versions and copy-on-write storage are deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
