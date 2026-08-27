---
description: "Legacy HTTP transport for Host bootstrap metadata and streamed Session-log ZIP downloads while generated Typert Remotes own business operations."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-apiproxy

English | [中文](README.zh.md)

## Summary

`dsh-host-apiproxy` carries the two Host operations that do not yet belong to a generated business Remote: the `host.describe` bootstrap snapshot and streamed Session-log ZIP downloads. Its browser-safe envelope and fetch adapters serve HTTP and in-process clients, while API Gateway carries all ordinary business operations. The shipped Web composition assembles both transports in [`dsh-web-app`](../../bundle/web-app/README.md).

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

Compose this package when a GUI host needs bootstrap metadata and Session-log export: load `ApiProxyService`, wrap `ctx.apiProxy` in a carrier, and use generated Remotes for all other business calls.

### Choosing a carrier

`toFetchHandler(api)` turns the gateway into a pure WHATWG fetch function for an HTTP server (the shipped Web composition exposes it behind `/api/…` routes), while `InProcessApiClient` runs the same serialization and validation path in-process — the isomorphic point for callers and tests that need the full wire path without a network.

```text
const client = new InProcessApiClient(toFetchHandler(ctx.apiProxy))
const response = await client.host.describe({})
```

The HTTP carrier refuses non-JSON POST bodies with 415 before dispatch, so cross-site simple requests can never run a side-effectful method blind. The browser carrier applies the same Host/Origin checks and signed-cookie authentication to every Host API method ([`dsh-client-connection`](../../client/connection/README.md)); individual Client features may still withhold native or persistent operations on non-loopback pages.

### What the gateway exposes

The unary map contains only `host.describe`; the direct download route is `GET` or `HEAD /api/session.export`. Session, workspace, settings, credentials, LLM, skill, file-reference, command, and interaction operations are generated Remotes owned by their business packages and assembled by [`dsh-api-remotes`](../../api/remotes/README.md).

### Exporting sessions

`GET /api/session.export?sessionId=…&includeDescendants=true` streams a ZIP of the session's stored artifact text verbatim, every subagent descendant under `subagents/<id>/`, and each referenced image under `media/<attachmentId>.<ext>`. `HEAD` runs the same root preparation without a body, so browsers detect pre-stream failures before handing the GET to the download manager. The response is chunked as it is produced, and `sessionExportCompressionLevel` (0–9, default 6) trades CPU and latency against archive size. Missing persistence, session-query, or attachment services answer 500, a backend without per-session raw artifacts 501, and a missing root session 404.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `nativeOpen` | platform-detected | Whether the deployment can hand paths to a native desktop opener |
| `sessionExportCompressionLevel` | `6` | DEFLATE level for every session-log ZIP entry, 0–9 |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-apiproxy) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The package is built on one separation: the API contract is channel-independent, and physical transports are carriers around it. Wire messages form a two-member discriminated union — `ClientRequest` (the POST `/api/<method>` body) and `ServerResponse` (that POST's response body) — decoupled from the physical channel. Responses always echo the matching request's `rpcId` and never mint a new one. Business errors ride the `RpcResult` error branch with a closed `RpcErrorDetailsMap`; HTTP status expresses only the carrier. The layering and protocol decisions are recorded in the [GUI layering and RPC protocol RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md).

### Source map

| File | Role |
|---|---|
| [`src/api/`](src/api/) | Contract layer: domain interfaces, payload types, zod schemas, `RpcMethodMap` — zero Node dependencies |
| [`src/fetch/handler.ts`](src/fetch/handler.ts) | Host carrier: `toFetchHandler`, envelope parsing, unary dispatch, session export |
| [`src/fetch/client.ts`](src/fetch/client.ts) | Client carrier: `AbstractApiClient` plus platform subclasses, `InProcessApiClient` |
| [`src/api-proxy.ts`](src/api-proxy.ts) | Gateway implementation: `createApiProxy` over the composed host context |
| [`src/session-export.ts`](src/session-export.ts) | Session-log ZIP export: raw artifact reads, media collection, fflate streaming |

### The gateway service

`ApiProxyService` provides `ctx.apiProxy`, reports process metadata through `host.describe`, and delegates Session archive production to the persistence, query, attachment, and live Session services. The Host cwd is the default project directory. Product `dsh --profile headless` is a direct core entry point and does not mount this package.

### Request flow

A `host.describe` request enters the fetch carrier, which parses the envelope and payload, dispatches the method, and returns a response echoing the request's `rpcId`. Session export bypasses that envelope because its streamed ZIP body and HTTP status are the result.

### What the gateway owns

The package owns its legacy envelope, Host bootstrap snapshot, and archive download. API Gateway owns generated Remote dispatch and streams; business packages own their methods and result types.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the package-level contract is not enough. They move from the layering decision to the browser-side consumption architecture and the adjacent subsystems.

- [GUI layering and RPC protocol RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) — the layering model and the channel-independent message protocol.
- [Web client architecture RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how the browser consumes the API.
- [Browser HTTP carrier](../../client/connection/README.md) — Host/Origin checks, signed-cookie authentication, and the routes the shipped Web composition registers.
- [Web-server subsystem](../../../docs/subsystems/web-server.md) — the HTTP server the carrier rides on.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-host-apiproxy) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the wire contract and fetch carriers move already-composed messages and register nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define where the gateway is a poor fit; they are current package constraints, not a task backlog.

- **No protocol version field** — client and host ship together; `host.describe` gains a version negotiation field only when an independently released client exists.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above. A protocol version field waits for an independently released client; a multi-user carrier must replace provider search diagnostics with public-safe text; per-connection picker adaptivity (native for a local browser, browse for a remote one) remains an undecided direction for the host surface.

</details>
