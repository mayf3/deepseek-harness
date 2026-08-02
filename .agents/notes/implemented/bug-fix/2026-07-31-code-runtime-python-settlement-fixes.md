# Agent Note: Three settlement and framing fixes in the CPython backend

Status: implemented

English | [中文](2026-07-31-code-runtime-python-settlement-fixes.zh.md)

## Problem

The [CPython subprocess backend](2026-07-17-code-runtime-python.md) for Code Mode
resolves every program outcome as a `CodeRunResult` and rejects `run()` only for
seam misuse. Three defects broke that contract in ways unit coverage did not
surface, because each hid behind a `/* v8 ignore */`, a captured-callable
comment that read as a fix but was not, or a memory effect invisible through the
seam. They were found by review of the backend as it stood, not by a failing
test, so each fix ships with a test that fails without it.

## Decision

Three independent corrections, each in the package that owns the defect.

### Boot-write failure no longer rejects run()

In [`src/index.ts`](../../../../packages/code-runtime/code-runtime-python/src/index.ts)
the fd-3 boot-frame write is the last statement of `run()`'s synchronous setup.
Its `catch` calls `finish()`, and `finish()` reads `wallTimer` and `onAbort` and
— through `settle()` — `live`. Those bindings are `const` and were declared
AFTER the boot-write, so on a synchronous write failure `finish()` touched them
in their temporal dead zone and threw a `ReferenceError`. That escaped the
Promise executor and REJECTED `run()`, violating the seam's "outcomes resolve"
contract: the caller saw a thrown error instead of the `worker-exit` the catch
constructs. The boot-write block is now emitted after `wallTimer`, `onAbort`, and
`live` are initialized, and the `/* v8 ignore */` that had hidden the branch from
coverage is removed so the catch is measured.

### Log capture is serialized against settlement

In [`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py)
the settlement `flush_out()`/`flush_err()` on the main coroutine read and clear
each stream's `_pending` list and mutate the shared `LogBuffer` ledger. Model
code may start daemon threads whose `print`/`write` mutate the same state
concurrently. Capturing the bound method (`out_stream.flush_line`) fixed only
WHICH callable settlement invokes, not what it reads mid-flight: an interleaved
flush could join a `_pending` list being mutated under it, corrupting the ledger
and costing the `done` frame — stranding the run to the wall clock. `LogBuffer`
now owns one re-entrant lock shared by both streams; `_LogStream.write` and
`flush_line`, and `LogBuffer.push`, take it, so the whole read-modify-write is
atomic across threads.

### Fd-3 residual is copied, not viewed

Also in `src/index.ts`, after the newline loop over a `Buffer.concat` of the
pending fd-3 chunks, the leftover partial line was carried forward as the
`subarray` VIEW it was sliced to. A view keeps the entire concat backing
allocation alive, so a large frame followed by a tiny trailing fragment pinned a
whole frame's worth of memory while `pendingBytes` — set to the fragment's
length — reported far less than was retained. The residual is now detached into a
fresh right-sized `Buffer` via the exported `detachResidual` helper, letting the
concat allocation be collected and keeping `pendingBytes` an honest measure.

## Testing

- `tests/boot-write-failure.spec.ts` mocks `spawn` so the fd-3 pipe throws on the
  boot write — the one path a real subprocess cannot be coerced into — and
  asserts `run()` resolves a `worker-exit` rather than rejecting. Isolated in its
  own spec so the real-subprocess suite is untouched.
- `tests/residual-detach.spec.ts` unit-tests `detachResidual`: the carried copy
  equals the residual, owns a backing store sized to its own length, and does not
  share the source frame's `ArrayBuffer`.
- `tests/runtime.spec.ts` adds a real-subprocess case where four daemon threads
  emit unterminated writes up to the moment the body returns and settlement
  flushes, repeated so the interleave lands; the run must complete cleanly. A
  pure data race has no single bad input to reject, so this maximizes overlap
  rather than asserting a deterministic rejection.

## Alternatives considered

**Leave the boot-write `/* v8 ignore */` and fix only the ordering.** Rejected:
the ignore is what let the TDZ regression ship uncaught. Removing it makes the
catch a measured branch, so per-file 100% coverage now proves the failure path
is exercised.

**Fix the flush race by capturing more bound methods.** Rejected: this is the
approach that already failed. Binding a callable fixes reference resolution, not
concurrent access to the mutable state the callable reads. Only mutual exclusion
over the shared ledger closes the race.

**Guard the residual with a size threshold (copy only large frames).** Rejected:
the branch runs once per newline-bearing read, the copy is bounded by the
residual's own length (always a partial line), and a threshold adds a tunable
and a second code path for no measurable saving. An unconditional right-sized
copy is simpler and always correct.

**Assert the residual memory effect through the seam.** Rejected: the retained
allocation is not observable through `CodeRunResult`, so a black-box test could
not distinguish fixed from unfixed. Extracting `detachResidual` makes the
backing-store invariant a deterministic unit test instead.

## Consequences

The seam's resolve-don't-reject contract now holds on the boot-write path, and
its coverage is measured rather than ignored. Log capture is thread-safe at the
cost of one re-entrant lock acquisition per write and flush — negligible against
the os.write already on that path. Fd-3 residual memory is bounded by the actual
retained bytes, and `pendingBytes` measures what it claims. Each fix carries a
test that fails without it, so a future regression on any of the three goes red.
