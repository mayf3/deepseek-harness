# @deepseek-ai/dsh-client-ui-agent-team

English | [中文](README.zh.md)

Private Web Agent Teams presentation. It contributes one conversation-header action containing the current roster and shared task board. The browser calls the generated `ctx.remote.teams` namespace supplied by [`@deepseek-ai/dsh-agent-team-remotes`](../agent-team-remotes/README.md); it does not extend the stable API Proxy or store authoritative Team state.

Opening the panel calls `teams/view`. Roster rows show durable names, runtime status, model, and diagnostics. Selecting a healthy teammate refreshes the existing direct-child catalog and opens the ordinary `{ parentSessionId, childSessionId, mode: 'continuable' }` address. History and later human prompts continue through the stable addressed-subagent conversation path; this package adds no Team-specific field to that address.

The task board shows task identity, owner, blockers, readiness, advisory write scopes, and overlap warnings. Humans can create, edit, assign or unassign, complete, reopen, and delete tasks through `teams/createTask` and `teams/updateTask`. Every mutation sends the displayed revision. A `team-task-conflict` result reloads the Team view and displays a stale-state notice instead of retrying or overwriting. Editing task text or scopes and changing dependencies remain two sequential compare-and-set mutations because the Team service exposes them as separate actions.

The root export is inert on the Host. The Client export owns locale and slot registrations, and Cordis disposes both with the plugin fiber. Install the package through [`@deepseek-ai/dsh-agent-team-web-profile`](../agent-team-web-profile/README.md) after the stable Web bundle and the Host-side Agent Teams profile.

## Model Experience

None, as this browser projection and task control surface registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

- **Snapshot refresh** — the panel refreshes on open, explicit refresh, and mutations; it has no live event subscription or mailbox timeline.
- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.
