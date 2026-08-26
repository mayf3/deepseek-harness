# Agent Note: Human job kill — an unclaimed terminal report instead of a second cancellation path

Status: implemented

English | [中文](2026-08-26-human-job-kill.zh.md)

## Problem

The [web job display note](2026-08-08-web-background-job-display.md) shipped the task list read-only and recorded why: `JobRegistry.kill()` marks the job `reported`, and the [`dsh-tool-jobs`](../../../../packages/jobs/tool-jobs/README.md) completion reporter suppresses the settlement notice for a reported job. That coupling is correct for the one caller that existed — the model's `job_kill`, whose own tool result already tells the model what it did — but a human pressing a stop button has no model-visible channel at all. A kill written against that contract would leave the model believing its task is still running, exactly the stale-world-model failure Claude Code ships today (its `/tasks` kill sets `notified: true` and the model learns nothing) and Kimi avoids (a model `TaskStop` suppresses its own notification; a human stop delivers one).

## Decision

The `reported` bit means "the terminal state has a committed delivery path to the model", so the fix is to stop conflating cancellation with claiming that delivery.

- **`kill(id, caller?, options?)` takes `{ reason?, reported? }`.** `reported` defaults to `true` — the exact previous semantics for the model's `job_kill`. `reported: false` withholds this kill's claim, so the settlement flows through the existing completion reporter (wakeup/inject, wake budget, truncation all unchanged). It never clears an existing claim: a job the model already killed stays reported, and a terminal record stays exactly as settlement left it.
- **A recorded kill reason merges into a `killed` settlement's detail** — producer facts first (`signal: SIGTERM; cancelled by the user`) — so the completion notice and the web row both say who stopped the work without a new snapshot field or notice template. A job that outruns its kill (settles `completed`/`failed`) keeps the producer detail alone. This is the reconciliation Codex spells out in its `<turn_aborted>` guidance: when the user stops something, the model is told rather than left to infer.
- **`session.killJob` is a Session Controller Remote** beside `cancel`, with the same live-only Agent lookup (`ctx.agents.get`): a running job's owner is alive by the registry's ownership contract, and killing from a list must not revive a Session any more than listing does. Unknown and foreign jobs collapse to one `job-not-found` rejection; a composition without `ctx.jobs` rejects `jobs-unavailable`. No approval interaction: this single-user local BFF treats it as the same class of action as the turn-cancel button.
- **The task list's stop control is two-press** (arm, then confirm within 3s, matching the Kimi `s`+`y` and OpenCode double-Esc shape), rendered only on running job rows — rows with a `jobId`. Standalone activity rows (workflow runs) have no kill handle and no button. The pending press disables the control; the row's own `stopping` flip from the jobs frames removes it, and a rejected kill shows a brief hint. Because the kill addresses `ctx.jobs` by id, every job kind gains the control at once — bash, pwsh, pty, and one-shot background subagents.

## Alternatives considered

- **A `notify: boolean` option** — rejected because the registry cannot promise a notice (quiet delivery, unowned jobs, owner teardown all legitimately drop one); `reported` names the fact the registry actually controls, in the vocabulary `JobSnapshot.reported` already documents.
- **A separate `interrupt()`/`stopByUser()` method** — one cancellation path with an explicit claim beats two methods whose only difference is a boolean, and Kimi's split (`stop` vs `stopByUser`) shipped with its TUI calling the wrong one.
- **Saying nothing to the model (Claude Code's shape)** — rejected; their own source comments question it, and the DSH blocker note recorded the stale-belief failure as the reason the control did not ship earlier.

## Testing

`jobs-local` pins the unreporting kill (notice stays due, existing claims survive, terminal records untouched), the detail merge on `killed`, and the outran-kill case; `tool-jobs` pins the delivered notice text verbatim, reason included. `kill-job.host.spec.ts` pins the Remote command: admission, unowned-job kill from an agentless session, `job-not-found` for unknown/foreign, `jobs-unavailable` without the registry. The client suites pin the RPC passthrough and the two-press control (arm, confirm, disarm timer, failure hint, single armed row, stale-phase cleanup); the keyless web e2e drives the button end to end.

## Consequences

- The completion notice for a human kill wakes an idle owner (default `wakeup` delivery) — a deliberate cost: an unclaimed completion the model never learns about is the failure this note exists to fix.
- `kill`'s positional `reason` parameter is gone (pre-release, no shim); the options object is the only form.
- A killed job's `detail` may now carry two clauses joined by `; `. Anything parsing `detail` as a single producer fact must treat it as opaque text, which `JobSnapshot.detail` always declared it to be.
