---
description: "Query the calling process's network exit country with bounded HTTP responses and caller-owned cancellation."
kind: "package-library"
---

# @deepseek-ai/dsh-ip-geolocation

English | [中文](README.zh.md)

## Summary

Query the country associated with the calling process's public network exit. `lookupIpCountry` accepts a JSON country endpoint, an abort signal, and a response-byte limit. Consumers choose their own endpoint, deadline, caching, and business rules; the library retains no IP address or lookup result.

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

Call `lookupIpCountry` from the process whose exit matters. The [plugin installation dialog](../../client/ui-plugin-manager/README.md) calls it on the Host, where pnpm downloads packages. This library registers no Cordis service or event.

Supply an HTTP(S) endpoint implementing the [GeoJS country response](https://www.geojs.io/docs/v1/endpoints/country/) or compatible caller-IP lookup, a cancellation signal covering the full operation, and a positive response-byte limit. An uppercase two-letter `country` field returns that code; JSON null or HTTP 404 returns null. Other HTTP errors, malformed data, cancellation, and oversized responses reject. Additional fields, including the returned IP, are discarded.

The request uses ordinary `fetch`, including the Host's configured [outbound proxy](../http-proxy/README.md). Redirects are rejected. Consumers own timeout and failure policy; no country is inferred from language or time zone.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`src/index.ts`](src/index.ts) bounds the complete streamed body before parsing JSON. It validates the country field and releases the reader after completion or failure. No runtime invariant companion is published because the library retains no independent state; transport and parser tests observe each call directly.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Shared utilities](../README.md) — neighboring libraries.
- [Plugin installation](../../client/ui-plugin-manager/README.md) — the consuming dialog's selection policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as the library registers no tools, prompt sections, or Session events.

#### KV Cache effect

None. Country lookup results do not enter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- IP geolocation estimates the network exit, which can differ from a person's location when using a proxy or VPN.
- The endpoint must return a two-letter `country` field. The library queries neither arbitrary supplied IPs nor city-level data.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
