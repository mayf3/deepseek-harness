# Agent Note: Bound in-flight binding calls, snapshot binding metadata, and compact the reply queue in the CPython backend

Status: implemented

English | [中文](2026-08-29-code-runtime-python-call-backlog-and-binding-metadata-snapshot.zh.md)

## Problem

A further review round on the CPython subprocess backend (packages/experimental/code-runtime-python) surfaced three findings on the binding-dispatch and validation paths. First, the reply-backlog cap counts only RESOLVED calls — `pendingReplies` grows after the binding's `await` resolves — so a child flooding calls against a binding whose promise never settles accumulates one async closure per frame until the wall clock without ever tripping the cap. Second, `validateBindings` reads `errorClass.name`, `errorClass.memberNameProperty`, and `namespace.global` several times and retains the original errorClass object for the boot frame, whose `JSON.stringify` re-reads it after validation: a getter that returns a valid value during validation and then throws or returns a conflicting value at stringify time turns the seam-misuse rejection into a worker-exit, or injects a different name than validation approved. Third, `replyQueue` never shrinks mid-drain: the drain loop clears consumed slots to `undefined` but leaves `length` (and the backing store) growing, so a child that reads replies just fast enough to keep the drain alive but never empty grows the array linearly with cumulative throughput.

## Decision

### In-flight binding calls are capped at 1024

`case 'call'` counts the outstanding binding calls before dispatch (`pendingCalls`) and releases the slot in the async body's `finally`, covering the reply-written, resolution-rejected, and settled-drop exits. When the count reaches `MAX_PENDING_REPLIES`, the run settles as a `worker-exit` with a call-backlog message, bounding in-flight closures exactly like the reply backlog. This is a count bound, not a byte bound.

### Binding metadata is snapshotted into plain values before validation and the boot frame

`validateBindings` reads `namespace.global`, `errorClass.name`, and `errorClass.memberNameProperty` each exactly once into a plain local, validates the copies, and stores a plain `{ name, memberNameProperty }` object in the bindings map. The boot frame serializes that stored copy, so validation and the boot frame see identical values regardless of getter state; a stateful getter cannot change or throw between the two stages.

### The reply queue compacts its consumed prefix mid-drain

`drainReplies` compacts the consumed prefix (`replyQueue.splice(0, head); head = 0`) once `head` reaches `MAX_PENDING_REPLIES`. The splice is O(head) once per bound of consumed frames — amortized O(1) per reply — bounding the backing store to O(backlog + bound) for a drain that never empties.

## Testing

- `tests/runtime.spec.ts` — a hostile child floods 5000 sequential calls against a binding that never settles (`await new Promise(() => {})`); the run settles as `worker-exit` with the call-backlog message long before `maxWallMs`. Verified fail-before: without the cap the run times out at the wall clock.
- Two namespace-shape tests — `errorClass.name`/`errorClass.memberNameProperty` and `namespace.global` exposed through getters that throw or change on a second read; the run boots and completes, and each field is read exactly once (asserted). Verified fail-before: without the snapshot, the errorClass getter threw inside validation and the global getter injected a different name, failing the program with `NameError`.
- `tests/runtime.spec.ts` — a child floods calls whose replies exceed the writable high-water mark, blocking the first drain write; the resumed drain consumes a backlog past the compaction bound while a second wave of calls is still pending, and the child reads fd 3 itself (blocking the reply pump) to verify all 1524 replies arrive. Verified fail-before: a splice that removed pending frames dropped the second wave and the run hung to the wall clock.

## Alternatives considered

**Pause the fd-3 read side instead of counting in-flight calls.** Rejected: pausing reads would also stall processing of `done` and `log` frames the child may send after its last call, changing settlement timing; a count cap is deterministic and matches the existing frame-cap pattern.

**Read metadata once but keep the original errorClass object.** Rejected: the boot frame's `JSON.stringify` re-invokes the getters; only a plain stored copy guarantees both stages read the same values.

**Rely on the drain's `finally` reset for queue memory.** Rejected: the reset runs only when the drain ends; a drain that never empties keeps growing. Mid-drain compaction bounds the backing store while the drain is alive.

## Consequences

In-flight binding closures are bounded like the reply backlog, so a child flooding calls against a never-settling binding fails the run early instead of accumulating closures until the wall clock. The boot frame serializes exactly the metadata validation approved, regardless of getter state. The reply queue's backing store stays bounded during sustained partial drains; the compaction is internal memory hygiene with no observable behavior change.
