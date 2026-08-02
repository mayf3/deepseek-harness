# Agent Note: Settlement, framing, and lifecycle fixes in the CPython backend

Status: implemented

English | [中文](2026-07-31-code-runtime-python-settlement-fixes.zh.md)

## Problem

The CPython subprocess backend for Code Mode, built on the [fd-3 frame protocol](../architecture/2026-07-31-code-runtime-python-fd3-protocol.md), resolves every program outcome as a `CodeRunResult`, rejects `run()` only for seam misuse, and disposes to quiescence so no subprocess outlives the fiber. A sequence of review passes surfaced defects that broke those contracts in ways unit coverage did not catch — each hid behind a `/* v8 ignore */`, a captured-callable that read as a fix but was not, a memory effect invisible through the seam, a load-time bound that double-counted, a process-group escalation that a survivor could outlast, or a cross-event-loop completion that silently deadlocked. Each fix ships with a test that fails without it.

## Decision

Seven independent corrections, each in the package that owns the defect.

### Boot-write failure no longer rejects run()

In [`src/index.ts`](../../../../packages/code-runtime/code-runtime-python/src/index.ts) the fd-3 boot-frame write is the last statement of `run()`'s synchronous setup. Its `catch` calls `finish()`, and `finish()` reads `wallTimer` and `onAbort` and — through `settle()` — `live`. Those bindings are `const` and were declared AFTER the boot-write, so on a synchronous write failure `finish()` touched them in their temporal dead zone and threw a `ReferenceError`. That escaped the Promise executor and REJECTED `run()`, violating the seam's "outcomes resolve" contract: the caller saw a thrown error instead of the `worker-exit` the catch constructs. The boot-write block is now emitted after `wallTimer`, `onAbort`, and `live` are initialized, and the `/* v8 ignore */` that had hidden the branch from coverage is removed so the catch is measured.

### Log capture is serialized against settlement

In [`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py) the settlement `flush_out()`/`flush_err()` on the main coroutine read and clear each stream's `_pending` list and mutate the shared `LogBuffer` ledger. Model code may start daemon threads whose `print`/`write` mutate the same state concurrently. Capturing the bound method (`out_stream.flush_line`) fixed only WHICH callable settlement invokes, not what it reads mid-flight: an interleaved flush could join a `_pending` list being mutated under it, corrupting the ledger and costing the `done` frame — stranding the run to the wall clock. `LogBuffer` now owns one re-entrant lock shared by both streams; `_LogStream.write` and `flush_line`, and `LogBuffer.push`, take it, so the whole read-modify-write is atomic across threads.

### Fd-3 residual is copied, not viewed

Also in `src/index.ts`, after the newline loop over a `Buffer.concat` of the pending fd-3 chunks, the leftover partial line was carried forward as the `subarray` VIEW it was sliced to. A view keeps the entire concat backing allocation alive, so a large frame followed by a tiny trailing fragment pinned a whole frame's worth of memory while `pendingBytes` — set to the fragment's length — reported far less than was retained. The residual is now detached into a fresh right-sized `Buffer` via the exported `detachResidual` helper, letting the concat allocation be collected and keeping `pendingBytes` an honest measure.

### Output-cap load bound is ceiling minus envelope, not divided by six

The load-time check that rejects a `maxLogBytes`/`maxValueBytes` larger than one fd-3 frame can carry divided the frame ceiling by six for worst-case escape expansion. But both budgets are metered in ALREADY-ESCAPED serialized bytes — the host log ledger charges `Buffer.byteLength(JSON.stringify(text))` and `checkDoneValue` measures the escaped form — so a payload admitted under the cap occupies at most `cap + envelope` on the wire; escaping is inside the charge and must not be multiplied in again. The bound is now `FRAME_CEILING_BYTES - FRAME_ENVELOPE_BYTES`, and the unused `MAX_JSON_ESCAPE_EXPANSION` constant is gone. The old bound was not unsafe — it under-admitted — but it silently forbade legitimate large caps.

### Same-group survivors are reaped before the fiber goes quiescent

A model program can leave a descendant in the child's OWN process group (no `setsid`, so `kill(-pid)` reaches it) that ignores SIGTERM but releases the inherited stdout/stderr/fd-3 pipes. The leader then exits, its `close` fires because the pipes drained, and settlement runs while that descendant is still alive. `kill()` arms an `unref`'d SIGKILL timer after SIGTERM; the fix is that `settle()` no longer resolves the run's `finished` promise immediately when an escalation is in flight. Instead, when `killing` is set and the process group is not yet empty (`process.kill(-pid, 0)` does not throw ESRCH), it polls the group on a REF'd timer, bounded by `graceMs + CLOSE_REAP_MARGIN_MS`, and resolves `finished` only once the group has emptied. The ref'd poll is the load-bearing part: it keeps the host event loop alive until the SIGKILL has actually reaped the group, so even a short-lived host — a one-shot headless run, a config subprocess — cannot exit and reparent the survivor to init. In the normal case (the leader was the only member) the first probe returns ESRCH and settlement resolves with zero added latency. `teardown()` awaits each run's `finished`, so disposal is genuinely quiescent, matching its JSDoc.

Settlement also CANCELS the SIGKILL timer the moment the group is confirmed empty (the normal path, and when the poll sees the survivor gone). Leaving it armed would expose a PID-reuse hazard: a `kill(-pid)` left pending for up to `graceMs` after the leader was reaped could hit a RECYCLED pgid once the kernel reused the leader's pid, SIGKILLing an unrelated group (`killGroup` swallowing ESRCH does not help — the danger is precisely the kill that SUCCEEDS against a reused group). Clearing it on the empty probe bounds the reuse window to only the genuine-survivor case, where the group cannot be empty to reuse.

### RLIMIT clamps against the inherited soft limit, not only the hard

In [`py/bootstrap.py`](../../../../packages/code-runtime/code-runtime-python/py/bootstrap.py) `_clamped` bounded a requested `(soft, hard)` rlimit pair by the inherited HARD limit alone. A deployment that inherited a soft limit below the requested one — say inherited `(100, 200)`, requested `(150, 160)` — got back `(150, 160)`, RAISING the effective soft from 100 to 150: for `RLIMIT_AS` that loosens the memory ceiling, for `RLIMIT_CPU` it defers SIGXCPU, both violating "strictest of configured and inherited". `_clamped` now clamps each side against its own inherited counterpart (`RLIM_INFINITY` imposing no ceiling), then pins soft under hard so `setrlimit` never sees an inverted pair. The settlement-time CPU recheck (`die_if_cpu_exhausted`) follows the same rule: it compares spent CPU against the EFFECTIVE clamped `cpu_soft`, not the configured `cpuSeconds`, so a program that traps SIGXCPU and burns past a stricter inherited soft before returning is reported as a timeout rather than a false success.

### Binding replies complete on the calling loop's thread

Also in `py/bootstrap.py`, a binding reply Future is created on the loop that ran `dispatch`. When the model calls a binding from a worker THREAD via `asyncio.run(tools.x(...))`, that Future belongs to the thread's loop, not the main loop where `_pump_replies` reads the reply. `asyncio.Future` is not thread-safe: completing it from another thread does not wake its own loop, so the direct `set_result`/`set_exception` left the awaiting thread stranded and the run degraded to a wall-clock timeout. Each pending entry now records its Future's loop alongside the Future, and `_pump_replies` completes it via that loop's `call_soon_threadsafe`. The shared `pending`/`next_id` state is guarded by a `threading.Lock` held across the id claim, the fd-3 write, and the counter advance, so concurrent callers cannot interleave frames out of the id order the host requires. `call_soon_threadsafe` onto a loop that has already CLOSED (the worker thread finished and abandoned its call before the reply arrived) raises `RuntimeError`; that schedule is wrapped so the moot reply is dropped rather than letting the exception end the pump task and strand every later reply.

## Testing

- `tests/boot-write-failure.spec.ts` mocks `spawn` so the fd-3 pipe throws on the boot write — the one path a real subprocess cannot be coerced into — and asserts `run()` resolves a `worker-exit` rather than rejecting. Isolated in its own spec so the real-subprocess suite is untouched.
- `tests/residual-detach.spec.ts` unit-tests `detachResidual`: the carried copy equals the residual, owns a backing store sized to its own length (fixture kept above Node's Buffer pool threshold), and does not share the source frame's `ArrayBuffer`.
- `tests/runtime.spec.ts` — the output-cap case asserts the `ceiling - envelope` bound (268435392) and its message. A daemon-thread case drives four threads emitting unterminated writes through settlement's flush. The same-group reap case spawns a SIGTERM-ignoring same-group descendant that releases the pipes and bumps a heartbeat file; the test asserts the heartbeat STOPS after the grace-window SIGKILL — an assertion robust whether the killed descendant is reaped or lingers as a zombie, so it holds where PID 1 does not wait() orphans. The cross-loop case runs a binding from a worker thread's own `asyncio.run` loop while the main coroutine yields with `await asyncio.sleep`, asserting the reply round-trips instead of timing out. The inherited-soft-limit case runs the interpreter through a `ulimit -S -t` wrapper that sets a CPU soft limit below `cpuSeconds` and asserts the applied `RLIMIT_CPU` soft is the inherited value, not the configured one (CPU rather than address space, since macOS ignores `ulimit -v`). A companion case inherits a 1 s CPU soft, has the program trap SIGXCPU and busy-loop past it, and asserts the settlement recheck reports a timeout — proving the recheck uses the effective soft, not the configured `cpuSeconds`.

## Alternatives considered

**Leave the boot-write `/* v8 ignore */` and fix only the ordering.** Rejected: the ignore is what let the TDZ regression ship uncaught. Removing it makes the catch a measured branch, so per-file 100% coverage now proves the failure path is exercised.

**Fix the flush race by capturing more bound methods.** Rejected: this is the approach that already failed. Binding a callable fixes reference resolution, not concurrent access to the mutable state the callable reads. Only mutual exclusion over the shared ledger closes the race.

**Guard the residual with a size threshold (copy only large frames).** Rejected: the branch runs once per newline-bearing read, the copy is bounded by the residual's own length (always a partial line), and a threshold adds a tunable and a second code path for no measurable saving. An unconditional right-sized copy is simpler and always correct.

**Assert the residual memory effect through the seam.** Rejected: the retained allocation is not observable through `CodeRunResult`, so a black-box test could not distinguish fixed from unfixed. Extracting `detachResidual` makes the backing-store invariant a deterministic unit test instead.

**Reap the same-group survivor with a fire-and-forget `unref`'d SIGKILL timer alone.** Rejected: an `unref`'d timer does not keep the host alive, so a host that exits within the grace window (a one-shot run, a config subprocess) never fires the SIGKILL and the survivor is reparented to init — the same "no subprocess outlives the fiber" violation in a different shape, and `teardown`'s "await each child's exit" JSDoc would be false. Awaiting the group's death on a ref'd poll keeps the host alive exactly long enough to reap, at zero cost in the common empty-group case.

**Assert the reap with `process.kill(pid, 0)` throwing ESRCH.** Rejected: a SIGKILL'd process lingers as a zombie until its parent `wait()`s it, and in a container whose PID 1 does not reap orphans the signal-0 probe keeps succeeding, so the assertion would false-fail cross-environment. A heartbeat file that stops advancing detects "no longer executing," which a reaped process and a zombie both satisfy.

**Complete the cross-loop Future with a plain `set_result` and rely on the GIL.** Rejected: the GIL serializes bytecode but does not make `asyncio.Future` cross-loop-safe — completing a Future from a thread other than its loop's does not schedule its callbacks or wake the loop. `call_soon_threadsafe` on the owning loop is the documented mechanism.

**Leave the SIGKILL timer armed after settlement (the earlier same-group fix).** Rejected: an unref'd timer left to fire up to `graceMs` after the leader was reaped can `kill(-pid)` a RECYCLED pgid, striking an unrelated group; the danger is the kill that succeeds, which `killGroup`'s ESRCH swallow cannot prevent. Clearing the timer once the group is confirmed empty bounds the reuse window to the genuine-survivor case, where the group is not empty to reuse.

**Clamp rlimits by the inherited hard limit only.** Rejected: that silently RAISES an inherited soft limit stricter than the request, loosening the very containment the clamp exists to preserve. Clamping each side against its own inherited bound (then pinning soft under hard) keeps the strictest of configured and inherited on both.

## Consequences

The seam's resolve-don't-reject contract holds on the boot-write path with measured coverage. Log capture is thread-safe at the cost of one re-entrant lock acquisition per write and flush. Fd-3 residual memory is bounded by the actual retained bytes. The output caps admit every value a frame can carry. Disposal is genuinely quiescent against a same-group survivor — bounded by the existing grace budget, zero-cost when the group is already empty, with the SIGKILL timer cleared once the group empties so a stale kill cannot strike a recycled pgid — RLIMIT enforcement keeps the strictest of configured and inherited on both soft and hard, and bindings called from model-created threads complete instead of timing out. Each fix carries a test that fails without it, so a future regression on any of the seven goes red.
