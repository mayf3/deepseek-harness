---
description: "Restore released-v2 Session logs as v3 without changing their events."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

English | [中文](README.zh.md)

## Summary

This library restores released-v2 Session records as v3 while preserving event payloads, sequence references, timestamps, ordering, and inherited prefixes. Persistence consumes it through the static Session format catalog. It does not publish or modify durable files.

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

The header version becomes 3; all other header fields remain unchanged. The stage forwards events and compact runs synchronously, but refuses source delivery markers whose `sessionFormatVersion` is 3 because promotion would activate an unconfirmed target-generation watermark. Scalar inherited end-seed markers determine the exact cut at EOF. V3 record encoding and validation reuse the frozen released-v2 implementation without modifying it. Unknown required events remain refusals; installed event types and ignorable unknown events retain their admission rules.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) tracks the inherited cut and source delivery ownership without changing event values. The [codec](src/codec.ts) changes physical header versions and shares v2 record encoding. The [validator](src/validation.ts) checks the v3 version before applying released-v2 event validation. No runtime invariant companion is published because this library owns no independently observable runtime registrations or state replicas.

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

`sessionFormatV2ToV3` preserves every model-visible event and its payload.

#### Token effect

No model-visible content is added or removed.

#### KV Cache effect

The model-message prefix remains unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No file publication** — persistence owns immutable successor publication; this package never overwrites released generations.
- **Identity conversion only** — the stage introduces no structural event transformations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
