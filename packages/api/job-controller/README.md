---
description: "Host and Client job observation: stream one background job's output record to the browser without touching the model's consuming cursor."
kind: "package-reference"
---
# Job Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-job-controller` owns the Host `ctx.jobController` service and the generated Client `ctx.remote.job` namespace. Its one Remote stream, `job.observe`, delivers a record-declaring job's retained output from an absolute byte offset; the Client half installs `ctx.jobOutput`, the reference-counted per-job observation service whose accumulated views the session-header job list renders. The roster itself is not here: `SessionJob` rows still ride the session control stream owned by [`dsh-api-session-controller`](../session-controller/README.md), and a row's `outputTotal` says whether this controller has anything to stream for it.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller requires the live Agent registry and the job registry (`dsh-jobs-local` in the shipped compositions) and fails to load without them. `job.observe({ sessionId?, jobId, from? })` resolves the fenced-read caller from the request's session — an unowned job needs no session — and yields one `opened` anchor, coalesced `output` frames, then one terminal `status` once the job has settled and its record is drained, after which the stream closes normally. Record reads are non-consuming: the model-facing `job_output` cursor and completion-notice state never observe them. A job the session does not own, a job without a record, or an unknown job rejects the stream. Reconnecting callers resume by passing the last frame's `next` as `from`; a `from` below the oldest retained byte gets a `lossy` first frame instead of an error.

The Client entry provides `ClientJobOutput` (`ctx.jobOutput`) over `ClientJobOutputModel`. `observe(sessionId, jobId)` opens one Gateway stream per job however many viewers expand it, keeps a bounded render tail per job with `gapBefore` marking eviction or resume gaps, records the terminal status or a stream failure on the view, and drops the view after the last viewer releases. The plugin resolves the Gateway stream factory and the `job` namespace while its own context is current, because observation (re)opens run on caller stacks that have not declared `remote.job`.

### Config

| Field | Default | Meaning |
|---|---:|---|
| `observeFlushMs` | `100` | Coalescing window after new record output before an observation read, in milliseconds |
| `observeMaxFrameBytes` | `65,536` | Soft byte budget per observation output frame; one larger chunk ships whole |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-job-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as job observation is browser and Host control state; it registers no prompt, tool, or session event. The model's own view of the same work stays with [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md).

#### KV Cache effect

No direct effect; observation reads never touch model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The stream is process-local: a Host restart loses every record, and a resumed observation then anchors on an empty registry.
- Per-session fencing is enforced by the registry read; the Remote layer itself serves any connected browser, matching the session control stream's `jobsBySession` broadcast.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The controller is a stateless projection of `ctx.jobs` reads; the registry's own `@deepseek-ai/dsh-jobs/invariant` owns the offset relations this stream forwards.
