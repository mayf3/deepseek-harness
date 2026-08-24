# Agent Note: Cache-preserving forked children stay one-shot

Status: implemented

English | [中文](2026-08-10-fork-children-stay-one-shot.zh.md)

## Problem

Fork's only difference from spawn is that the child Session is seeded with the parent's completed-turn prefix ([subagent-fork-in-process](../../../../packages/subagent/subagent-fork-in-process/README.md)). That seed costs real tokens — the inherited history is re-sent in every child request — and its one concrete payoff is provider-side prefix reuse: under the same provider and model, a child request whose leading bytes are identical to the parent's re-prefills none of the shared span. Anything a child scope adds *ahead* of the inherited history spends that payoff, because reuse stops at the first differing byte.

The child-scoped `report` return channel is now the largest such addition, and since [the report obligation](../feature/2026-08-06-continuable-child-report-obligation.md) it is two deltas rather than one: the `report` tool schema and the `tool:report` system-prompt section. Both live in the request head — the system block and the tool block precede every message — so a continuable forked child invalidates reuse before the first inherited turn and re-prefills the whole transcript it was forked to reuse. That composition pays fork's duplication cost and collects none of its benefit, while the parent still holds a reusable prefix the child could have shared.

## Decision

The cache-preserving compositions bind the fork delegation tool to `backgroundMode: one-shot`: [the base bundle](../../../../packages/bundle/base/cordis.patch.yml), [the ACP example](../../../../examples/acp-agent/cordis.yml), and [the headless example](../../../../examples/headless-agent/cordis.yml). The base bundle leaves `run_in_background` available, because it mounts a task service; the two examples set `enableRunInBackground: false`, because they mount none and a one-shot background start would otherwise fail at call time on a missing `tasks` service. The standard, code, and Cordis CLI presets instead bind fork to `continuable`; their child-scoped `report` additions invalidate the inherited prefix and accept the recomputation cost described here.

One-shot children — foreground and background alike — are created through `SubagentRuntime.start()`, which never enters the continuable activation-setup registry, so neither `report` nor its prompt section is installed. A forked one-shot child's system prompt and tool schemas therefore equal its parent's, apart from the `persona` and `toolFilter` deltas a deployment opts into per delegation tool.

`spawn` keeps `backgroundMode: continuable`. Continuable children and the report obligation ship unchanged for the provider whose child starts with no inherited prefix to protect, so this decision costs the report channel nothing.

### The restriction is composition, not code

`ForkInProcessProvider.prepareContinuable` stays implemented and `ctx.subagents.startContinuable()` accepts `fork`; composition chooses whether the fork tool is one-shot or continuable. `tool-subagent` knows both the provider's `inheritsParentContext` and its own `backgroundMode` at mount, so a load-time rejection of the pair is available and deliberately absent: the pair is not wrong in general. It is costly only while a child-scope delta precedes inherited history, and the package that creates that delta — [`dsh-tool-subagent-report`](../../../../packages/subagent/tool-subagent-report/README.md) — is separately installable and, by its own design, invisible to `tool-subagent`. A deployment that omits the report package can run continuable forked children with the prefix intact. Encoding one roster's consequence as a delegation-tool invariant would make the tool assert something it cannot observe.

The cache-preserving condition is recorded as a `TODO(fork-continuable-prefix-reuse)` marker on `prepareContinuable` and tracked as issue #2124: continuable fork preserves its inherited prefix when the child's system prompt and tool schemas can match the parent's byte for byte.

## Alternatives considered

**Reject `inheritsParentContext` + `continuable` at mount.** A loud load-time failure would prevent silent reintroduction, which is what the configuration change cannot do. Rejected because the delegation tool cannot see the report package and the combination is legitimate without it; the invariant would be false for a deployment that never installs a child-scope delta, and `tool-subagent` would be asserting a fact owned by the roster.

**Stop mounting the fork provider at all.** This was the broader form of the restriction. Rejected because foreground fork *is* the prefix-reusing case and is untouched by the report channel, so a full ban gives up the capability without buying anything the one-shot binding does not already buy — and would leave no shipped composition exercising session seeding.

**Use continuable forked children in cache-preserving compositions and accept the loss.** Rejected for the base bundle and ACP/headless examples because the loss is total rather than marginal: reuse breaks ahead of the inherited history, so the child pays full prefill on a transcript it duplicated for the sole purpose of not paying it. The CLI presets make the other tradeoff and retain continuable fork. A deployment that wants a long-lived child with no inherited context already has `spawn`.

**Make `report` visible to every Agent.** A global registration would restore byte-identical prefixes by giving parent and child the same schema and section. Rejected because roots, one-shot children, remote children, and agentless callers would advertise a tool with no derivable recipient, and execution-time rejection would make schema visibility disagree with authority — the scope-local decision the [report tool Agent Note](../feature/2026-07-30-continuable-subagent-report-tool.md) already settled.

**Install the child-scope deltas after the inherited history.** Rejected as unrepresentable: the system prompt and the tool schemas are request-head structures in every provider's wire format, so no ordering within them can place a child-only addition behind the message list.

## Consequences

- The base bundle and ACP/headless examples create only one-shot forked children; their `subagent_fork` returns a result to the caller's turn, and `send_message` addresses only spawned children there. The three CLI presets create continuable forked children.
- A one-shot forked child's request prefix stays byte-identical to its parent's unless the deployment configures `persona`, `toolFilter`, or a different LLM route on the fork delegation tool, so the token cost of seeding can buy provider-side reuse. Continuable fork adds `report` before the inherited history and forfeits that reuse.
- The fork provider's continuable path has CLI production callers and package-level tests. The same seam accepts one-shot composition, so a bundle or `--patch` overlay can choose either lifecycle without a code change or warning.
- `subagent_fork`'s model-visible schema changes: the continuable background wording is replaced by the one-shot task wording in the base bundle, and disappears entirely from the two examples. The affected keyless snapshot tool-schema sidecars are re-recorded in the same change.
- The report obligation reaches spawned children in every continuable composition and forked children in the CLI presets. Its default `next-step` scheduling, authority model, and coverage remain independent of fork composition.

### Accepted risks

The one-shot constraint lives in three configuration files and a code comment, not in a gate; the CLI preset rows already choose `backgroundMode: continuable` and incur the prefix loss. Any bundle or profile patch can make either choice without a warning. That is the accepted cost of not encoding one roster's consequence into `tool-subagent`.
