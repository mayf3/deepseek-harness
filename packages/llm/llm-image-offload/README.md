---
description: "The image-offload plugin for users and maintainers keeping request images within each route's budget through the session's durable image/offload watermark."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-image-offload

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-image-offload` keeps request images within each route's budget by advancing the session's durable `image/offload` watermark. Before a step enters, it plans the watermark from the request-image budget the routed model declares and the image occurrences the surface still sends; when an adapter fails an attempt with `IMAGE_OFFLOAD_REQUIRED`, it advances the watermark by the count the failure names and retries the step. The watermark only advances, so the images the model sees and the provider cache prefix move only forward, and every dispatched request's image set is determined by the session log alone.

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

Mount this plugin in every composition that runs the agent loop with an image-capable route. Without it, an image-capable adapter whose budget is exceeded fails the step with `IMAGE_OFFLOAD_REQUIRED` and no recovery advances the watermark. The plugin has no configuration: the DeepSeek adapter declares its file-mode budget and the pi-ai adapter its base64 bound as `imageRequest` on their resolved model info.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-image-offload'
```

### What you can observe

Each advance is one durable `image/offload` event carrying the turn, the step, and the watermark: the seq of the event carrying the last offloaded occurrence and the block path inside its content. A pre-step advance lands after `turn/start` and before `step/start`; a failure-driven advance lands after the `assistant/attempt` it answers and before the retried request. `session.imageOffloadWatermark()` reads the watermark in force, and every derived image block at or before it carries `offloaded: true`, which each route renders as placeholder text naming the image and its read-only path.

### Failures and recovery

The pre-step plan reads the route the latest `request/header` names and covers the surface as it stands before the step's own messages are appended; it skips before the first header, for a route without an adapter, and for a route that declares no budget. Occurrences the plan cannot see, and occurrences whose exact request bytes exceed the budget only at serialization, reach the model through one failed attempt: the adapter fails with `IMAGE_OFFLOAD_REQUIRED` and `offloadImages`, the plugin advances by that count on the `agent/request-error` waterfall and returns the `retry` action. When nothing remains to offload the plugin delegates, so the failure reaches downstream recovery and otherwise ends the turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin is one function plugin with two listeners. On `agent/pre-step` it awaits the downstream decision, and for an `enter` decision resolves the routed budget through `ctx.llm.resolveModelInfo()`, walks the surface nodes through `Session.deriveEventMessage()` collecting every retained occurrence in request order with its durable position, and plans the removal prefix with the pure `offloadedImagePrefixCount()` over the occurrences' represented bytes. On `agent/request-error` it handles only `IMAGE_OFFLOAD_REQUIRED` failures carrying `offloadImages`. Both paths append one `image/offload` event naming the greatest durable position in the request-order prefix, which a surface replacement can place before older events; the advance may offload additional occurrences but always covers the prefix. Adapters never append the event: the session surface has one owner of its offloaded set.

No invariant companion is published: `Session.append` and seeding already reject a malformed, non-advancing, or off-surface watermark, so no independent observation can diverge from the event the plugin appends.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Durable image offload watermark](../../../.agents/notes/implemented/architecture/2026-09-02-image-offload-watermark.md) — the decision this plugin implements and the alternatives it replaced.
- [dsh-session](../../core/session/README.md) — the `image/offload` event, its validation, and the marked derivation.
- [dsh-llm](../llm/README.md) — `LlmImageRequestBudget`, `IMAGE_OFFLOAD_REQUIRED`, and the shared image walk.
- [llm-deepseek adapter](../llm-deepseek/README.md) — the file-mode budget and inline fallback that report offload counts.
- [llm-pi-ai adapter](../llm-pi-ai/README.md) — the base64 bound that reports offload counts.

-----

<a id="model-experience"></a>
## Model Experience

### Request-image offload

#### What the model sees

Every image occurrence at or before the watermark reaches the model as the route's placeholder text (`offloadedImageText`) naming the attachment and its read-only path instead of the image; occurrences after it stay images. The set never shrinks on its own, so the model can rely on an offloaded image staying offloaded and read it back through the path when it needs the content again.

#### Token effect

An offloaded occurrence costs its placeholder text instead of visual tokens. The token meter prices the current surface under the current watermark and each usage anchor under the watermark its request was derived with.

#### KV Cache effect

An advance replaces earlier images with placeholder text, so provider cache reuse ends at the first replaced message for that request. Because the watermark never retreats, the prefix stays stable afterwards.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Offloaded images never return automatically** — a larger budget, a larger route, or compaction lowering the total leaves the watermark in place; recovery is the read-only path in the placeholder.
- **The pre-step plan is one step behind the entering messages** — images a user message or the step's own tool results add reach the model through one failed attempt when they push the retained set past the budget.
- **A temporary small budget advances permanently** — a Files outage that forces the inline fallback, or a temporary switch to a small-budget route, offloads images that a later route would have sent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: notes for maintainers and open questions. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The pre-step plan walks every surface node on each step of a route with a budget; nothing caches the retained set. Revisit only with profiling evidence from long image-heavy sessions.

</details>
