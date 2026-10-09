# Agent Note: pi-ai adapter keeps raw tool-call arguments and gates dispatch on toolcall_end

Status: implemented

English | [中文](2026-10-07-pi-ai-raw-tool-arguments.zh.md)

## Problem

pi-ai parses tool-call arguments while streaming and repairs unclosed JSON with a lenient parser. The adapter serialized the repaired object back into the harness's raw-string vocabulary, so a stream truncated after `tool_calls`/`stop` executed a partially repaired argument object. The Responses protocol adds a second provenance gap: the initial arguments prefix (`response.output_item.added`) and non-prefix final replacements (`response.function_call_arguments.done`) never appear in the delta sequence, so concatenated deltas are not the provider's final raw string, and a terminal `response.completed` without `output_item.done` leaves a tool call that was never finalized.

## Decision

The pi-ai `toolcall_end` event carries an optional `rawArguments` string that a provider captures from its authoritative final buffer before deleting it (empty string included; raw-free native-object protocols omit the field). The adapter treats that final as the only executable provenance: strict `JSON.parse` (never the lenient repair), object-only, empty string fails closed, and a `deepEqualJson` consistency guard against the parsed event object — malformed raw stays verbatim for the existing tool-argument validator. Observed deltas are kept verbatim as before, and the object-only serialization fallback remains for providers without raw strings.

A `tool-calls` finish additionally requires every started call to have been finalized by `toolcall_end`. The shared `BlockAssembler` assembles executable blocks from unclosed deltas, so an unfinalized call must not reach a dispatching finish regardless of whether its delta JSON happens to parse; `max-tokens` keeps its drop semantics and error/aborted finishes never dispatch.

## Alternatives considered

- **Serialize the parsed object, as before** — loses the provider's exact bytes and executes repaired truncations; rejected as the defect under fix.
- **Treat concatenated deltas as authoritative** — false-rejects Responses prefix/replacement streams and cannot see a replacement at all; rejected.
- **Validate only in the tool-argument validator** — the unfinalized-call path bypasses it whenever the assembled JSON is valid, which is exactly the historical execution shape.

## Consequences

- Truncated or replaced-final argument streams fail closed; valid Responses prefixes, added-only finals, done-only finals, and non-prefix replacements execute with the provider's exact bytes.
- Providers without trustworthy raw strings (Google/Vertex native objects, grammar custom-tool input, old pi-messages object-only finals) keep the fallback semantics; their parsed-object meaning is unchanged.
- Legal JSON that omits business fields (a missing graph edge, a weakened schema) remains undetectable at this boundary; schema tightening is separate work.
- Requires the coordinated `rawArguments` event field on the `@earendil-works/pi-ai` 0.82.1 line; without a patched pi-ai artifact the Responses coverage is inert and upstream coordination (earendil-works/pi, #9461 touches the same region) applies.
