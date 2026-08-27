---
description: "Host and Client session control: create, resume, prompt, follow history, and project live session state."
kind: "package-reference"
---
# Session Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-session-controller` owns the Host `ctx.sessionController` service and the generated Client `ctx.remote.session` namespace. It serves Session list, search, creation, model selection, rename, fork, prompt, attachment, queue, cancellation, message-aligned history, live log following, and Host-wide control state. Use it through API Gateway when a Client needs these Session operations.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

History pages and follow opening snapshots carry a discriminated `SessionHistoryRecord`. Both variants use `{ type, event }`: `type: 'event'` carries one raw `SessionWireEvent`, while `type: 'chunks'` carries one lossless `ChunkRowEvent` for consecutive same-block `assistant/chunk` deltas. Both inner values expose `type`, `seq`, `time`, and `data`, so the Client retains each accepted record as one `SessionEventLikeEntry` without record-by-record conversion. A packed event's `seq` and `time` identify its first member, and `data` retains the fragment and timestamp-gap arrays. Live follow frames remain individual `event` records. Tool arguments, result content, failures, and `tool/result.data.meta` pass through unchanged; the controller does not resolve a Tool definition, run a presenter, or attach UI data.

Each endpoint states its activation policy. List, search, attachment, history pages, and log following can inspect persistence without activating an Agent; queue mutation and cancellation require the corresponding live state; model, rename, and prompt commands may explicitly resume an ordinary Session. Create and fork are the only operations that create a new Agent. The service applies one preset-aware resume policy and subagent ownership fence to its own methods and to the Typert Agent and Session lookups used by other Remote namespaces.

The Client adapter exposes `SessionEventStream`, a Gateway `RemoteJournalStream` bound to one ordinary or direct-subagent address. It opens follow before the initial page, publishes only contiguous `replace`, `prepend`, and `append` changes, and repairs reconnect or sequence gaps through a tail page. Ordinary records cover `[event.seq, event.seq]`; packed rows cover `[event.seq, event.seq + memberCount - 1]`. A business, persistence, or unresolved continuity failure terminates the stream, while only physical carrier loss selects automatic resumption. `SessionControlStream` is a Gateway `RemoteSnapshotStream`; every generation opens with a complete process-local baseline, so reconnect replaces queue, jobs, and projection state instead of treating transient values as durable events.

The Session object also carries local submission echoes: `session.beginSubmission` inserts one into `SessionSnapshot.pendingSubmissions` synchronously, before the caller serializes and prompts, so a conversation UI can show the message on the submit click's own frame. The prompt's `requestId` is the correlation identity — the Host already echoes it as the durable user source's `rpcId`, and queue occurrences project it as `SessionQueuedItem.rpcId`. An echo retires one animation frame after its durable event or queue occurrence is observed (the delay keeps it renderable until the transcript node is), immediately when its identified prompt fails or is abandoned, and as failed on disposal; each retirement fires the registered `onRetire` callback exactly once. Echoes are Client memory only — reload and reconnect rebuild the conversation from durable events alone.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `coldBlankProbeMaxBytes` | `1,024` | Maximum physical size of a cold Session artifact eligible for blankness verification; `0` disables probes |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-session-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as invoked Agent commands own any model-visible effect.

#### KV Cache effect

No direct effect; model requests remain owned by the Agent and LLM packages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Control baselines represent process-local state and therefore cannot reconstruct jobs after a Host restart.
- A failed follow resumption remains visible to the caller instead of retrying indefinitely.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
