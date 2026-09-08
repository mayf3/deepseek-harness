---
description: "The image offload executor for deployments composing compaction: what happens when an image-capable route rejects a request as over its image budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-image-offload

English | [中文](README.zh.md)

## Summary

`dsh-compaction-image-offload` keeps image-heavy conversations sendable. When an image-capable route fails a request with `IMAGE_OFFLOAD_REQUIRED`, naming how many of the oldest retained images no longer fit its budget, the plugin replaces each surface node carrying one of those images with a copy whose image blocks are marked `offloaded`, prices the replaced node through the compaction seam's `compaction/prune` protocol, and retries the step. Every route then sends placeholder text naming the image and its read-only path instead of the image. Like the other compaction executors, the replacement is a durable surface fact: it never reverts, so the images the model sees and the provider cache prefix move only forward.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in every composition that runs the agent loop with an image-capable route and the token meter. The shipped `dsh` base does. Without it, an `IMAGE_OFFLOAD_REQUIRED` failure reaches ordinary recovery and ends the turn as an error. The plugin has no configuration: the DeepSeek adapter enforces its file-mode and inline-fallback budgets, the pi-ai adapter its base64 bound, and each reports the count it needs offloaded.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-compaction-image-offload'
```

### What you can observe

Each offload appends, per replaced node, one `compaction/prune` event carrying the node's heuristic token price and then the replacement node itself: a `user/message` or `tool/result` copy of the original with the affected image blocks marked `offloaded: true`, a `surfaceOp` of `replace`, and `sourceEventSeqs` naming the original. The original event stays in the log untouched. The retried request follows; the loop logs a fresh `request/header` after the surface change, as it does after any compaction.

### Failures and recovery

The plugin acts only on `IMAGE_OFFLOAD_REQUIRED` failures that carry `offloadImages`. It walks the surface in model request order, skips assistant nodes and images already marked, and marks that many occurrences. When nothing remains to offload it delegates on the `agent/request-error` waterfall, so downstream recovery or the ordinary turn error applies. The retry spends no provider retry budget and logs no `llm/retry` event.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin is one function plugin with one `agent/request-error` listener. `offloadOldestImages()` walks `session.surface.nodes`, marks the first `offloadImages` retained occurrences across `user/message` and `tool/result` nodes, nested tool results included, and for each changed node appends the `compaction/prune` shadow price followed by the marked copy under `surfaceOp: { op: 'replace' }`. It reuses the compaction seam's events and the session's replacement mechanism; no session or agent-loop change exists for it.

No runtime invariant companion is published: Session validates each replacement's surface metadata, and the `compaction/prune` protocol is owned by the compaction seam's companion.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Durable image offload by surface replacement](../../../.agents/notes/implemented/architecture/2026-09-02-durable-image-offload.md) — the decision this executor implements and the alternatives it replaced.
- [compaction seam](../compaction/README.md) — the `compaction/prune` shadow-price protocol.
- [compaction-tool-result-pruner](../compaction-tool-result-pruner/README.md) — the sibling executor that trims tool outputs by the same replacement mechanism.
- [dsh-llm](../../llm/llm/README.md) — `ImageBlock.offloaded`, `IMAGE_OFFLOAD_REQUIRED`, and the placeholder projection.
- [llm-deepseek adapter](../../llm/llm-deepseek/README.md) and [llm-pi-ai adapter](../../llm/llm-pi-ai/README.md) — the route budgets that report offload counts.

-----

<a id="model-experience"></a>
## Model Experience

### Offloaded request images

#### What the model sees

Every image occurrence a replacement marked reaches the model as the route's placeholder text (`offloadedImageText`) naming the attachment and its read-only path instead of the image; unmarked occurrences stay images. The set never shrinks on its own, so the model can rely on an offloaded image staying offloaded and read it back through the path when it needs the content again.

#### Token effect

An offloaded occurrence costs its placeholder text instead of visual tokens. The token meter prices the replaced node from the marks on the surface.

#### KV Cache effect

A replacement turns earlier images into placeholder text, so provider cache reuse ends at the first replaced message for that request. Because the replacement never reverts, the prefix stays stable afterwards.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Offloaded images never return automatically** — a larger budget, a larger route, or compaction lowering the total leaves the marks in place; recovery is the read-only path in the placeholder.
- **Every offload costs one failed attempt** — nothing plans an offload before dispatch; the route's rejection is the signal, which matches the planned move to provider-reported uncacheable images.
- **A temporary small budget offloads permanently** — a Files outage that forces the inline fallback, or a temporary switch to a small-budget route, offloads images a later route would have sent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The route-local byte checks that produce `IMAGE_OFFLOAD_REQUIRED` are provisional: once the provider reports uncacheable images itself, the adapters map that report to a count and this executor stays as it is.

</details>
