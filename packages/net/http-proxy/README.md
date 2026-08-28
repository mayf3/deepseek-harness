---
description: "Outbound HTTP proxy support for the harness: how one policy resolved from the launch environment reaches every request Node's fetch would otherwise send direct."
kind: "package-reference"
---

# @deepseek-ai/dsh-http-proxy

English | [中文](README.zh.md)

## Summary

Node's built-in `fetch` ignores `HTTP_PROXY` and `HTTPS_PROXY`, so a harness behind a proxy would connect directly no matter what the user exported — the LLM request, every web search, MCP over HTTP, telemetry, and the sandbox SDK alike. This package resolves one proxy policy from the launcher's environment snapshot and installs it as undici's global dispatcher, which is exactly what `fetch` resolves. Ordinary call sites therefore need no change and no import: they write `fetch()` and are proxied. The package also owns the three places a global dispatcher cannot reach — a caller that needs its own agent options, a worker thread with its own `globalThis`, and a spawned child Node — and gives each one a single supported way through.

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

Nothing to mount. The `dsh` launcher resolves and installs the policy for every profile before the first plugin loads, so a user who exports `HTTPS_PROXY` is proxied everywhere. Mount the plugin only when a composition wants the policy declared in `cordis.yml` instead of the environment.

### Writing a new outbound call

Plain `fetch()` is proxied, and so is any SDK that reaches `globalThis.fetch` — the MCP HTTP transport and the pi-ai provider stack both do. An SDK that builds its own transport does **not**, and two of the ones this repository ships turned out to: the OTLP exporter posts through `node:http`, and the E2B SDK constructs its own undici dispatcher. Assume nothing about an SDK; check it.

| You are writing | Use |
|---|---|
| A call needing its own agent options (pool size, timeouts, a DNS lookup) | `createDispatcher(url, options)` |
| An SDK that takes a `node:http` agent | `createNodeHttpAgent(protocol, options)` |
| An SDK that takes a proxy URL of its own | `proxyUrlFor(url)` |
| A spawn whose environment you build yourself | apply `childProxyEnv()` to it (`undefined` means remove) |

Constructing `new Agent(...)` and passing it as `dispatcher` overrides the global one and silently bypasses the proxy. `verify-no-bare-dispatcher` rejects that outside this package; a line that must genuinely ignore the proxy says so with a `proxy-exempt:` comment.

That gate cannot see inside an SDK, so every outbound call site in the repository also carries an `egress.spec.ts` that drives its real code path through a fake proxy and asserts the proxy saw the request. A new call site adds one. It is the only thing that catches an SDK changing transports underneath us — which is exactly how the OTLP and E2B gaps were found.

### What the policy reads

`http_proxy`, `https_proxy`, `no_proxy`, and `all_proxy`, lowercase first and uppercase as the fallback, with a blank value treated as unset. `ALL_PROXY` backs both schemes, and HTTPS falls back to the HTTP proxy last — neither Node nor undici derives the first of these on its own. Values come from the launcher's snapshot, so a proxy declared in a project or `$DSH_HOME` `.env` layer works too; real environment variables still outrank both.

Loopback is always bypassed. The harness's own Web UI, Connection transport, and every local test server would otherwise route through the proxy and loop.

### Failures

A proxy value the package cannot use — a SOCKS or PAC URL, an unparseable string, an unsupported scheme — is reported and skipped, and the process connects directly. That variable may have been exported for other tools, so it must not stop the agent from starting. The same value supplied through this plugin's `Config` throws at load instead: that is the harness's own configuration surface, where a typo has to be loud.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

**One resolution, one matcher.** `proxyForUrl()` and the installed dispatcher must never disagree about a URL, or `dsh-web-fetch-http` would pin a connection the dispatcher meant to tunnel. The dispatcher is therefore an `Agent` whose per-origin `factory` calls `proxyForUrl()` itself, so there is no second parser to drift from the first. undici's `EnvHttpProxyAgent` cannot serve here: with no `HTTPS_PROXY` present it reuses the HTTP proxy for `https:`, which would tunnel a scheme this package keeps direct after refusing the URL the user named for it.

**A child inherits the user's own values, and the resolved policy for what they left unset.** A scheme the user named in either casing reaches a child exactly as they wrote it, so a SOCKS proxy `curl` uses is never replaced by an HTTP one named for another scheme. A scheme they named in neither casing carries the resolved value instead, because otherwise the child's routing diverges from its parent's: Node's `NODE_USE_ENV_PROXY` reads neither `ALL_PROXY` nor a proxy that came from `cordis.yml`. The bypass list is always the resolved one — it only ever adds the loopback entries, so nothing the user wrote is lost. The cost of one routing answer for parent and child alike is that `curl` also sees the `https:` proxy this package derives from the HTTP one.

### Source map

| File | Holds |
|---|---|
| `src/policy.ts` | Resolution, bypass matching, and redaction. Imports no transport, so it stays loadable where undici is absent. |
| `src/install.ts` | The global dispatcher, the active-policy record, `createDispatcher`, and `childProxyEnv`. Imports undici dynamically. |
| `src/index.ts` | Re-exports both halves and the optional Cordis plugin. |

### Bypass matching

An entry matches an exact host, a `.suffix` or `*.suffix` domain, an optional `:port`, or `*` for everything. A bracketed or bare IPv6 literal matches either way — a bare `::1` is *not* read as host `:` port `1`, which is how undici's own matcher fails and why the resolved list carries both `::1` and `[::1]`. CIDR is not matched: an operating system's bypass list often carries `10.0.0.0/8`, which has to be rewritten as suffixes.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Network proxy guide](../../../docs/user/guide/network-proxy.md) — what to export, and why a browser is proxied when a terminal is not.
- [`dsh-web-fetch-http`](../../web/web-fetch-http/README.md) — the one consumer whose safety rules change under a proxy.

-----

<a id="model-experience"></a>
## Model Experience

None, as transport policy only: it changes how bytes reach the network and registers no prompt, schema, or result text.

#### KV Cache effect

No direct invalidation: the package contributes no request tokens and never mutates a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the package is a poor fit. They are current package constraints.

- **No SOCKS, PAC, or operating-system proxy detection** — only `http(s)://` proxy URLs from the environment or configuration. A macOS or Windows system-proxy setting is not read, so a user who only toggled it in a proxy application must still export the variables; a SOCKS URL is reported and that scheme stays direct rather than borrowing another scheme's proxy.
- **No custom certificate authority** — a TLS-intercepting corporate proxy needs `NODE_EXTRA_CA_CERTS` set on the process before launch, which this package neither sets nor validates.
- **A separate Node context honors the policy only on a new enough runtime** — a spawned child reads it through Node's `NODE_USE_ENV_PROXY` (22.21+, 24+), and the OTLP exporter's agent through Node's `proxyEnv` option (22.21+, **24.5+**). The engines range admits 22.19, 22.20, and 24.0–24.4, where those two paths stay direct. Such a context also matches bypass entries with Node's own `NO_PROXY` rules, which differ from this package's in their separators and IPv4-range support.
- **A worker that executes model-authored code gets no proxy at all** — neither the `code-runtime` worker nor the `workflow` worker receives proxy configuration, so their own requests go direct. A proxy URL may carry `user:password`, and both run scripts the model wrote.
- **The regression gate sees source, not dependencies** — `verify-no-bare-dispatcher` parses `packages/*/*/src` and `apps/*/src`; tests, scripts, and the internals of a third-party SDK are outside it. That is why every outbound call site also carries an `egress.spec.ts`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Reaching Node's built-in `fetch` from a userland undici relies on both writing the legacy `Symbol.for('undici.globalDispatcher.1')` slot. That is an implicit cross-version coupling, not a contract — see [corepack#834](https://github.com/nodejs/corepack/issues/834) for it breaking. `tests/install.spec.ts` asserts a real request reaches a loopback proxy, so a version bump that breaks the coupling fails there rather than in the field.

</details>
