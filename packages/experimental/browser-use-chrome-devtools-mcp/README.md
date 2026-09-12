---
description: "Operate Chromium through Chrome DevTools MCP with separate browser state for each live Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp

English | [中文](README.zh.md)

## Summary

Use Chrome DevTools MCP to inspect pages and operate Chromium through its upstream tools. Each live Session receives its own server process. Launch a separate browser or attach one Session to an existing browser with its current tabs and login state. This published experimental package activates only when explicitly mounted.

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

Mount both entries in a profile composition that supplies Agents, tools, and system prompts. Browser installation follows the upstream runtime; select an existing Chromium installation with `executablePath`.

```yaml
- name: '@deepseek-ai/dsh-browser-use'
- name: '@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp'
  config:
    mode: launch
    headless: true
```

Use `mode: attach` and set `endpoint` to an HTTP(S) debugging URL or WS(S) browser endpoint to operate an existing browser. A Session claims the attachment while loading its browser tools and retains it until unloading. Other Sessions and subagents continue their turns without these tools; a later turn can acquire the attachment after cleanup. Direct calls from another Session fail. Cleanup disconnects and leaves the external browser and its pages running.

| Field | Default | Meaning |
|---|---|---|
| `mode` | required | `launch` or `attach`, fixed for this provider activation |
| `headless` | `true` | Launch without a visible window |
| `executablePath` | upstream discovery | Chromium executable for launch |
| `endpoint` | required for attach | Existing browser debugging endpoint |
| `toolCallTimeoutMs` | MCP client default | Per-call timeout in milliseconds |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-browser-use-chrome-devtools-mcp) lists accepted fields. The profile or preset selects the browser mode.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider resolves its pinned npm executable and starts it under the current Node executable. The [shared runtime](../browser-use-runtime/README.md) discovers tools before model schema collection and serializes calls within each Session. The [MCP client](../../mcp/mcp-client/README.md) owns stdio, registration, cancellation, and result projection. No runtime invariant companion is published because the provider maintains no separate observation of the shared runtime or MCP connection.

Browser state survives turns while its live Session remains attached. Disposal waits for server shutdown before releasing resources. Resume after reload starts fresh browser runtime state; stored conversation history does not restore cookies or pages.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.
- [Browser-use service](../../browser-use/browser-use/README.md) — exclusive provider registration.
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) — upstream installation and browser behavior.

-----

<a id="model-experience"></a>
## Model Experience

### Browser tools and screenshots

#### What the model sees

Tools retain upstream descriptions and JSON schemas under `mcp__chrome-devtools-mcp__<tool>` names. Text and screenshots use the normal tool-result pipeline and Session log. Screenshots require an attachment store and an image-capable model route; other routes receive the MCP image diagnostic. This provider adds no system-prompt guidance.

#### Token effect

The catalog adds tool definitions. Calls add arguments, text, and admitted images to Session history. Inline image bytes stay outside model-visible history.

#### KV Cache effect

An unchanged catalog preserves its tool-definition prefix. Results append to history; provider or catalog changes can reduce prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The integration retains the pinned server's browser and tool restrictions.

- Chromium only; Firefox and WebKit are not selectable.
- A lost server connection leaves calls failing until provider reload or host restart. Reconnection is disabled to avoid silently replacing browser state.
- Attachment exclusivity is local to this provider instance. Other processes and browser users can still modify the same pages.
- Cancellation does not undo navigation, clicks, or other actions already delivered to the browser.
- Tool schemas follow the pinned experimental dependency and carry no DSH stability promise.
- Usage statistics are disabled. Other features, including performance tools, retain their upstream behavior.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
