# Agent Note: Incremental tool-argument scanning and argument order during preparation

Status: implemented

English | [中文](2026-09-24-preparing-tool-arguments.zh.md)

## Problem

[Three-stage tool calls](2026-09-22-tool-call-three-phases.md) make tool identity visible before `tool/call`. A raw argument prefix alone cannot supply field-aware presentation: write/edit need a complete path and decoded content length, while bash/run_code need the description before the command or program finishes streaming.

The order in which the model generates arguments also decides what can appear first. On 2026-09-24, 310 controlled requests against the real DeepSeek V4 API exercised bash/run_code/write/edit:

| Variant | Change | bash first key is description | run_code first key is description |
|---|---|---|---|
| Baseline | — | 0/20 | 1/20 |
| `properties` order only | description moved first | 0/20 | 0/20 |
| `properties` + `required` together | Same plus reordered `required` | Forced tool_choice 10/10; free calling Pro 7/10, Flash 0/10 | Forced 10/10; free 20/20 |
| Together + one ordering instruction in the description text | Appends "Provide `description` before `command` in the arguments." | Free calling Flash 19/20, Pro 20/20 | 20/20 |

In these samples, reordering `required` changes argument order where reordering `properties` alone does not; V4 Flash's free bash calls also need the explicit instruction. The `dsh-tools` schema DSL generates `required` in property declaration order, so changing the declaration order in source reorders both. The probe uses a minimal system prompt, not the complete Harness prompt.

## Decision

### A lazily computed argument view lives in `dsh-util-values`

`PartialArguments` is a lazily computed class that knows no tool. It holds the raw text (the accumulated deltas while preparing; the event's string after `tool/call`; the event's object for a PTC child) and a level-one index, and any reader (`has`, `complete`, `stringLength`, `text`, `value`, `keys`) resumes scanning from the last consumed position only when called; with no reader, not one character is scanned. Text is decoded on demand from the raw slice, so no specification of "which fields keep text" and no registry is needed.

Scanning indexes only unread fragments. Indexing the cumulative source after every append would repeatedly flatten V8 concatenation strings even with a forward cursor; the cumulative source is retained for field slices, not for the scan loop.

The view judges change itself: it remembers every question it answered, and `append(delta)` recomputes only those, returning true only when an answer differs; with nothing read yet it is always false. The business states its granularity as it reads: `stringLength('content', { step: 1024 })` makes only a kilobyte crossing count, `text('description')` makes every character count. An `offset` includes completed strings when edit progress combines old and new text.

### Parsing happens in the Tool Definition, not in React

The [Tool Definition](../../../../packages/client/ui-chat/src/client/conversation-nodes/tool.ts) matches every `tool-call-delta` carrying an id as a start candidate: the earliest opens the Context whether or not it is named, later ones fold as updates. The named delta creates the preparing root with a fresh streaming view; every delta only calls `args.append(delta)`, and the root reference is replaced only when the view reports a change. Publication keeps the `animation-frame` cadence. A stream whose arguments precede the name is not scanned: a view opened late sees a non-object prefix, turns invalid, and reports no fields.

Every stage's block exposes `name` and `args`; legacy `argsRaw` and result `call: { name, argsRaw } | null` remain available. Dispatched roots use `PartialArguments.fromText(argsRaw)`, PTC children use `fromObject(payload)` without stringifying, and results reuse the started view. An unpaired root result has an empty name and shared empty view. Card models continue to read `argsRaw`.

Rows use the same readers across stages: read/write/edit show an openable path once `file_path` closes; write/edit show decoded content length in 1024-character units while content streams; bash/pwsh/run_code show the description prefix. Chat group detail reads the same view using its existing field priority. Without usable detail it stays empty while fields can still arrive, then falls back to the tool name once `closed()` is true, for every category.

Third-party tools receive the same view without registration or a separate subscription. Write/edit and Bash share their component across stages. The mutable argument reader is a narrow exception to JSON-compatible owner data: its Definition publishes a new block reference when an observed answer changes. Scan caches use private fields so read history does not affect structural comparison of equal sources.

### Argument declaration order

`tool-bash` and `tool-pwsh` declare `description` before `command` and include the ordering instruction; both `parameters` declarations of `run_code` put `description` before `code` without an instruction. `file_path` is already first for write/edit/read. Other tools retain their argument order.

## Alternatives considered

**Parse inside a hook closure (a selector subscribing to the Step source).** Only the subscribing row sees the parsed result, so group titles need another subscription and each row owns parser lifetime. Definition-owned views share parsed fields across consumers.

**Keeping a per-tool field specification in the Definition (built-in table plus a runtime registry).** The Definition is a pure function without ctx, so a runtime registry could only reach it through a factory closure, and a third-party tool would register in two places, the slot and the registry; the specification only ever said which fields keep text, information that on-demand decoding from the raw text no longer needs.

**Third-party `partial-json`.** It reparses the cumulative input each frame and does not expose string completion separately from the decoded value.

**Eagerly parse every field.** Large fields such as `content` usually need only a length; eagerly materializing their text adds decoding and memory costs before a consumer asks for it.

**Slice the normalized field for a truncated detail.** A V8 substring can retain the entire field. Joining the bounded selection of grapheme clusters keeps the displayed prefix independent of that source.

**Reorder `properties` only.** Measured 0/40 effective; the model follows the `required` order.

## Verification

- Parser tests cover lazy scanning, observed-answer changes, empty and repeated keys, split escapes, non-string values, invalid input, sealed views, and read-independent structural equality.
- Row and grouping tests cover streamed paths and descriptions, content length, shared row identity, name fallback only when arguments cannot grow, and a 161-cluster traversal limit without changing whitespace or Unicode handling.

The required [conversation-fold benchmark](../../../../benchmarks/conversation-fold/conversation-fold.bench.client.ts) drives the real Tool Definition, Assembler, and Chat groups with 16-character fragments, flushing every 64 fragments. Three fresh compiled Node workers report all samples and their median; setup and forced GC are outside timing, and retained heap is measured with the Assembler and argument view still reachable. On Linux x64, AMD EPYC 7763, Node 24.18.0:

| Workload | Optimized samples (ms) | Reintroduced cumulative indexing and full segmentation (ms) | Time / retained-heap budget |
|---|---|---|---|
| 512 KiB write content | 295.3, 282.9, 277.7 | 4035.5, 4035.5, 3984.9 | 750 ms / 37.5 MiB |
| 128 KiB command before description | 144.0, 141.9, 145.3 | 1494.9, 1486.0, 1471.2 | 375 ms / 10 MiB |

Reference expectations are 300/150 ms and 30/8 MiB. The shared 2× CI time scale and 1.25× headroom apply to time; only headroom applies to heap. Both negative controls exceed their time budget. These are local Node measurements, not CI-runner, model, network, or browser-paint latency; whitespace normalization still scans the whole field.

## Consequences

- Observed argument changes replace preparing blocks; unread calls retain their block reference. Views retain source text, and group headers can request fields independently of tool rows. Started and settled views scan on first read without publishing updates.
- Model ordering is probabilistic: the reorder and the description sentence raise description-first to about 100% but are not a contract; the row logic shows whichever field closes first, so a reversed order only loses the benefit.
- Presentation remains Client-derived; argument scanning adds no Session event or persistence format.
- A stream whose name arrives after its arguments gives up scanning; that call's preparing row falls back to the title alone.
