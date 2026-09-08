# Agent Note: DeepSeek through the Anthropic Messages protocol

Status: implemented

English | [中文](2026-09-07-deepseek-messages-adapter.zh.md)

## Problem

Deployments expose DeepSeek through Anthropic Messages gateways as well as chat-completions. Messages represents thinking, signatures, tool calls, tool results, and cumulative usage differently. Translating only the endpoint or flattening assistant history loses information needed by subsequent tool turns.

## Decision

The [Messages adapter](../../../../packages/llm/llm-deepseek-messages/README.md) owns a separate provider route and configuration namespace. It sends one HTTP request per attempt, delegates SSE framing to `eventsource-parser`, and translates content-block events into the existing LLM stream protocol. The [twin-adapter decision](../architecture/2026-06-13-twin-llm-adapters.md) continues to govern the direct-fetch and library-backed implementations; Messages adds a direct protocol implementation without changing the agent loop.

The adapter follows the [DeepSeek compatibility documentation](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) and [Anthropic streaming protocol](https://platform.claude.com/docs/en/build-with-claude/streaming). The pi-ai Anthropic implementation informed the handling of adjacent user messages, cumulative usage, fragmented tool arguments, and optional thinking signatures. DeepSeek effort uses `output_config.effort`; an Anthropic thinking token budget does not control DeepSeek effort.

Assistant blocks remain the durable model-visible content. A versioned `ReplayEnvelope` stores only the model identity, aligned block kinds, and signatures absent from those blocks. Same-model continuation restores signatures verbatim, including empty signatures; foreign history carries no invented signature. Unusable metadata follows the existing [replay degradation rule](../architecture/2026-07-14-provider-routed-llm-adapters.md): the request omits signatures with a warning while preserving durable content; content validation such as tool argument parsing still fails explicitly. This keeps provider replay data opaque to the loop while preserving it through Session persistence and block pruning.

Image requests use bounded inline base64 versions from the attachment service. Shared attachment offload and DeepSeek token measurement keep request and measurement policy consistent. Files uploads remain outside this adapter because their endpoints and cache ownership differ from chat-completions; adding them requires a Messages-specific lifetime and error policy.

System updates use the existing [route capability](2026-09-02-in-history-system-prompt-replacement.md) when explicitly declared for an endpoint/model. Messages retains the initial top-level system and emits later snapshots as native system turns after the corresponding user/tool-result turn, preserving previously sent prefixes. This placement differs from the loop's system-before-user admission; serialization changes neither the durable log nor conversation-turn order. Undeclared routes consolidate the latest snapshot at the top level, including direct compaction calls. Capability inference from protocol or model names is insufficient because support and update semantics depend on the deployed endpoint.

The Web profile selects the Messages adapter and disables the Chat Completions adapter. Both its settings card and model group display DeepSeek, while the provider id remains `deepseek-messages` and settings remain under `llm-deepseek-messages`. First-run onboarding targets that route and reuses `DEEPSEEK_API_KEY`. Separating display names from provider ids preserves explicit protocol selection and recorded request identity. Saved selections remain user-owned; the composer switches them without rewriting Session history.

## Alternatives considered

**Add a protocol switch to `llm-deepseek`.** This couples two serializers, endpoint roots, and replay formats under one route. Separate registration allows deployments to select the protocol explicitly and mount both adapters.

**Delegate the new route to pi-ai or the Anthropic SDK.** Both provide maintained protocol implementations, but the requested direct adapter needs DeepSeek-specific configuration, attachment policy, credential resolution, and retry ownership. A small stream translator with a maintained SSE parser keeps these responsibilities explicit; the library-backed adapter remains available independently.

**Persist complete native responses or flatten thinking into text.** Full responses duplicate logged content and complicate truncation alignment. Flattening changes the next model input. Minimal aligned replay metadata preserves the missing protocol information without a new Session format.

**Always rewrite the top-level system prompt.** This discards the cache-preserving native update path on capable routes. Explicit capability selection keeps that path while retaining ordinary replacement for other endpoints; converting system instructions to user text would also lose their priority.

## Consequences

The package owns wire validation, stop-reason mapping, cancellation, and error classification, so protocol changes require adapter maintenance. Unsupported content and incomplete streams fail explicitly. The existing retry consumer owns retries; the existing assembler drops incomplete tool calls at the output limit. The shared base keeps Chat Completions; the Web overlay owns the Messages default.

Verification covers wire fixtures, real Loader composition, per-file unit coverage, [recorded Session replay](../../../../snapshots/session/deepseek-messages-replay/snapshot.yml) with [unknown replay versions](../../../../snapshots/session/deepseek-messages-degraded-replay/snapshot.yml), a Web Messages Session replay, and credential-gated text, thinking, tool continuation, image, and cancellation requests. Live gateway checks establish compatibility with the configured gateway; they do not establish compatibility with every Anthropic proxy.
