---
description: "CPython subprocess implementation of the DeepSeek Harness code-execution seam, with fd-3 bindings, resource limits, log capture, and process-group teardown."
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime-python

English | [中文](README.zh.md)

CPython-subprocess implementation of the [`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.md) seam. Companion to [`@deepseek-ai/dsh-code-runtime-worker-thread`](../code-runtime-worker-thread/README.md); trades the Node worker thread for a fresh `python3` subprocess so model code is Python instead of TypeScript.

The package ships `PythonCodeRuntime` as its default export. The plugin registers as `codeRuntime` with `language: 'python'` and `isolation: 'process'`. Each `run()` spawns a fresh `python3 -I` process, sends a boot frame and the program over fd 3, and resolves a `CodeRunResult` for every program outcome — rejecting only for seam misuse (a malformed binding namespace or non-positive config). The child runs the program as the body of an async function, so top-level `await` and `return` both work; binding calls travel back over fd 3 as JSON-lines. Containment (not a security boundary — model code has bash-equivalent trust) comes from an empty environment, `RLIMIT_CPU`/`RLIMIT_AS`, a wall-clock ceiling, and a `SIGTERM`→grace→`SIGKILL` teardown on the child's process group.

## Wire protocol

The host and the CPython subprocess exchange a versionless, JSON-lines protocol on the child's fd 3 — one JSON object per line, leaving stdout/stderr free for the program's own output. `src/protocol.ts` is the host side; `py/protocol.py` mirrors its message shapes and the shared truncation-marker text on the Python side.

- **fd 3, not stdout** — Node pins the channel positionally with `stdio: ['pipe','pipe','pipe','pipe']`; the Python bootstrap reads the same `PROTOCOL_FD` constant. JSON-lines framing.
- **Host treats every inbound frame as hostile** — model code has full access to fd 3 and can post anything through it, so `validateChildFrame` shape-validates and REBUILDS each frame before the host reads it: forged extra fields never ride along, a non-number call id can never be echoed into a reply, and junk drops to `undefined` rather than throwing in the host's message handler. The Python side trusts host replies (the host is not model-controlled).
- **Lossless-JSON crossing** — completion values and binding arguments cross as exact JSON. `encodeJsonPlain` serializes a `JSON.parse`-produced value without recursion, so a deep value below the byte budget crosses intact instead of dying on `JSON.stringify`'s stack limit; `checkDoneValue` meters a forged completion value's byte length AND number losslessness in one bounded traversal that rejects an over-budget payload before enqueuing its children; `hasUnsafeIntegerToken` reads the raw frame text to catch an integer token that `JSON.parse` would silently round; `hasNonLosslessNumber` rejects a non-finite or negative-zero number in unbounded `call.args`. Beyond-safe-range integral doubles serialize through `BigInt` digits so the exact integer crosses, not the rounded `String()` form.
- **Shared truncation marker** — `logTruncationMarker(maxBytes)` produces byte-identical text on both sides, so a truncated log run reads the same however the cap was hit. The `log` frame's `truncated` flag distinguishes the child ledger's own marker from program output.

## Configuration

Every cap is a validated `Config` field with a default, changeable from `cordis.yml` (no hardcoded tunables). `cpuSeconds` (default 60) is the `RLIMIT_CPU` whole-second budget; the child sets the soft limit to `cpuSeconds` and the hard limit to `cpuSeconds + 1`, so the kernel's `SIGXCPU` at the soft limit classifies as a `timeout` while the +1s hard limit is a `SIGKILL` backstop. `maxWallMs` (default 600000) is the wall-clock ceiling that backstops CPU time for a program awaiting a promise nobody resolves. `addressSpaceMb` (default 512) is the `RLIMIT_AS` cap, not applied on Darwin (the dyld shared cache mapped into every process exceeds any practical cap there; `cpuSeconds` and `maxWallMs` still bound the run). `maxLogBytes` (default 65536) is the shared captured-log byte budget; `maxValueBytes` (default 32768) caps the completion value; `graceMs` (default 3000) is the `SIGTERM`→`SIGKILL` grace window; `pythonBin` (default `python3`) is the interpreter, resolved against `PATH` before the child spawns with an empty environment.

## Model Experience

Indirectly, through Code Mode in [`dsh-tools`](../../core/tools/README.md), which renders this backend's exact completion value when it fits (or an explicit `invalid-output` / `output-limit` failure), plus the exact `[dsh-code-runtime-python] log capture truncated at <maxLogBytes> bytes` log marker, into a retained `run_code` result.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **The cross-language guard covers executed values and frame field sets, not field types** — `tests/protocol-mirror.e2e.ts` compares `PROTOCOL_FD`, the log truncation marker, and each `TypedDict`'s required and optional fields against a real `python3`. Comparing field types across TypeScript and Python has no mechanical equivalent here, so review plus the backend's real-subprocess suite owns type-level drift.
- **`RLIMIT_AS` is not enforced on macOS** — the dyld shared cache mapped into every process at exec exceeds any practical address-space cap, and the kernel rejects the `setrlimit` call, so `addressSpaceMb` is skipped there. `cpuSeconds` and `maxWallMs` still bound every run.
