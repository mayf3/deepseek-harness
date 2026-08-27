---
description: "Package map for the network group: process-wide outbound transport policy that applies to every request the harness makes."
kind: "package-group"
---

# net/ — outbound network transport

English | [中文](README.zh.md)

## Summary

The `net/` group owns transport-level decisions that apply to every outbound request the harness makes, regardless of which capability makes it. Today that is one decision — whether a request goes through an HTTP proxy — and one package that owns it. The group exists because such a decision belongs to no single capability: an LLM adapter, a web-search backend, an MCP transport, and a telemetry exporter all inherit it without knowing about each other, and putting it inside any of their groups would make the other three depend backwards. These packages are not capability seams: transport policy has one implementation and one answer per process, so there is nothing to swap.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`http-proxy/`](http-proxy/README.md) | Resolves one outbound proxy policy and installs it as the process's global dispatcher | none — installed by the launcher |

-----

<a id="related-documentation"></a>
## Related documentation

- [Network proxy guide](../../docs/user/guide/network-proxy.md) — the user-facing page: what to export, and why a browser is proxied when a terminal is not.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
