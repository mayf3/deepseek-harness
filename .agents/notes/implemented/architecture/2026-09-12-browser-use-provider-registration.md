# Agent Note: Browser-use provider registration and Session ownership

Status: implemented

English | [中文](2026-09-12-browser-use-provider-registration.zh.md)

## Problem

Browser-control backends expose different operations and observation formats. A common browser action API would constrain those experiments before a portable consumer exists. Browser sessions can be isolated, while attaching an existing logged-in browser must preserve its state and prevent concurrent ownership inside a provider.

## Decision

[`dsh-browser-use`](../../../../packages/browser-use/browser-use/README.md) owns `ctx.browserUse`, which registers one provider-owned name and returns its effect disposer. A second registration fails regardless of its name. The service contains no browser object, shared operation type, dispatch method, resource lifecycle, or runtime selector. The [computer-use registration decision](2026-09-12-computer-use-provider-registration.md) remains the independent owner of desktop-provider registration and shared-desktop coordination.

[Playwright MCP](../../../../packages/experimental/browser-use-playwright-mcp/README.md), [Chrome DevTools MCP](../../../../packages/experimental/browser-use-chrome-devtools-mcp/README.md), and [native Stagehand](../../../../packages/experimental/browser-use-stagehand-native/README.md) own their browser tools and integrate through the normal DSH tool pipeline. They are public experimental opt-ins. DSH owns task planning and the task loop; Stagehand contributes individual AI-assisted operations. Profile or preset configuration selects launch or attachment for each provider activation.

Browser resources belong to the exact live Agent and Session, not merely a reusable Session id. Calls retain state across turns. Runtime disposal closes launched resources, and reload or fork does not inherit a launched profile. Attachment preserves existing browser state and reserves the external browser exclusively for one Session within that provider instance. Cleanup disconnects without closing the external browser.

The [experimental runtime helper](../../../../packages/experimental/browser-use-runtime/README.md) owns shared resource lifetime and attachment reservation without introducing those methods into the browser-use service. Provider teardown stops tool admission, waits for owned work, and closes resources before releasing its provider registration. The service remains independent of all experimental packages.

Stagehand's browser close operation shuts down Chromium even after attachment. Each attached runtime therefore owns a Worker: cleanup attempts to release Stagehand state, then terminates the Worker to close its connections without invoking browser close on the externally owned browser. Launched browsers retain normal owned-browser cleanup.

Stagehand uses its supported custom-model callback to request structured results through the Session's selected DSH model. A provider-local adapter requests one result tool call and validates its arguments against Stagehand's requested JSON Schema; it does not execute additional model tool calls. Auxiliary requests are logged and flushed before model dispatch, and settled responses are logged and flushed before automation continues. These events remain separate from the main conversation, preserving the browser operation's model input without altering the agent loop.

Per-Session MCP discovery runs in the awaited serial `system-prompt/prepare` event, before prompt assembly collects its scoped registrations and tool providers. The discovered catalog therefore enters the normal tool-mode, restriction, and ordering pipeline on the first request. Discovery at `agent/pre-step` is too late because prompt assembly has already collected the catalog; the preparation event keeps this ownership in system-prompt assembly without changing the agent loop.

## Alternatives considered

**Unified browser action API.** Playwright, Chrome DevTools, and Stagehand have different native semantics. No current consumer requires interchangeable action methods, so provider-owned tools retain those semantics.

**One shared browser across Sessions.** Browser tabs, navigation, and login state can be isolated per Session. Sharing them would introduce cross-Session interference that the desktop integrations cannot generally avoid.

**Fresh context when attaching.** A new browser context does not inherit the existing logged-in state. Exclusive use of the attached browser preserves the workflow that attachment enables.

**Browser profiles restored with Sessions.** Durable browser state introduces profile storage and migration ownership beyond the Session log. Launched state lasts only for the live runtime; externally owned browsers retain their own persistence policy.

**Only isolated launch.** Users need both clean browser sessions and access to existing authenticated state. Configuration selects the ownership policy explicitly.

**Delegated browser agents.** The experiments compare browser-control backends. Delegating the whole task to another planner would alter DSH's control of the task loop.

## Consequences

Providers evolve their tools independently while the shared service remains a name-only registry. Public release exceptions make the three providers and their runtime helper installable without enabling them in shipped defaults. The browser package group has no dependency on experimental runtime code.

Attachment reservations apply within one provider instance; they do not coordinate separate DSH processes or external browser clients. Browser state is absent from Session replay, and cancellation does not undo delivered browser actions. Provider READMEs own engine support, model requirements, and upstream restrictions.
