---
description: "Restore released-v2 system prompts as protected v3 messages and canonicalize envelopes while preserving historical requests."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

English | [中文](README.zh.md)

## Summary

This library restores released-v2 system prompts as protected v3 messages, canonicalizes event envelopes, and translates durable PTC vocabulary. It preserves historical request meaning, source-event chronology, timestamps, message identities, and inherited ownership while remapping audited sequence references. Persistence consumes it through the static Session format catalog. It does not publish or modify durable files.

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

The header version becomes 3. The exact legacy preset id `code` becomes `ptc` in `header.agentPreset` and every `agent-preset/selected.data.agentPreset`, including inherited selections. Other preset ids and absent header presets remain unchanged; a selection without a string preset id is refused. The structural stage inserts an empty `system/message` immediately after the first `step/start`, then replaces that protected head before each changed `request/header` prompt, including clears. It removes `header.system` from every request header without moving any source event. Metadata-only logs gain no head.

After structural insertion and reference remapping, canonicalization renames exact replacement objects on both original and synthetic envelopes from `{ op: 'replace', start, end }` to `{ op: 'replace', startSeq, endSeq }` and omits `tools: []` and `adapterDefaults: {}` from request headers. This final canonicalization preserves its input event count, coordinates, timestamps, order, and inherited cut; the preceding structural stage changes event count, sequences, audited references, and cuts. Whitespace-only system content, `config.stop: []`, and nested header/source/data extras remain intact.

All four surface types (`system/message`, `user/message`, `assistant/message`, `tool/result`) require `surfaceOp`; only assistant messages forbid `sourceEventSeqs`. Replacement endpoints name an inclusive span in current surface order, not numeric sequence order. Known log-only events forbid both surface metadata fields. Native unknown or obsolete ignorable envelopes remain opaque. A `tool/result` carrying `data.error` requires its tool-result block to have `isError: true`; failed results may omit error identity. Missing placement, extra replacement keys, aliases, and contradictory outcomes are refused, never repaired. Native V3 rejects every `header.system` and noncanonical empty header optionals.

Use the [public exports](src/index.ts) through catalog assembly: the migration, source and target codecs, target header validator, and target restorer. Event-local checks do not define a complete schema for plugin-owned payloads.

The stage maps `tool/code-dispatch-start` and `tool/code-dispatch` to `tool/ptc-dispatch-start` and `tool/ptc-dispatch`. It replaces the exact `tools-code-mode` plugin attribution with `tools-ptc` in user messages, inbox insertions, and title-request messages, without rewriting IDs, tool arguments, or content. Native V3 rejects required predecessor PTC tags, including after recoverable row corruption; ignorable predecessor tags remain opaque and cannot satisfy current PTC relationships. Reserved V3 PTC tags in V2 source input are refused even when ignorable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) emits synchronously, retains coordinate mappings, message identity sets, and current prompt/lifecycle state, and expands compact runs incrementally. It derives the target inherited cut from the last inherited end-seed marker, including when an upstream stage cannot supply a cut before EOF. The [reference mapper](src/references.ts) remaps local envelope provenance/replacement ranges, command source references, compaction ranges/lists, and title message lists. Delivery watermarks, session-reference capture coordinates, workflow counters, embedded model input, and message IDs retain their original meaning. V2 delivery markers claiming V3 acceptance are rejected.

The [validator](src/validation.ts) checks canonical envelopes, system payloads, open-step ownership, and protected-head operations independently. Native V3 also admits in-history system appends, non-head replacements, and compaction of non-head system nodes. Frozen ordinary relationship validation receives a private system/PTC/repair view composed with the canonical-endpoint view; the result retains the original V3 events, IDs, and actual target generation. Generated repair-ID suffixes remain historical identities, not current sequence coordinates. Frozen v0-to-v1 and v1-to-v2 semantics remain unchanged.

The [codec](src/codec.ts) shares frozen V2 physical framing and provenance encoding and validates V3 event-local rules before encoding and after decoding. Raw structural and unsupported-event refusal precede recoverable decoding and cannot be hidden by suffix recovery. Strict reads reject canonical format errors immediately; committed-prefix recovery withholds an invalid suffix and rejects it if a later `turn/end` establishes a commit. [Admission tests](tests/admission.spec.ts) cover malformed durable payloads, repair identities, protected-head violations, and compaction reference remapping. No runtime invariant companion is published because this library owns no independently observable runtime registrations or state replicas.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released v1 to v2](../session-format-v1-to-v2/README.md) — frozen source codec and event validation.
- [Session format protocol](../session-format/README.md) — adjacent streaming stages.
- [Canonical V3 envelope decision](../../../.agents/notes/implemented/architecture/2026-09-06-v3-canonical-session-envelopes.md) — exact conversion and refusal rationale.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

`sessionFormatV2ToV3` preserves prompt text and ordinary messages at each historical request. Empty heads produce no model message. PTC plugin-source attribution uses `tools-ptc`; log-only dispatch events do not add model messages.

#### Token effect

No message content is added or removed.

#### KV Cache effect

The stage does not change message content or model configuration.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Historical preset ownership** — `code` in released V0/V1/V2 preset references denotes the legacy built-in preset. Those logs cannot distinguish a custom preset with the same id; native V3 references are not reinterpreted. This library does not migrate `settings.yaml`.
- **No file publication** — persistence owns immutable successor publication; this package never overwrites released generations.
- **Chronology-preserving inputs** — a surface event before the first step, or a changed prompt outside an open step, is refused with `SessionFormatUnsupportedMigrationError`; moving events or inventing out-of-step system messages would violate reconstruction.
- **Audited migration vocabulary** — V2 events, including log-only Assistant attempts, and the installed message-feedback additions are classified explicitly. Agent relay attribution and file attachment metadata are preserved without interpreting their identifiers or byte counts as sequence references. Unknown events, even ignorable ones, and unknown message-source or content kinds are refused during migration because sequence dependencies cannot be inferred. Native equal-version reads retain ordinary ignorable-event admission and nested extensions; retired `header.system` and required predecessor PTC tags are prohibited.
- **No semantic repair** — invalid released records and contradictory tool outcomes refuse restoration; the converter never supplies missing placement on source events or rewrites unrelated payloads.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
