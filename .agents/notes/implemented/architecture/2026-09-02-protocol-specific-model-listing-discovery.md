# Agent Note: Reading protocol-specific model listings

Status: implemented

English | [中文](2026-09-02-protocol-specific-model-listing-discovery.zh.md)

## Problem

The [draft provider interrogation](2026-08-04-draft-provider-endpoint-interrogation.md) originally read the OpenAI-compatible `data` array only. Some compatible gateways instead publish an enriched `models` object, while Anthropic publishes a native model-listing route with different authentication and URL rules. Treating either case as unsupported forced a user to copy model ids and capacities by hand even though the endpoint disclosed them.

One gateway could be made to return an OpenAI-style array by sending an OpenAI SDK `User-Agent`. That behavior was undocumented, changed request attribution, and made the reply depend on a client identity rather than on a supported response parser.

## Decision

`dsh-llm-pi-ai` reads model listings according to the selected protocol. `openai-completions` and `openai-responses` use `GET {baseURL}/models` with bearer authentication. `anthropic-messages` uses `GET /v1/models?limit=1000` with `x-api-key` and `anthropic-version: 2023-06-01`. The Anthropic page size is the documented maximum; discovery does not follow `has_more`, so an endpoint advertising more than 1,000 models exposes only its first page.

Anthropic SDK resource methods append `/v1` themselves. Discovery and inference therefore treat a configured Anthropic `baseURL` ending in `/v1` as the same API root as the address without that suffix. Deployment path prefixes remain intact: `https://gateway.example/tenant/v1` lists at `/tenant/v1/models` and sends messages to `/tenant/v1/messages`.

The parser accepts a `data` array or an enriched `models` object, with a present array taking precedence. Array entries use their `id`; object entries use the property key because a nested `id` may name a canonical model instead of the route alias accepted on requests. Only object-valued map entries are considered models, so primitive directory metadata cannot become a candidate accidentally. A nested `id` is the fallback for an empty property key.

The parser normalizes the supported name and capacity spellings into `LlmDiscoveredModel`. A missing display name becomes the request id so adoption fills a complete editable row. The request keeps the Harness attribution headers; response parsing, not client impersonation, provides gateway compatibility.

## Alternatives considered

**Follow every Anthropic page.** Cursor traversal would return listings larger than 1,000 entries, but it adds multi-request failure, cancellation, cursor-progress, and aggregate-size behavior to a configuration action. The implementation requests Anthropic's maximum page and documents the remaining truncation.

**Send an OpenAI SDK `User-Agent` for discovery.** This made one gateway return `data`, but it misattributed Harness traffic and relied on an undocumented client-name branch. Reading both known reply formats keeps attribution accurate.

**Adopt every property of a `models` object.** A primitive-valued property does not prove that its key is a model id and may be directory metadata such as a count or status. Restricting entries to records avoids inventing model candidates.

## Consequences

The Models page can interrogate OpenAI-compatible gateways and Anthropic Messages endpoints without changing request identity. Discovered candidates carry route ids, names, context windows, and output-token caps when the endpoint provides them, and name-only listings still receive an editable label through the id fallback. Anthropic addresses work in either root or `/v1` form for both discovery and inference.

The supported formats remain an explicit compatibility set rather than arbitrary JSON inference. Anthropic accounts with more than 1,000 visible models require hand-entry for entries outside the first page, and primitive-valued `models` properties are ignored.

## Testing

Local HTTP-server tests pin both accepted response formats, field normalization, name fallback, ignored malformed entries, Anthropic headers and the maximum-page query. Provider tests drive Anthropic requests through pi-ai and prove that root, `/v1`, and prefixed `/v1` addresses reach exactly one versioned Messages path.
