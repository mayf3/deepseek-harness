---
description: "Share per-Session browser ownership and MCP activation across experimental browser providers."
kind: "package-library"
---

# @deepseek-ai/dsh-experimental-browser-use-runtime

English | [中文](README.zh.md)

## Summary

Browser providers use this library to reuse a browser across one Session's turns and close its resources when that Session's runtime is disposed. Operations for one Session run in order, while isolated Sessions can proceed independently. Attachment mode reserves one external browser for a single Session. The library also connects provider-owned MCP servers and discovers their tools before the Session's first model request.

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

This public experimental library is a dependency of the browser providers. It has no plugin entry or mount configuration. The [browser-use service](../../browser-use/browser-use/README.md) remains independent of the library.

Native providers construct `SessionResources` from the package root, supplying resource acquisition and cleanup callbacks. Calls pass the exact live Agent to `run()`; stale owners and a second owner of an exclusive attachment fail before acquisition. Canceling an acquisition wait leaves initialization available to other callers in the same Session; Session disposal aborts and awaits that initialization. Providers keep their registration until `dispose()` finishes.

MCP providers use `mountSessionMcp` from `@deepseek-ai/dsh-experimental-browser-use-runtime/mcp`. They supply their fixed server name, executable, arguments, and ownership policy. The helper mounts one scoped MCP client per live Session and discovers tools during `system-prompt/prepare`, before ordinary tool-schema collection for its first model request. A busy attachment leaves other Sessions without this provider's tools while their turns continue; after cleanup, a later request can acquire it. Startup or discovery failure rejects that step after cleanup. Reconnection is disabled; a closed client does not silently replace the Session's browser state.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [resource manager](src/index.ts) keys ownership by live Agent identity and joins operation cancellation with owner disposal. Each resource has one acquisition promise and one operation queue. Failed acquisition releases its reservation only after the provider callback rolls back acquired resources.

Disposed-cause cancellation starts resource cleanup before AgentHandle waits for idle. Cleanup closes resources before waiting for running operations, allowing connection teardown to interrupt upstream APIs without abort support. A failed close rejects disposal and retains ownership. Agent-scoped cleanup prevents a resumed Session with the same durable id from inheriting a previous browser.

The [MCP helper](src/mcp.ts) places discovery and execution in each Agent's scope. It retains the provider registration through resource cleanup and uses the [MCP client](../../mcp/mcp-client/README.md) for transport, schema discovery, result conversion, and durable image admission.

No runtime invariant companion is published: resource ownership and pending work are private lifecycle state, with no separately maintained runtime projection to compare. Owner tests cover isolation, disposal, and failed cleanup.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [MCP client](../../mcp/mcp-client/README.md) — discovery, cancellation, and result admission.
- [Browser ownership decision](../../../.agents/notes/implemented/architecture/2026-09-12-browser-use-provider-registration.md) — registration-only service and resource lifetime.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through provider-owned browser tools, whose catalogs the MCP helper discovers before model request assembly; providers and the MCP client own descriptions, schemas, results, and image behavior.

#### KV Cache effect

The library adds no prompt text. Discovered tool schemas and provider guidance determine request-prefix changes; ordinary browser resource reuse does not alter those schemas.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Providers remain responsible for the browser operations they supply.

- **Attachment scope** — exclusive ownership applies to one resource manager, not separate providers, processes, or external browser clients.
- **Cancellation** — abort signals and connection closure cannot undo browser actions already delivered. An upstream operation that ignores both can delay cleanup.
- **Recovery** — a failed close retains ownership; this manager does not retry disposal or restore browser state from the Session log.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
