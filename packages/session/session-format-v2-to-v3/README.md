---
description: "Restore released-v2 system prompts as protected v3 messages while preserving historical requests."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

English | [中文](README.zh.md)

## Summary

This library restores released-v2 system prompts as protected v3 messages while preserving historical request meaning, source-event chronology, timestamps, message identities, and inherited ownership. Persistence consumes it through the static Session format catalog. It does not publish or modify durable files.

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

Session metadata changes only its version to 3. The stage inserts an empty `system/message` immediately after the first `step/start`, then replaces that protected head before each changed `request/header` prompt, including clears. It removes `header.system` from every request header without moving any source event. Metadata-only logs gain no head. V3 encoding and restoration accept empty system heads and reject retired `header.system`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) emits synchronously, retains coordinate mappings, message identity sets, and current prompt/lifecycle state, and expands compact runs incrementally. It derives the target inherited cut from the last inherited end-seed marker, including when an upstream stage cannot supply a cut before EOF. The [reference mapper](src/references.ts) remaps local envelope provenance/replacement ranges, command source references, compaction ranges/lists, and title message lists. Delivery watermarks, session-reference capture coordinates, workflow counters, embedded model input, and message IDs retain their original meaning. V2 delivery markers claiming V3 acceptance are rejected.

The [validator](src/validation.ts) checks system payloads, open-step ownership, and protected-head operations independently. Native V3 also admits in-history system appends, non-head replacements, and compaction of non-head system nodes. It reuses frozen ordinary relationship validation through a private view, preserving original events and IDs in the result; generated repair-ID suffixes remain historical identities, not current sequence coordinates. The [codec](src/codec.ts) shares frozen V2 physical envelope/provenance encoding. No runtime invariant companion is published because this library owns no independently observable runtime registrations or state replicas.

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

`sessionFormatV2ToV3` preserves prompt text and ordinary messages at each historical request. Empty heads produce no model message.

#### Token effect

No model-visible content is added or removed.

#### KV Cache effect

The model-message prefix remains unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No file publication** — persistence owns immutable successor publication; this package never overwrites released generations.
- **Chronology-preserving inputs** — a surface event before the first step, or a changed prompt outside an open step, is refused with `SessionFormatUnsupportedMigrationError`; moving events or inventing out-of-step system messages would violate reconstruction.
- **Audited migration vocabulary** — V2 events, including log-only Assistant attempts, and the installed message-feedback additions are classified explicitly. Agent relay attribution and file attachment metadata are preserved without interpreting their identifiers or byte counts as sequence references. Unknown events, even ignorable ones, and unknown message-source or content kinds are refused during migration because sequence dependencies cannot be inferred. Native equal-version reads retain ordinary ignorable-event admission and request-header extensions; only the retired `header.system` field is prohibited.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
