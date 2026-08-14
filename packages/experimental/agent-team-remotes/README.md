# @deepseek-ai/dsh-agent-team-remotes

English | [中文](README.zh.md)

Private Client assembly for the Agent Teams Typert Remote contribution. Its Client entry imports the generated `@deepseek-ai/dsh-team/remote` runtime value, mounts it through the stable `ctx.remote.$mount()` service, and re-exports the declaration merge that adds `ctx.remote.teams`.

The contribution exposes `teams/view`, `teams/createTask`, and `teams/updateTask`. The generated codecs validate arguments and results, while the Team service remains the only owner of roster and task state. This package contains no Host resolver or transport logic; `@deepseek-ai/dsh-api-remotes` supplies the stable Remote service and Agent identity policy.

The root export is inert because this package mounts only in a Client environment. [`@deepseek-ai/dsh-agent-team-web-profile`](../agent-team-web-profile/README.md) inserts it before the Team UI so the namespace exists when the UI activates.

## Model Experience

None, as this Client assembly only mounts typed Remote methods and registers no model-facing input.

#### KV Cache effect

No direct effect; invoked Team methods and their model-facing consumers own any later effect.

## Known Limitations and Deferred Work

- **Fixed contribution set** — adding a Team Remote method requires regenerating the Team artifacts and rebuilding this explicit assembly.
- **Source-checkout only** — this private package is excluded from official releases.
