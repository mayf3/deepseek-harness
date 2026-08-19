# Agent Note: Experimental Agent Teams Web controls

Status: implemented

English | [中文](2026-08-06-agent-teams-web.zh.md)

## Problem

The durable Agent Teams runtime owns roster, mailbox, and task state but exposes only model tools and Host service methods. Web users need to inspect teammate activity, manage shared tasks with the same compare-and-set rules, and open a teammate conversation. Agent Teams is still experimental, so these capabilities must not add Team-specific contracts or dependencies to the stable API Proxy, Client runtime, Subagent UI, or Web bundle.

## Decision

The [browser Remote adapter decision](../simplification/2026-08-19-isolate-agent-team-browser-remote.md) places `teams/view`, `teams/createTask`, and `teams/updateTask` on the private `ctx.teamRemote` service, whose wire namespace remains `teams`. The adapter delegates to `ctx.teams` and owns browser-safe view and mutation-result types. Views contain roster and current task state but omit pending mailbox content and deleted task tombstones. Task conflicts cross Remote as a closed business result so the browser can preserve `team-task-conflict`; transport and lookup failures remain ordinary `RemoteResult` failures.

`@deepseek-ai/dsh-client-ui-agent-team` mounts the adapter's generated contribution through the stable `ctx.remote` service, then consumes `ctx.remote.teams`, Client Session navigation, locale, and slots. It displays roster status, model and diagnostics and supports task create, edit, dependency update, assignment, completion, reopen, and deletion. Every mutation sends the displayed revision. A conflict reloads the complete Team view and asks the user to review only after the reload succeeds; a reload failure remains visible. Overlapping refreshes publish only the latest request for the selected Session, and a successful mutation invalidates older refresh snapshots.

Teammate navigation uses the existing `{ parentSessionId, childSessionId, mode: 'continuable' }` Subagent address without a Team tag. The UI refreshes the direct-child catalog, rechecks the selected Session, and opens the addressed conversation. History and later human prompts follow the stable Subagent path; the Team mailbox remains reserved for Team peer delivery from Team tools.

`@deepseek-ai/dsh-agent-team-web-profile` inserts the private Host Remote adapter and UI after the stable Web bundle. It is applied alongside the Host-side `@deepseek-ai/dsh-agent-team-profile`. Neither stable bundle contains disabled Team rows or dependencies.

## Boundaries

The Web UI has no mailbox timeline, worktree or Git controls, teammate creation, rename, deletion, interruption, or automatic merge behavior. It does not infer filesystem authority from task ownership or write scopes. A human continuation after teammate navigation is an ordinary addressed-child prompt, not a Team mailbox message.

## Alternatives considered

**Extend the legacy API Proxy Team RPC map.** Rejected because it would put an experimental domain in a stable wire package and duplicate the generated Remote vocabulary and validation.

**Add Team metadata to the stable Subagent address and prompt routing.** Rejected because ordinary child navigation already identifies the conversation. A Team tag would couple stable Client and Subagent contracts to experimental mailbox policy.

**Put disabled Team rows in the stable Web bundle.** Rejected because a disabled row still creates release dependencies and makes the experimental package part of shipped composition.

## Testing

Remote-adapter unit tests, generation, and a plain-Node built-artifact smoke verify delegation, error mapping, and typed methods. Client typechecking and browser component tests cover the mounted namespace, Lead routing, every task action, successful and failed conflict reloads, stale async results, navigation, disposal, and status or error presentation. A Web end-to-end test composes both experimental profile layers over the real Host Remote flow.

## Consequences

The Team service remains the only state machine and exposes no browser-specific methods or result types. The stable API Proxy, Client runtime, Subagent UI, and Web bundle remain Team-agnostic. Source-checkout users must add two ordered experimental profile layers to a Web profile, and promotion can move those packages without changing their npm names or generated namespace.
