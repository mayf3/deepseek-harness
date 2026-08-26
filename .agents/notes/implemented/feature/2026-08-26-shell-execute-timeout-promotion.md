# Agent Note: One shell execute() — foreground as a projection, timeout as a promotion offer

Status: implemented

English | [中文](2026-08-26-shell-execute-timeout-promotion.zh.md)

## Problem

A bash command that outran its foreground timeout was killed, discarding the work — the single most common way a long build or install failed under the agent. Fixing that inside the old seam was structurally awkward: `ctx.shell` had two execution methods, `run()` (deadline fused in, promise-only, no handle to keep) and `start()` (handle, no deadline), so "keep this already-running foreground command" had no expression — the deadline owner could only kill, and the caller had nothing to re-register with `ctx.jobs`. The two methods had also drifted: different stdout budgets, a documented "start ignores timeoutMs" wart, and sync-vs-async spawn-failure behavior that differed per path.

Peer evidence pointed one way. Kimi promotes on timeout by default (`bashAutoBackgroundOnTimeout`), rebinding nothing — the process task detaches, the caller signal unhooks, and the partial output returns with the handle. Claude Code's timeout handler calls `background()` on the same `ShellCommand` instead of killing, with an explicit comment that respawning would leak cleanups and duplicate events. Codex has no promotion because it never had a "foreground spawn" at all: every `exec_command` is a bounded observation window over a session, and "still running" is a normal return carrying the handle. All three agree on the underlying shape: there is one way to execute, and foreground is a property of the wait, not the spawn.

## Decision

**The seam converges to `resolve()` + `execute()`.** `execute(spec)` returns `ShellExecution` — the live `ShellProcess` itself plus two projections: `result()` (the foreground view: split collected streams, first-cause `timedOut`/`aborted`, rejecting only for infrastructure failures) and `promotion` (the deadline's first-to-settle signal). `run()` and `start()` are deleted (pre-release, no shims); the historical differences they encoded became explicit inputs: `ShellExecSpec.onExpiry` is `'kill'` (the default), `'offer'`, or `'none'`, and one stdout budget (`spec.stdoutMaxBytes`) applies everywhere.

**`promotion` settles exactly once and never rejects**: with a `ShellPromotionOffer` when an `'offer'` deadline expires on a still-running process, with `undefined` when the process settles first (and under every other policy). That completeness is what lets a consumer write `const offer = await ex.promotion` with no race against `result()`. The offer must be answered synchronously upon resolution; the executor auto-declines an unanswered offer, so the fail-safe direction is the old kill-on-timeout behavior, never a silently detached process. `accept()` ends the deadline obligation and detaches the caller's abort signal (Kimi's `detachEntry`, Claude Code's `#cleanupListeners`, same move); `decline()` kills now and classifies `timedOut`.

**Spawn failures are contained uniformly**: a synchronous spawn throw and an asynchronous rejection both settle the handle as `killed` with the note on the read path, while `result()` rejects with the original error (identity preserved — the sandbox executors map runner-attributed failures to `SANDBOX_UNAVAILABLE` in their `result()` decoration and stamp handle facts in `onProcessDone`, both keyed on the one handle instance).

**`tool-bash`/`tool-pwsh` promote on timeout by default** (`promoteOnTimeout: true`, requiring `enableRunInBackground` and a live `ctx.jobs`). The threshold is the existing `timeoutMs` — expiry becomes the trigger, exactly as Kimi and Claude Code redefined it; no second knob exists. At the offer the tool registers the running handle as a job with the same three hooks as `run_in_background`, mirrors it into `ctx.activities` (so the Web task list streams it, stop control included), takes one consuming read for the result, and returns `{ kind: 'promoted', jobId, timeoutMs, output }` rendered as `[still running after <ms>; moved to background job <id>]` plus hand-off guidance. The cursor continues exactly after the embedded output — Kimi's shape; Claude Code returns only a file pointer because its output identity is a file, DSH's is the job cursor. Any promotion failure (admission, controller preflight) declines the offer and falls back to the plain timeout kill, logged. Completion later flows through the existing tool-jobs notice, so the model is told without polling.

## Alternatives considered

- **A third method (`begin()`) beside `run`/`start`** — the first design. Rejected in review: the three "methods" were two orthogonal inputs (deadline policy; which projection the caller awaits) wearing method names, and the peer products all model one execution with projected views. Converging deleted the budget/wart drift instead of adding a surface.
- **Codex's session model** (every call an observation window, polling via `write_stdin`) — rejected as a model-facing vocabulary change duplicating what `ctx.jobs` already provides; its early-yield result contract survives in the promoted arm.
- **A separate promotion threshold config** — rejected; "timeout means stop blocking the turn, not kill the work" needs no second timer, and an explicit model-passed `timeoutMs` promotes too (both peers behave so; the schema text says it).
- **Auto-decline via status checks inside the offer** — dead code under the synchronous-answer contract; removed in favor of the microtask auto-decline plus answered-latch.

## Testing

Executor level (real processes): offer at deadline; accept detaches timer and caller signal (an abort after accept does not kill; `kill()` does); decline classifies `timedOut`; settle-first resolves `undefined`; unanswered auto-declines; pre-offer abort classifies `aborted`; `'none'`-policy classification; sync-throw containment with error identity through `result()` (sandbox suites). Tool level: a real `printf …; sleep 30` with `timeoutMs: 250` promotes end to end — job registered, activity mirrored with the call correlation, cursor continues past the embedded output, `job_kill` works; admission saturation falls back with the warn; `promoteOnTimeout: false` keeps the kill and drops the description sentence; pwsh mirrors via scripted offers. Render texts are pinned verbatim.

## Consequences

- Every `ShellExecutor` consumer moved: the tools, the hook runner, tmux-context, the e2b fixture, and the webworker sandbox stack now speak `execute()`; executor test suites keep scenario intent through local `run`/`start` shims over the new seam.
- The `bash`/`pwsh` tool descriptions and `timeoutMs` schema text changed (model-visible), and the output union gained the `promoted` arm — recorded-session snapshots re-recorded with them.
- A promoted command has no deadline at all afterwards, like any background job; stopping it is `job_kill` or the web stop control.
- `start()`-era behavior where a synchronous spawn throw escaped to the caller is gone: callers read failures from `result()`/the read path. The sandbox "sync EACCES names the runner" classification now arrives as the `result()` rejection or the handle's `runnerFailed` fact.
