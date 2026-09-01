# Agent Note: The job registry absorbs the observation record; the standalone activity seam is removed

Status: implemented

English | [中文](2026-09-01-jobs-absorb-activity-record.zh.md)

## Problem

The [activity observation seam](../feature/2026-08-24-activity-observation-seam.md) shipped live output streaming as a second registry beside `ctx.jobs`: producers registered the same work twice (a job for lifecycle, an activity for observation), kept the two terminal states consistent by hand (`observeBackgroundActivity` waited for `proc.done` before mapping the outcome so a pump failure could not freeze a wrong terminal state), correlated the rows through `ActivityCorrelation.jobId`, and wrapped every observation call in registry-absent degradation branches. The Web client maintained two rosters (session-control `jobs` frames and the activity control stream) and joined them per row. Measured before the merge: eight pairing call sites, and one producer population — background bash/pwsh (both registries), PTY sends and subagent delegations (jobs only), foreground workflow (activity only).

The one activity without a job was the foreground workflow mirror. Everything else the split enabled — independent observers, absolute-offset reads, bounded retention — is a property of the record, not of the registry split.

## Decision

`ctx.jobs` owns the observation record; `packages/activity/`, `packages/api/activity-controller`, and the correlation vocabulary are removed.

- **`JobStart.record?: true`** declares an observable output record. `run(job)` now receives the job's producer face — `RunningJob { id, append(text, {channel?, gapBefore?}), updateDetail(detail) }` — so the id is issued before the starter runs (a throwing starter still registers nothing; its ordinal is skipped). Writes staged inside the starter surface at the registration commit. `updateDetail` works for every job and gives `job_list` a live progress line; `append` without a record declaration logs and drops.
- **There is no `end`.** Job settlement — the producer outcome, a kill, or teardown — is the record's only close: it trims retention to the settled cap and fires the final `onOutput` signal. The dual-settlement pairing (`ActivityHandle.end` first-wins against teardown force-ends) is deleted, not reimplemented.
- **`readRecord(id, from, caller)`** is the non-consuming multi-reader view (absolute UTF-8 offsets, `lossy` below the retained window), fenced like every other job read; it never marks the job `reported`. The model-facing `readOutput` cursor is untouched — the two projections serve different readers and stay separate by design.
- **`jobs-local`** absorbs the chunk ring (`retainBytes` 256 KiB live, `settledRetainBytes` 16 KiB settled), and `pumpJobOutput` replaces `pumpActivityOutput` beside the seam. Producers fold the pump's final drain into `hooks.done` so the record holds its last bytes before settlement closes it.
- **The wire moves to the session namespace.** `SessionJob.outputTotal` (present exactly for record jobs) marks a row observable; `session.observeJob({sessionId?, jobId, from?})` streams anchor/output/status frames with the fenced read resolved from the request's session — the killJob authorization shape. `api-activity-controller` is deleted; its roster stream is redundant (the jobs frames are the roster) and its observe machinery moved into `session-controller` (`observe-job.ts`, client `ctx.jobOutput`).
- **`ui-activity` returns to its upstream name `ui-jobs`** and renders one roster: `jobsBySession` rows, expandable exactly when `outputTotal` is present. The two-roster join is deleted.
- **Foreground workflow loses its live panel deliberately.** `tool-workflow`'s activity mirror is removed; a foreground run surfaces through its recorded run/member lifecycle events only, and the per-line `workflow/phase` / `workflow/log` narration has no observer until workflow gains `run_in_background` and registers a record job. Jobs stay a pure background registry — no `foreground` mode bit, no model-invisible rows, no run-less rows.

## Alternatives considered

- **A `foreground: true` job mode** to keep the foreground workflow panel: it needs two coupled enforcement points (reported-at-birth and a `job_list` filter) whose divergence double-delivers or leaks rows to the model, for one edge feature replaceable by `run_in_background`.
- **Serving model reads from the record** (deleting `readOutput`): model reads are producer-formatted (truncation and spill notices, sandbox markers) and consuming; the record is raw, channel-labeled, and non-consuming. Unifying them moves producer-specific formatting into the registry or noise into the observer stream.
- **Keeping the split with shared implementation** (a common registry library): it removes the duplicated skeleton but keeps the real costs — double registration, terminal-state pairing, correlation, a second wire roster, and a second package family.

The [prior seam note](../feature/2026-08-24-activity-observation-seam.md)'s argument against durable session events and control-stream framing for live output still holds and carries over unchanged: the record is process-local observation state, never a session event, so "model-visible ⟺ logged" is untouched.

## Consequences

Every observable row is a killable job; a pure-observation surface with no lifecycle would need a new home (harness diagnostics belong to the inspector plane, not here). A future remote job provider must implement lifecycle and record together. The record's retention config lives on `jobs-local`; the observation wire's cadence config (`observeFlushMs`, `observeMaxFrameBytes`) lives on `session-controller`.
