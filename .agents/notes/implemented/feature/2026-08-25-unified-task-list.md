# Agent Note: One session-header task list — jobs joined with activities in the UI projection only

Status: implemented

English | [中文](2026-08-25-unified-task-list.zh.md)

## Problem

The [activity observation seam](2026-08-24-activity-observation-seam.md) shipped its Web surface as a second session-header button beside the [background-job list](2026-08-08-web-background-job-display.md). A background bash run registers in both planes — `ctx.jobs` for control and `ctx.activities` for observation — so the same work rendered twice: once in "background jobs" with lifecycle and duration, once in "activities" with expandable live output. Two near-identical popovers with different names for overlapping row sets read as a product accident, and the flat activity rows (live and settled interleaved, single-line, no duration) had no visual hierarchy.

## Decision

The service planes stay orthogonal; the join happens once, per row, in the UI projection.

- **`ctx.jobs` and `ctx.activities` remain separate services.** Jobs are the control plane: model-visible ids, a consuming `readOutput` cursor the model drains, `stopping`, `kill`, and the `reported` completion-notice contract. Activities are the transient observation plane: non-consuming absolute offsets, invisible to the model, gone on restart. Merging the services would force one registry to carry both a consuming and a non-consuming cursor and would blur the "model-visible ⟺ logged" line for a plane designed to stay off the session log.
- **`dsh-client-ui-activity` renders the single merged list; `dsh-client-ui-jobs` is deleted** (pre-release, no compatibility shim), and the merged entry takes the job list's slot order. Each `jobsBySession` row is joined with the activity carrying its `correlation.jobId`: the job supplies identity, lifecycle (`stopping` exists only there), duration, and the model-visible `detail`; the activity supplies the expandable output panel. An activity without a job (a workflow run) keeps its own row; an activity whose job is not in the projection is not dropped. Without the activity registry, job rows still render — they just offer no panel, so the merged control degrades to exactly the old job list.
- **User-facing vocabulary is "task" (任务)** — `N tasks running` / `N 个任务进行中` — because every row is running work to the user, while "background job" excludes workflow runs and "activity" names the internal plane, not the user concept. The dictionary namespace and package names stay `activity`: internal names follow the naming ledger, not display copy.
- **Hierarchy**: live rows first (label over a kind-badge-and-status second line, ticking duration), then a "Finished" divider only when both sections exist, then settled rows compacted to one de-emphasized line. Rows without an observable activity render as static rows with no expansion affordance.

Deliberately not joined: subagent delegation rows stay bare job rows (the subagent panel is their surface), and foreground commands stay in their tool cards — neither gains an activity producer.

## Alternatives rejected

- **Merge the services** — rejected for the cursor-semantics and model-visibility reasons above.
- **Keep the job list and bolt output onto it** — leaves workflow runs (activities without jobs) homeless, forcing a second list to survive anyway.

## Consequences

- The two web e2e scenarios (`background-job-list`, `live-activity-stream`) now assert one "Tasks" list; the job-list scenario's row gained a live-output panel, which is the join working end to end.
- A human kill control on live rows is still blocked on the jobs `reported` contract question recorded in the job-display note.
- The `job` locale namespace is gone with its package; `activity` owns the merged copy including the duration vocabulary.
