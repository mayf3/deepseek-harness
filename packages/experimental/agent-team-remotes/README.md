# @deepseek-ai/dsh-agent-team-remotes

English | [中文](README.zh.md)

Private browser Remote adapter for Agent Teams. Its Host service is registered as `ctx.teamRemote` and exports the separate `teams` wire namespace, so it cannot replace or widen the domain-owned `ctx.teams` service. The adapter delegates every read and mutation to `ctx.teams` and owns no roster, mailbox, task, or lifecycle state.

The generated contribution exposes `teams/view`, `teams/createTask`, and `teams/updateTask`. Views omit mailbox contents and deleted task tombstones. Task conflicts cross Remote as a closed business result; other Team rejections remain distinguishable from carrier or Agent-lookup failures. `@deepseek-ai/dsh-api-remotes` supplies the stable Remote carrier and Agent identity policy.

[`@deepseek-ai/dsh-client-ui-agent-team`](../client-ui-agent-team/README.md) mounts the generated Client contribution through `ctx.remote.$mount()`. [`@deepseek-ai/dsh-agent-team-web-profile`](../agent-team-web-profile/README.md) inserts this Host adapter before that UI.

## Model Experience

None, as this browser adapter delegates typed Remote methods and registers no model-facing input.

#### KV Cache effect

No direct effect; invoked Team methods and their model-facing consumers own any later effect.

## Known Limitations and Deferred Work

- **Fixed contribution set** — adding a browser operation requires changing this adapter and regenerating its Remote artifacts.
- **Source-checkout only** — this private package is excluded from official releases.
