---
description: "Deliver immutable snapshots of workspace files with the present tool; configuration, Session ownership, and download prerequisites."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-present

English | [中文](README.zh.md)

## Summary

Use `present` to deliver final workspace files, including files created through shell commands. Each successful call saves immutable bytes, so users can download the delivered version after source edits or deletion. The calling Session owns the delivery; the Web deliverables plugin supplies download links and cards.

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

The `standard`, `ptc`, and `cordis` agent presets mount this plugin. Call `present` with `files: [{ path, description? }]` after creating the files. Files must exist inside the Session workspace and be regular files. Missing, oversized, outside-workspace, or concurrently modified files fail the call.

Mount it in an agent's Cordis composition with `tools`, `fs`, `attachments`, and the `turnBoundary` Session projection available:

```yaml
- name: '@deepseek-ai/dsh-tool-present'
  config:
    maxFileBytes: 104857600
    maxFiles: 8
```

| Field | Default | Meaning |
|---|---|---|
| `maxFileBytes` | `104857600` | Positive per-file byte cap, at most 100 MiB |
| `maxFiles` | `8` | Positive maximum file count per call |

Limits are validated at mount. The tool requires an agent Session with a workspace and an open turn. Delivery belongs to the calling Session; a parent must call `present` itself to offer its own download links for files created by a subagent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The tool resolves paths through the configured filesystem provider, checks workspace containment and versions around bounded reads, and saves bytes through the attachment service. Successful final `tools/result` notifications append `deliverables/presented`, including nested calls. A later enclosing program failure does not revoke an already completed delivery. Blocked results publish no delivery. Each plugin instance records only snapshots from calls it executed; scoped tools with the same name cannot publish through another instance.

The pure `./types` entry declares `PresentedFile` and the Session event without importing Host runtime code. The Web consumer validates persisted references before displaying them or authorizing downloads. The event stores no Session ID, so forked history authorizes downloads through the viewed Session.

**Runtime invariant:** No companion is published. Tool and event registrations are effect-owned; the attachment service owns immutable bytes, and the Session log owns delivery references.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — provider paths and errors.
- [Attachment service](../../attachment/attachment/README.md) — saved bytes and retention.
- [Web deliverables](../../client/ui-deliverables/README.md) — authenticated downloads and cards.
- [Delivery decision](../../../.agents/notes/implemented/feature/2026-09-08-web-explicit-file-delivery.md) — Session ownership and required-on-read events.

<a id="model-experience"></a>
## Model Experience

### present

#### What the model sees

The [present schema](../../../docs/tool-catalog.md#present) asks for existing workspace files: “Deliver final files to the user. Saves a snapshot of each existing workspace file so it remains downloadable after edits or deletion. Create the files before calling this tool.” Results report `Presented <path> (<bytes> bytes)` for each file; attachment IDs remain in the program result and durable event.

#### Token effect

One tool schema per mounted agent and one result line per delivered file. File bytes do not enter model messages.

#### KV Cache effect

The tool schema is static for the mount lifetime. Delivery result text extends the conversation without rewriting its prompt prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Containment and before/after version checks reject ordinary changes, but the path API cannot atomically defend against malicious swap-and-restore.
- Files saved before a failed call can remain unreferenced in the attachment store.
- Session ZIP exports retain delivery references in JSONL and omit delivered bytes. Downloads after transfer require the same snapshots in the serving host's attachment store.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
