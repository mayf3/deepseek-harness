---
description: "Stream DeepSeek through Anthropic Messages with thinking, tools, inline images, and durable replay."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-deepseek-messages

English | [中文](README.zh.md)

## Summary

Use DeepSeek through an Anthropic Messages endpoint while retaining Harness tools and Session history. The `deepseek-messages` route can run beside the Chat Completions and pi-ai adapters. Connection settings and credentials take effect on the next request. Images use bounded inline base64 content.

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

Mount this plugin beside `dsh-llm` in a Cordis composition and select `provider: deepseek-messages`. Model ids pass through unchanged; the catalog is advisory.

The [Web profile](../../bundle/web-app/README.md) uses this adapter as its default DeepSeek provider and disables Chat Completions. The **DeepSeek** card and first-run prompt use `DEEPSEEK_API_KEY`; endpoint and model edits apply live under `llm-deepseek-messages`. The provider id remains `deepseek-messages` independently of its display name.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek-messages'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://api.deepseek.com/anthropic
    thinking: enabled
    reasoningEffort: high
    maxTokens: 256000
    streamIdleTimeoutMs: 300000
```

`baseURL` is the protocol root: the adapter appends `/v1/messages`. Set a gateway root without `/v1/messages` or a trailing `/v1`. An explicit value wins over `DEEPSEEK_MESSAGES_BASE_URL`, then the public DeepSeek default. The plugin does not read `ANTHROPIC_API_KEY` or the Chat Completions endpoint variable.

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference; credentials service, or launch environment when that service is absent |
| `thinking` / `reasoningEffort` | enabled / high | `off`, `low`, `high`, `max`; disabled deployment policy permits only off |
| `models` | V4 Flash, Pro, Flash Vision Exp | Advisory catalog and exact-model capacity/image overrides |
| `maxTokens` / `defaultContextWindow` | 256000 / 1000000 | Default output cap and context capacity |
| `maxInlineRequestImageBytes` / `maxImagesPerRequest` | 20 MiB / 600 | Retained base64 bytes and image occurrences |
| `streamIdleTimeoutMs` | 300000 | Maximum idle wait for the provider |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-deepseek-messages) lists every field. A `llm-deepseek-messages` settings section overrides composition fields; an invalid generation retains the complete last good connection. Requests retain one settings snapshot, including the credential reference.

### Request behavior

Tools use native `tool_use` and `tool_result` blocks. Adjacent user messages are combined with tool results first, preserving call ids. Leading system messages join the top-level system prompt; a mid-conversation system message is rejected. Thinking uses `output_config.effort`; title requests disable it. A temperature supplied with thinking enabled fails with `UNSUPPORTED_OPTION`.

Vision routes resolve durable attachments into deterministic request images with a default 640000-pixel and 1 MiB target per image. Oldest-first offload applies before normalization using durable bytes and again using exact encoded bytes. Each retained image carries the standard attachment descriptor; tool-result images remain inside that result. Unlisted and text-only routes receive the shared text-only attachment projection.

Successful streams persist minimal native replay metadata alongside standard assistant blocks. Own-model signatures return unchanged, including signatures on empty thinking blocks. Cross-model or foreign history sends thinking without borrowed signatures. Unusable native replay metadata is omitted with a warning; durable content remains unchanged and thinking is sent without signatures. Malformed complete tool JSON is rejected, while max-token truncation lets the shared assembler remove unfinished tool calls.

Transport and provider failures become stable `LlmError` codes, including `AUTH`, `QUOTA`, `RATE_LIMIT`, `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`, `TIMEOUT`, and `ABORTED`. Missing credentials fail before HTTP. EOF before `message_stop` is `STREAM_CLOSED`. `llm-retry` owns retries; the adapter never retries a model request itself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter separates [configuration](src/config.ts), [history conversion](src/serialize.ts), [image projection](src/images.ts), [stream translation](src/translate.ts), and [native replay](src/replay.ts). `eventsource-parser` owns SSE framing. A single abort controller and idle watchdog cover each request and close its reader when the consumer stops. The Chat Completions package supplies only its public DeepSeek image-token calculator; importing it does not mount its provider.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM service](../llm/README.md) — provider registration and stream obligations.
- [Chat Completions adapter](../llm-deepseek/README.md) — DeepSeek Files support.
- [Messages decision](../../../.agents/notes/implemented/feature/2026-09-07-deepseek-messages-adapter.md) — protocol and replay choices.
- [DeepSeek compatibility](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) — provider-supported fields.

<a id="model-experience"></a>
## Model Experience

### Messages request and response

#### What the model sees

The model receives the assembled `system` prompt, ordered text/thinking/tool history, tool schemas, and retained inline images. Native signatures remain adapter metadata until historical thinking is serialized. No reasoning text is converted into an ordinary answer. Image descriptors and offload placeholders use the shared attachment projection.

#### Token effect

Usage counters are cumulative and disjoint: uncached input, cache reads, cache writes, and output. The adapter emits usage before finish and derives the full total from those counters. Image pricing reproduces the durable-byte offload decision; further offload after actual encoding can reduce the estimate. Thinking contributes to the output cap and, when passed back, later input.

#### KV Cache effect

Stable message order and verbatim thinking preserve reusable prefixes. Endpoint/model changes, tool schemas, image offload, or changed execution-world paths can invalidate a prefix. The adapter does not send Anthropic cache-control hints because DeepSeek ignores them.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The adapter implements the DeepSeek Messages subset:

- Images are inline only; Files upload, cache, and expiry management are deferred.
- Native server tools, redacted thinking, document blocks, and structured output are unsupported.
- `tool_choice` is absent from the Harness request interface. DeepSeek ignores `tool_result.is_error`; the error body still crosses unchanged.
- DeepSeek request-extension uploads are not attached to Messages requests. Gateway-specific support needs separate validation.
- Unknown model ids pass through; DeepSeek may substitute its default model for an unsupported id.

**Runtime invariant:** No companion is published: the adapter owns no independently observable mutable relationship beyond the LLM stream and registration contracts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
