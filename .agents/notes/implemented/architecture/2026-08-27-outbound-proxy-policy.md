# Agent Note: One outbound proxy policy, installed before anything can request

Status: implemented

English | [中文](2026-08-27-outbound-proxy-policy.zh.md)

## Problem

Node's built-in `fetch` ignores `HTTP_PROXY` and `HTTPS_PROXY`. Every other tool a developer runs — curl, git, npm, pip — honours them, so a user behind a proxy exports the variables once and expects everything to follow. The harness did not: `setGlobalDispatcher`, `ProxyAgent`, and `EnvHttpProxyAgent` appeared zero times across `packages/` and `apps/`, so the model request, every web search, `web_fetch`, MCP over HTTP, the OTLP exporter, and the E2B SDK all connected directly, silently, with no diagnostic anywhere.

The repository had briefly had an answer and lost it without noticing. PR #971 set `NODE_USE_ENV_PROXY=1` in `bin/dsh`; eleven days later `bbb1b1cc38 cleanup: remove managed source installer` deleted that launcher wholesale, taking the flag with it. What survived was one sentence in `apps/cli/reference/README.md` telling the reader to set a variable that nothing consumed any more.

That sentence could not have worked anyway, for three measured reasons. `NODE_USE_ENV_PROXY` samples the environment at process start, while `loadLayeredEnv()` merges the `.env` layers afterwards, so a proxy declared in a project or `$DSH_HOME` `.env` is invisible to it. It reaches Node 24.0+ and, on the 22 line, only 22.21+ — while `engines` admits `^22.19.0`, where the variable does not exist and setting it warns about nothing. And it does not reach `web-fetch-http` at all: that provider passes its own `dispatcher` to `fetch`, and an explicit dispatcher overrides the global one whatever the flag says.

## Decision

**One policy, resolved once from the launch environment, installed as the global dispatcher.** `packages/net/http-proxy` resolves a `ProxyPolicy` and installs it in `runProfile` immediately after the environment snapshot is provided and before any entry mounts. Node's `fetch` resolves undici's global dispatcher, so every plain `fetch()` and every SDK that reaches `globalThis.fetch` is covered without touching its code — nine call sites at the time of writing, and every future one for free. `loadLayeredEnv` has exactly one caller and `apps/web` ships no bin, so this single site covers every profile including `sdk-minimal`, which does not layer over `base`.

Resolution reads the launcher's snapshot rather than `process.env`, which is what makes a proxy in a `.env` layer work — the capability the environment-variable approach cannot have.

**A new `packages/net/` group.** The package must depend on `undici` (Node exposes no `node:undici`), so it cannot join the zero-dependency `util/` group; and `boot`, `web`, `subprocess`, and `workflow` all consume it, so joining any one of them would invert three dependencies. It is deliberately not a capability seam: transport policy has one implementation and one answer per process, so there is nothing to swap.

**The installed dispatcher routes by the policy, not by an environment it re-parses.** `installGlobalProxy` builds an `Agent` whose per-origin `factory` asks `proxyForUrl` where that origin goes, and returns a `ProxyAgent` or undici's own default client for it. undici's `EnvHttpProxyAgent` was the first choice and is wrong for this policy: when no `HTTPS_PROXY` is present it sets its HTTPS agent to the HTTP one, so a scheme this package keeps direct after refusing a SOCKS or malformed URL would still be tunnelled while the diagnostic said otherwise. Routing through the one predicate removes that class of divergence by construction rather than by test. Publishing the policy into the environment remains, but now serves only the readers that have no policy object: Node's `proxyEnv` option and every spawned child.

This keeps `proxyForUrl()` and the dispatcher answering from one set of values. They must agree: if they disagreed about a URL, `web-fetch-http` would pin a connection the dispatcher meant to tunnel.

**Resolution supplies what neither Node nor undici does.** `ALL_PROXY` backs both schemes; a blank value counts as unset, because undici's `??` chain lets an empty lowercase name shadow a populated uppercase one; loopback is always bypassed, since the Web UI, the Connection transport, and every local test server would otherwise route through the proxy and loop. The bypass list carries `::1` *and* `[::1]`: undici's own matcher reads a bare `::1` as host `:` port `1` and never exempts it.

**Rejection is loud or quiet by where the value came from, and never reroutes the refused scheme.** A slot the user filled and this package refused keeps that scheme direct rather than falling through to `ALL_PROXY` or the HTTP proxy, so the diagnostic and the route agree. A SOCKS URL, an unparseable string, or an unsupported scheme *from the environment* is reported on stderr and skipped — that variable may have been exported for other tools, and a typo in it must not stop the agent from starting. The same value through the plugin's `Config` throws at load, because that is the harness's own configuration surface, where `AGENTS.md` requires misconfiguration to fail loud.

**Through a proxy, `web_fetch` stops resolving and pinning.** The provider validates a public address set and pins the connection to it. Through a proxy there is nothing to pin — the proxy performs the origin's DNS — and a pinned direct connection would bypass the proxy entirely. So a proxied hop skips resolution, and configuring a proxy is a statement that the proxy is trusted with destination selection. A hop the policy bypasses, which includes every loopback and every `NO_PROXY` entry, takes the resolved-and-pinned path unchanged. Kimi Code and Claude Code reached this same conclusion independently.

The URL-level policy is untouched: `http(s)` only, no embedded credentials, the length cap, and the cross-origin redirect refusal all still apply on every hop.

**A spawned child gets the policy through its environment; a model-executing worker gets nothing.** `childProxyEnv()` merges into `scrubbedParentEnv()`, the one function every spawner already shares. The workflow worker does NOT receive it: it executes the model-authored script body, and a proxy URL may carry `user:password`. That is the same containment the code runtime keeps and `docs/defensive-patterns.md` requires, so a workflow's own requests go direct.

This accepts a documented seam. Such a context matches bypass entries by Node's rules, which differ from this package's in separators and IPv4-range support, and the flag exists only on Node 22.21+ and 24+.

**Two SDKs do not reach `globalThis.fetch`, and reading their code said otherwise.** The audit first classified the OTLP exporter and the E2B SDK as covered, on a grep that found `globalThis.fetch` in `@opentelemetry/otlp-exporter-base`. That match is the *browser* transport; on Node the delegate selects `http-exporter-transport`, which posts through `node:http` — where a global dispatcher does not reach. E2B is a second shape again: it builds its own undici `Agent`/`ProxyAgent` and takes a `proxy` URL that it never reads from the environment. Both were measured direct and both are now wired — the exporter through `createNodeHttpAgent` as its `httpAgentOptions` factory, E2B through `proxyUrlFor` into `Sandbox.create`.

**Every call site carries an egress test, because reading the code was not enough.** `egress.spec.ts` in each owning package drives that site's real code path at an unresolvable `.invalid` host through a fake proxy and asserts the proxy saw the request. Nine of them cover the search backends, pi-ai discovery, MCP over HTTP, telemetry, E2B, a spawned child Node, and a worker thread. The gate below cannot see inside a dependency; these can, and they are what turns "an SDK changed its transport" from a silent regression into a failing test.

**A gate keeps the defect from returning.** `verify-no-bare-dispatcher` parses the TypeScript AST — `scripts/AGENTS.md` requires syntax-aware discovery, and a line-wise regex missed both the `{ dispatcher }` shorthand this repository already uses and a `new Alias(...)` behind a renamed import. It rejects an undici agent construction and an explicit `dispatcher` option outside the owning package. `createDispatcher(url, options)` is the sanctioned replacement, and a line that must genuinely ignore the proxy says so with a `proxy-exempt:` comment. The rule exists because `web-fetch-http`'s original `new Agent` was entirely reasonable when it was written — proxying simply did not exist yet, and nothing would have caught it.

## Alternatives considered

**Document `NODE_USE_ENV_PROXY=1` and stop.** Rejected on three measurements, above: invisible to `.env` layers, absent on the lowest supported Node, and bypassed by `web-fetch-http` regardless. It is also what the repository already claimed to do.

**Thread a policy value to every call site.** DeepSeek-Reasonix does this across 98 sites, buying a per-provider opt-out. Rejected: that opt-out exists for a need this harness does not have, and nine sites changed by hand means the tenth is forgotten — Pi's changelog records OAuth and Bedrock as two separate after-the-fact fixes of exactly that kind. The isolation argument for it is real, and is answered instead by handling worker threads explicitly and by proving disposal restores the previous dispatcher.

**`http.setGlobalProxyFromEnv()`.** Node's own programmatic switch covers `fetch` and `node:http` together and returns a restore function — the shape `ctx.effect()` wants. Unusable: `added: v24.14.0`, with nothing on the 22 line. Worth revisiting if `engines` ever rises past it.

**Patch `globalThis.fetch` via `undici.install()`.** Pi does, to keep fetch and the dispatcher on one undici when a newer Node's bundled fetch mishandles compressed responses through a userland dispatcher. Rejected as speculative here: this repository's `engines` ceiling has not reached that runtime.

**Make this a capability seam.** Rejected. Service Definition / Provider / Consumer is for swappable backends; this has one implementation and one answer per process. If operating-system proxy or PAC support ever lands, `resolveProxyPolicy` is the extension point.

**Read the operating system's proxy settings.** Rejected for this change. Only Codex and Reasonix among six surveyed products do it, and Codex keeps it behind a default-off flag. Measured on the author's machine, it would have found nothing: the proxy application had written the setting to the Wi-Fi service while the primary interface was a USB ethernet adapter with no proxy, so `scutil --proxy` reported none while the exported variables worked. It also needs its own bypass matcher, because an operating system list carries CIDR entries that neither undici nor Node matches.

**Give the `code-runtime` worker the proxy too.** Rejected. Model-authored programs run there with no ambient environment at all — a stronger containment than the scrubbed environment spawned commands get — and a proxy URL may carry credentials. Handing model code a credentialed URL to reach the network is the wrong trade; the exclusion is recorded in that package's limitations.

## Consequences

A user who exports `HTTPS_PROXY`, or writes it into a `.env` layer, is proxied everywhere the harness makes a request, with no flag and no configuration. Compositions that want the policy in `cordis.yml` mount the plugin; it is in no shipped bundle, so the default path installs exactly once.

Because the operating system's settings are not read, the user-facing documentation is now load-bearing rather than supplementary: a user who only toggled "system proxy" in a proxy application gets nothing and no diagnostic. `docs/user/guide/network-proxy.md` therefore states which variables to export and why a browser is proxied when a terminal is not — the three-mechanism confusion is the single most common report, and it is not specific to this harness.

`web_fetch`'s safety story now has two shapes, and its README says so: direct hops keep address validation and pinning, proxied hops delegate destination selection to a proxy the operator configured. This is the one outward-facing security promise the change alters.

Reaching Node's built-in `fetch` from a userland undici depends on both writing the legacy `Symbol.for('undici.globalDispatcher.1')` slot. That is an implicit cross-version coupling rather than a contract — corepack#834 records it breaking — so `tests/install.spec.ts` drives a real request through a loopback proxy. A version bump that breaks the coupling fails there instead of in the field.

The suite is hermetic against the developer's own environment: `plugin.spec.ts` saves and clears all eight proxy names in both casings. It has to. An exported lowercase `all_proxy` decided a test's outcome during development, because resolution reads lowercase first.

## Testing

`packages/net/http-proxy` holds 64 tests at 100% per-file coverage. Resolution covers precedence, the `ALL_PROXY` fallback, blank-shadowing, the SOCKS and malformed diagnostics, and `mode: 'off'`; bypass matching covers suffixes, ports, both IPv6 spellings, and the CIDR entry that deliberately does not match. Installation drives a real loopback proxy and asserts the absolute-form request arrives, that a bypassed target does not, and that disposal restores the dispatcher, the policy, and the environment.

`packages/web/web-fetch-http/tests/proxy.spec.ts` asserts the decision that matters most: under a proxy the public-address resolver is never called, while a bypassed hop still calls it exactly once, and the cross-origin redirect refusal survives on the proxied path.

`verify-no-bare-dispatcher.spec.ts` proves the gate rejects the exact shape this package was introduced to fix, accepts `createDispatcher`, accepts an annotated exemption, and passes on the current tree.

The egress suite carries the negative case for telemetry — restoring the SDK's own default agent reaches no proxy — so an upgrade cannot quietly un-proxy it. Its positive case branches on the runtime, because the exporter's agent needs Node 22.21+ or 24.5+. A parity suite checks `proxyForUrl` against where a real `fetch` actually went for every form in the documented `NO_PROXY` vocabulary; since the dispatcher routes by that same predicate, what it now catches is a form `bypassesProxy` reads differently from how the vocabulary documents it, and any future dispatcher that reintroduces a second matcher.

No recorded-session snapshot changes: nothing here alters a model-visible input or product-user-visible transcript output.
