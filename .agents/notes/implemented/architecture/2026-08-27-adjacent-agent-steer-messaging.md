# Agent Note: Adjacent Agents share one Steer messaging operation

Status: implemented

English | [中文](2026-08-27-adjacent-agent-steer-messaging.zh.md)

## Problem

Continuable Agents had direction-specific public operations and message sources. A parent used `followup(parent, childId, content, { source, signal })`, while a child used `reportFrom(child, content, { delivery, signal })`. The first created a later FIFO turn and accepted caller-supplied provenance; the second selected quiet injection or next-step steering through deployment configuration and derived its recipient internally.

Those differences described the tools that first consumed the service, not two lifecycle capabilities. Both directions deliver model-authored content across one parent/child edge, require the continuation manager to authorize the exact live Agents, and depend on the same residency and cold-resume ownership. Direction-specific sources also made equivalent messages reconstruct differently.

[Issue #3220](https://github.com/deepseek-harness/deepseek-harness/issues/3220) requires one foundation before the model-facing tools are unified.

## Decision

`SubagentRuntime.sendMessage(sender, targetId, content, { signal })` is the only public model-authored message operation. The continuation manager accepts only the exact live sender and a target on one adjacent edge:

- parent to direct continuable child, authorized by the child's durable `SessionHeader.parentSession`;
- resident continuable child to its exact live direct parent, authorized by the child's Activation.

Siblings, self-targets, ancestors beyond one edge, stale Agent objects, unknown targets, and one-shot children are not alternate routes. The operation has no caller-supplied source, delivery mode, offline parent mailbox, or provider dispatch.

Every accepted message uses `Agent.steer()`. A running target receives it at the nearest step boundary; an idle target starts a turn. An absent direct child is cold-resumed through the existing continuation lifecycle before the same Steer delivery. The manager retains waking-send accounting so a continuation-managed target cannot settle between synchronous inbox insertion and driver admission.

Every direction uses one durable source:

```ts
type SessionId = string

interface AgentMessageSource {
  readonly kind: 'agent-message'
  readonly form: 'relay'
  readonly senderSessionId: SessionId
}
```

The service derives `senderSessionId` from the authorized Agent and frames the model-visible content as `Agent <sender-id> sent a message:`. Attribution therefore cannot diverge from authority. The runtime-owned `subagent-settled` notice remains separate because its words are the manager's account, not content selected by an Agent.

Human browser prompts are not model-authored Agent messages. The existing remote prompt path keeps a private Queue delivery so each human prompt remains a distinct turn. Interrupt behavior and settlement delivery are unchanged.

The child-scoped `report` tool temporarily derives its parent id and adapts to `sendMessage()`. Its `reportDelivery` configuration is removed: accepted reports now use the same fixed Steer scheduling and `agent-message` provenance as parent-to-child content. A later change may unify the model-facing tools without changing this service decision.

## Alternatives considered

**Keep `followup` and add child-to-parent routing.** The name promises a later turn and inherits `Agent.followup()` semantics. It would obscure the chosen nearest-step behavior and preserve a parent-centric operation name for a direction-neutral capability.

**Keep separate `followup` and `reportFrom` methods over one implementation.** Two public methods still permit different options, provenance, and error behavior to reappear. Tool-specific adapters belong in Consumer packages, not the Service Definition.

**Let callers supply `MessageSource`.** The sender Agent is already the authorization credential. Accepting independent attribution allows a caller to record a different author from the one the manager authorized.

**Keep quiet delivery as deployment policy.** A quiet model-authored message can be accepted while an idle target never reads it. Fixed Steer gives both directions one delivery meaning and preserves batching at a running target's step boundary.

**Use `Agent.followup()` for idle targets and `Agent.steer()` for running targets.** `Agent.steer()` already defines both cases. Selecting from a pre-send status read would add a race and two inbox targets without changing the intended idle behavior.

## Consequences

- Service consumers have one direction-neutral model messaging operation and one provenance vocabulary.
- The continuation manager remains the sole owner of adjacency authorization, residency, cold resume, waking admission, and teardown races.
- Accepted messages may extend a running target's current turn. Several messages waiting together share next-step FIFO ordering.
- Caller cancellation owns work only until inbox acceptance; it does not retract an accepted message or dispose the target.
- Human prompts, settlement notices, QueueDock, and continuable fork enablement remain separate decisions.

This decision supersedes the `followup` naming choice in [Intent-named subagent continuation operations](../simplification/2026-07-27-intent-named-subagent-continuation-operations.md), the public `reportFrom` and configurable delivery portions of [Continuable subagent report tool](../feature/2026-07-30-continuable-subagent-report-tool.md), and the report-specific delivery choice in [Subagent reports precede their settlement notices](../bug-fix/2026-08-17-subagent-report-settlement-ordering.md). Their provider, setup-contribution, prompt-guidance, durability, and settlement-ordering rationale remains applicable where not replaced here.
