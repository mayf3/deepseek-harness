# Official DeepSeek LLM API wire extensions

English | [中文](deepseek-llm-api-wire-extensions.zh.md)

This reference defines every DeepSeek Harness-specific HTTP header and additive JSON field sent by [`@deepseek-ai/dsh-llm-deepseek`](../packages/llm/llm-deepseek/README.md) on `deepseek-official` chat-completion requests. It does not redefine fields owned by the upstream DeepSeek API. The provider-neutral LLM interface and `llm-pi-ai` do not implement these additions.

The adapter sends the additions to its resolved `baseURL`, including a configured gateway. They remain outside `messages`, system prompts, and tool schemas, so they do not add model-input tokens or alter the model-visible prefix.

## Wire namespaces and versioning

| Location | Naming | Examples |
|---|---|---|
| HTTP field names | Lowercase kebab-case; HTTP matching remains case-insensitive | `user-agent`, `x-deepseek-harness-session-id` |
| DeepSeek request-body extension fields | Snake case with the reserved `dsh_` prefix | `dsh_plugin_packages` |

Each body extension owns its `version` independently. A version applies only to the object that contains it; no compatibility or ordering relationship exists between versions of different fields. JSON member order is not part of the protocol.

The [`DeepSeekLlmApiExtensionRegistry`](../packages/llm/deepseek-llm-api-extensions/README.md) reserves one provider per top-level extension name. Empty or whitespace-padded names, duplicate registrations, and collisions with the base DeepSeek request fail before HTTP dispatch.

## Request headers

| Header | Presence | Value |
|---|---|---|
| `user-agent` | Every provider HTTP request, including Files API operations | Application identity in `product/version (+url)` form; the default product is `deepseek-harness` |
| `x-deepseek-harness-user-id` | Every authorized chat-completion request | The stable anonymous UUID for the resolved Harness home |
| `x-deepseek-harness-session-id` | Chat-completion requests carrying a Session id | The exact request `sessionId` string |
| `x-deepseek-harness-compact` | Chat-completion requests whose purpose is `compaction` | The literal string `1` |

Credential failure happens before anonymous-user-id resolution, so an unauthorized request neither sends these headers nor creates the identity file. A direct request without a Session omits `x-deepseek-harness-session-id`. Session-title requests have no additional purpose header; the ordinary Session-id rule still applies when one carries a `sessionId`.

## Body-extension transaction

The adapter serializes the complete base body, including the exact `messages`, before it asks registered providers to prepare fields. A provider receives that immutable body, the request cancellation signal, and optional `sessionId` and auxiliary-call `purpose`. Returning `undefined` omits that provider's field for the request.

Prepared JSON values are detached from provider-owned state, merged as top-level siblings of the base fields, and serialized in the same HTTP body. Preparation or collision failure prevents the request. A composition without the registry sends the unextended base body.

After the configured endpoint returns HTTP 2xx, the adapter runs the prepared `accept()` transaction before reading the SSE response body. Transport failures and non-2xx responses do not accept any contribution. An acceptance failure fails the model request even though the endpoint returned 2xx. Acceptance records endpoint-level HTTP success; it does not assert that an SSE stream completed or that the endpoint persisted an extension.

## `dsh_plugin_packages`

[`@deepseek-ai/dsh-plugin-package-inventory-deepseek`](../packages/llm/plugin-package-inventory-deepseek/README.md) contributes the complete active Loader-backed plugin package inventory. The field is enabled by default.

```json
{
  "dsh_plugin_packages": {
    "version": 1,
    "packages": [
      {
        "name": "@deepseek-ai/dsh-example",
        "version": "0.1.1-rc.2"
      }
    ]
  }
}
```

| Member | Type | Meaning |
|---|---|---|
| `version` | `1` | Schema version for `dsh_plugin_packages` |
| `packages` | array | Complete active set for this request |
| `packages[].name` | string | Exact non-empty npm package name from the owning manifest |
| `packages[].version` | string | Exact non-empty package version from the same manifest |

Every request re-reads active non-group Loader entries from the host tree and, when available for the request Session, its standing agent-preset tree. Relative and absolute modules use their nearest owning manifest; bare package entries follow the Loader resolution base that activated them. A named manifest without a non-empty version fails request preparation.

The sender deduplicates exact `(name, version)` pairs and sorts first by `name`, then by `version`, with a locale-independent text comparison. Simultaneously active versions of one package remain separate entries. Receivers must not collapse the array by package name or infer package activation from array order.

Disabled, pending, failed, unloading, disposed, and structural Loader entries are absent. Ordinary dependencies, loose modules without a named owning package, programmatically mounted child fibers, and in-memory dynamic plugins are also absent because they have no authoritative Loader package provenance.

An enabled inventory with no qualifying entries sends `packages: []`; disabling the contributor omits the entire `dsh_plugin_packages` field. Package identities are provider metadata and never enter model input.

## Exposure and receiver requirements

The request headers expose the Harness application version, one anonymous Harness-home identity, and an optional Session identity. `dsh_plugin_packages` exposes active npm package names and versions. A gateway selected through `baseURL` receives the same values as the official endpoint.

Receivers address extension fields by name, dispatch each field by its own `version`, preserve distinct package versions, and ignore JSON member ordering. The base request remains usable without either the registry or a particular contribution; field absence means that contribution did not apply to that request.
