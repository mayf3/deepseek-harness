---
description: "Use and debug the experimental Web Agent Teams roster, shared task board, and teammate navigation panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds an Agent Teams action to the Web conversation header, where a user can inspect the current roster, inspect the shared task board, and navigate into a teammate's conversation. It reads the Lead Session's `agentTeam` projection from the shared Session store, where Host projection frames keep it current without a refresh control, and keeps ordinary child-history navigation on the stable addressed-subagent path. Choose it through the published experimental Agent Teams bundle. The browser projection does not extend the stable API Proxy, store Team state, or register model-facing input.

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

Enable this package through [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md), which supplies the Team service, tools, and Web UI together. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

The trigger shows the teammate count, and the panel shows the roster and task board of the Lead Session's `agentTeam` projection, so a task created by an agent or a teammate reaching `active` appears while the panel is open. Opening the panel requests the Lead's projection baseline once per connection, both in the Lead conversation and in a teammate conversation. A successful prior read is reused; a failed read shows a retry control alongside any last valid Team, and a reconnect reloads it. A successful read without the Team capability shows an unavailable notice. The panel also requests active members' projection baselines outside the current Session and Lead, including persisted Sessions that have not been opened, and loads new members when they become active. Roster rows show durable names and a status: `failed` and `provisioning` come from the durable member phase, and `running` or `inactive` comes from the member Session's live status. A model appears when the member Session's `modelSelection` projection records a durable selection or request. Provisioning and running members use the shared ongoing loader, inactive members use idle, and failed members use error. Selecting a healthy teammate opens the ordinary `{ parentSessionId, childSessionId, mode: 'continuable' }` address from its Lead and roster identity without refreshing or checking the parent catalog. The Host validates the parent, child, and mode when history opens. History and later human prompts continue through the stable addressed-subagent conversation path; this package adds no Team-specific address field.

### Inspect the task board

Ready pending tasks use idle, blocked pending tasks use warning, in-progress tasks use ongoing, and completed tasks use done.

The read-only task board shows task identity, owner, blockers, readiness, advisory write scopes, and overlap warnings. Team agents create and update tasks through their tools; the panel provides no task mutation controls. When the projection reports a rejected persisted Team record, the panel shows that failure above the last valid roster and tasks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export registers its locale dictionaries and one conversation-header slot through Cordis effects; it mounts no Remote namespace. Disposing the plugin fiber removes both registrations.

The panel renders outside the conversation container and stays within the viewport. Opening moves focus into the panel; Escape or Close returns focus to its trigger. Clicking outside or moving focus outside the panel and trigger closes it without moving focus back. The component reads the current Session's Team through `useProjection('agentTeam')` and its model through `useProjection('modelSelection')`. In a teammate conversation, `useSession` supplies the Lead identity and `useSessions` reads its Team value. Separate `useSessions` selectors read the Lead's baseline-read state and error in both conversation types. Each roster row selects its own model and running state; the panel subscribes to neither the complete projection collection nor the complete summary or status collection. Its only injected callbacks read a Session's projection baseline and open a teammate. Switching conversations closes the panel and clears a navigation failure.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Locale, projection-read, navigation, and slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Projection-derived roster and task board with panel interaction state |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams bundle](../agent-team-profile/README.md) — the published opt-in bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative roster, task, projection, and Remote behavior.
- [Conversation UI](../../client/ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Cached capability absence** — if another UI loaded the Lead projection baseline before Agent Teams was enabled, opening this panel reuses that baseline; reconnect to load the newly enabled capability.
- **No mailbox timeline** — the projection view carries roster and tasks only; peer messages are not shown.
- **Model before the first request** — a member without a durable model selection or request shows no model. Inactive persisted members can supply their model through the explicit projection read; live activity still requires a running Host agent.
- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The Host projection is authoritative and the package owns only one disposable slot registration.
