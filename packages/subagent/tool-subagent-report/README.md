---
description: "Child-scoped report tool for users and maintainers composing or debugging the child-to-parent return channel of continuable subagents."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-report

English | [中文](README.zh.md)

## Summary

`dsh-tool-subagent-report` gives every continuable in-process child a temporary child-scoped adapter over the adjacent-Agent messaging service: it installs a `report` tool plus prompt guidance telling the child to use it. Roots, one-shot subagents, remote providers, and sibling scopes never see either registration. Accepted reports reach the direct parent through fixed Steer scheduling and the same framing and provenance as parent-to-child messages. Continuable mode depends on neither this package nor the control package.

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

Mount this package in a composition with continuable in-process children whose findings the parent should see before they finish. The tool and its guidance appear automatically inside each continuable child; no per-child configuration is needed.

### Minimal configuration

Load the subagent service, a backend, the delegation tool in `continuable` mode, and this package:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    backgroundMode: continuable
- name: '@deepseek-ai/dsh-tool-subagent-report'
```

The package takes no configuration.

### What the child gets

Each continuable child gets a `report` tool whose only parameter is `output` — a self-contained answer for the parent — and a prompt section telling it to call `report` once before finishing, and earlier whenever a partial finding changes what the parent should do next. The instruction is guidance, not enforcement: a child may call zero or many times in one turn, and finishing a turn never reports automatically. A successful call neither ends the turn nor settles the child's Activation.

### What the parent sees

An accepted report becomes one user-role parent message framed as `Agent <child-id> sent a message:` followed by the child's exact output, with a durable `agent-message` source naming the child. Fixed Steer scheduling starts a turn for an idle parent or joins a running parent's nearest step boundary. The tool takes no recipient: it derives the sole recipient from the child's durable `parentSession` and delegates authorization and delivery to `ctx.subagents.sendMessage()`.

### Scope and direction

The report tool deliberately survives the child's global `toolFilter`: a delegation allow-list cannot remove the only return channel. A deployment that requires a child with no return channel omits this package. The parent-to-child direction remains the independently installed control package, and continuable mode depends on neither package.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tool is installed and scheduled; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The package registers a continuable-child setup contribution rather than a global tool, so the tool and its guidance are installed inside each child's unpublished scope and vanish with it. The same registrations are ordinary child-scoped contributions, so an expert `system-prompt/assemble` listener could replace them and would then own preserving the reporting protocol for that child.

### Delivery scheduling

The service always uses `parent.steer()`: a running parent receives the report at its nearest step boundary, an idle parent starts a turn, and reports accepted in sequence share the next-step FIFO. The model-facing schema cannot select or override scheduling.

### Exported contribution

`installReportTool(childCtx, ctx)` installs the tool and guidance into a minted child scope and returns one disposer revoking both. The generated tool catalog uses this path because the global registry cannot expose a scope-local schema; production composition still enters through `apply()`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Continuable-child setup and `installReportTool` adapter |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the report channel to the continuation service behind it and the parent-facing tools.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — continuable children, activations, and the `sendMessage` contract.
- [dsh-tool-subagent-control](../tool-subagent-control/README.md) — the parent-to-child control tools.
- [dsh-tool-subagent](../tool-subagent/README.md) — the delegation tool that starts continuable children.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-report) — the `report` schema.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`report` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-report): one required `output` string. Its description states that the child must report once before finishing, that reporting reaches only the Agent that started the child, and that it does not end the turn. It carries no recipient or delivery-mode parameter. The separate `tool:report` prompt section repeats the obligation outside the schema.

#### Token effect

Fixed schema and prompt-section cost per continuable-child request, and none in any other Agent's requests.

#### KV Cache effect

Prefix-stable within a child; neither the schema nor the section changes at runtime. Removing the package revokes both from resident children, which changes their next request prefix.

### Report result

#### What the model sees

`report accepted by the agent that started you as message <messageId>` on acceptance; the canonical output carries the stable `messageId`. A failure from an unauthorized sender, an unavailable parent, or a closing lifecycle is an errored result. Delivery acceptance still precedes later tool-result hooks, which are outside this package.

#### Token effect

One short acknowledgement per call in the reporting child. The reported content is additionally billed to the parent: delivery joins the next request in an open parent turn or starts a turn for an idle parent.

#### KV Cache effect

Append-only in the child. In the parent, the framed report follows existing history and preserves the reusable prefix.

### Parent-visible report

#### What the model sees

One user-role parent message framed as `Agent <child-id> sent a message:` followed by the child's exact `output`, with a durable source `{ kind: 'agent-message', form: 'relay', senderSessionId: <child-id> }` that names the child.

#### Token effect

The child's complete `output` plus the one-line frame, uncapped by this package.

#### KV Cache effect

Append-only; the report follows the parent's reusable request prefix. Steer wakes an idle parent and may extend an open turn.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what an accepted report does and does not guarantee; they are current package constraints.

- **A parent whose host-owned disposal already started can still accept** — `AgentHandle.dispose()` cancels, awaits quiescence, and only then unwinds the scope and leaves the registry; it exposes no signal for "disposal started." A report accepted in that window is appended to the parent's transcript, but that parent will not act on it in this process. A continuation-manager-owned parent rejects forest teardown through the manager's admission boundary.
- **Acceptance is weaker than durable delivery** — there is no durable mailbox, idempotency key, delivery receipt, retry protocol, or exactly-once claim. A process failure after one side recorded acceptance leaves the outcome ambiguous, and an external retry may duplicate the report.
- **Granting waits for the next Activation; revocation is immediate** — installing this package after a child becomes resident grants `report` and its guidance only on that child's next Activation, while removing the package revokes both from resident children immediately.
- **Nested reporting reaches exactly one edge upward** — a grandchild reports to its direct child parent, never to the top-level coordinator, which must explicitly report a derived update later.
- **No rate limiting** — frequent nested reports can amplify model work, although reports waiting together share one step.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
