---
description: "Restore released-v2 Session logs as v3 with current PTC event names and preserved historical identities."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

English | [中文](README.zh.md)

## Summary

This library restores released-v2 Session records as v3 by translating durable PTC event names and plugin-source labels. It preserves every historical id, event order, sequence reference, timestamp, and inherited cut. Persistence consumes it through the static Session format catalog. It does not publish or modify durable files.

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

### When to use it

Use the [catalog](../session-format-catalog/README.md) for restoration. Direct imports serve catalog assembly and tests; this library is not mounted in a Cordis composition.

### Entry point

```text
const targetHeader = sessionFormatV2ToV3.migrateHeader(sourceHeader)
```

The header version becomes 3; all other header fields remain unchanged. The stage synchronously maps `tool/code-dispatch-start` and `tool/code-dispatch` to `tool/ptc-dispatch-start` and `tool/ptc-dispatch`. It maps the exact `tools-code-mode` plugin label to `tools-ptc` only in plugin-kind sources at `user/message.data.source`, `agent/inbox/spliced.data.inserted[].source`, and `session/title-llm-request.data.messages[].source`. Every other value remains unchanged, including ids containing `:code:`, message content, tool arguments, and opaque payloads.

V3 validation accepts current PTC tags, not required legacy aliases. Unknown events marked `ignorable` retain their admission policy, except that source-v2 `tool/ptc-dispatch` and `tool/ptc-dispatch-start` events are rejected even when ignorable: these names are reserved in v3, so migration cannot reinterpret an opaque extension as a PTC lifecycle event. Physical record encoding remains the released-v2 encoding; only the header version and the named logical fields change.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) applies the bounded PTC transformation while tracking inherited cuts and source delivery ownership. Scalar inherited end-seed markers determine the exact cut at EOF. The [codec](src/codec.ts) shares frozen v2 physical record encoding. The [validator](src/validation.ts) checks v3 event admission and relationships without modifying frozen predecessor modules. No runtime invariant companion is published because this library owns no independently observable runtime registrations or state replicas.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released v1 to v2](../session-format-v1-to-v2/README.md) — frozen source codec and event validation.
- [Session format protocol](../session-format/README.md) — adjacent streaming stages.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

`sessionFormatV2ToV3` preserves message content and tool results. PTC plugin-source attribution uses `tools-ptc`; log-only dispatch events do not add model messages.

#### Token effect

No message content is added or removed.

#### KV Cache effect

The stage does not change message content or model configuration.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No file publication** — persistence owns immutable successor publication; this package never overwrites released generations.
- **Bounded conversion only** — only the named event tags and plugin-source slots are transformed; arbitrary strings, unknown payloads, and historical ids are not rewritten.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
