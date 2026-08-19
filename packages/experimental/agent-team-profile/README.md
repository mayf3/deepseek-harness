# @deepseek-ai/dsh-agent-team-profile

English | [中文](README.zh.md)

Private profile bundle that enables [Agent Teams](../team/README.md) over `@deepseek-ai/dsh-base`. Its patch inserts the Team domain and scoped tools, disables the overlapping global continuable-child controls, and keeps the ordinary fresh and fork delegation tools as one-shot operations. Install this package explicitly into a source-checkout profile; it is excluded from official releases.

## Profile installation

From this repository checkout, add the package to an initialized profile:

```sh
pnpm dsh plugin --profile headless add ./packages/experimental/agent-team-profile
pnpm dsh --profile headless "Use Agent Teams to split this task between two teammates, wait, and summarize."
```

The profile must already contain `@deepseek-ai/dsh-base`, whose Subagent services and provider rows this layer consumes. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-agent-team-profile` removes the bundle from the profile's ordered layer list.

## Model Experience

### Team policy and tools

#### What the model sees

The Team policy and schemas belong to [`@deepseek-ai/dsh-tool-team`](../tool-team/README.md). This bundle changes composition only: Team-scoped `list_agents`, `send_message`, and `interrupt_agent` replace the disabled global continuable-child controls. `subagent` and `subagent_fork` remain available as one-shot delegation tools, whose children do not receive the continuable-child `report` tool.

#### Token effect

The bundle adds the Team policy and tool schemas described by `dsh-tool-team`; it adds no prompt text of its own.

#### KV Cache effect

The bundle's composition is prefix-stable while its patch, Team identity, and configured tool schemas remain unchanged.

## Known Limitations and Deferred Work

- **Source-checkout only** — this private package is not present in official npm, CLI, Web, or Python release payloads.
- **Shared checkout** — every teammate observes the same working directory; this bundle adds no worktree isolation or filesystem locking.
