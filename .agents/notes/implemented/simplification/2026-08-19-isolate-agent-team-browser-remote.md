# Agent Note: Isolate the Agent Teams browser Remote adapter

Status: implemented

English | [中文](2026-08-19-isolate-agent-team-browser-remote.zh.md)

## Problem

The Agent Teams domain service owned browser-specific Remote methods, view composition, and transport error mapping in addition to roster, mailbox, task, and lifecycle behavior. Mounting its generated contribution also required a separate package with an inert Host entry and both Host and Client compiler faces. Those responsibilities widened `ctx.teams` for one consumer and created a compiler-layout exception without an independent runtime owner.

## Decision

`@deepseek-ai/dsh-team` is a domain-only `ctx.teams` service. `@deepseek-ai/dsh-agent-team-remotes` provides a stateless Host adapter registered as `ctx.teamRemote` with the distinct Typert wire namespace `teams`. Its `view`, `createTask`, and `updateTask` methods delegate to the exact `ctx.teams` instance selected by Cordis injection. Browser view types and the closed task-mutation result belong to the adapter package; Team errors are mapped there, while unexpected failures remain rejected.

The adapter package registers in the Host aggregate only. It generates the `ctx.remote.teams` Client contribution but has no Client plugin entry or inert Host half. `@deepseek-ai/dsh-client-ui-agent-team` mounts that contribution through the stable `ctx.remote` service and returns the generated disposer from its own plugin lifecycle.

## Alternatives considered

**Keep Remote methods on `TeamService`.** Rejected because view composition and carrier-facing error mapping serve only the browser consumer and make the domain service's public API depend on one presentation.

**Keep a separate Client assembly package.** Rejected because the assembly had no Host behavior, yet its package required Host and Client compiler faces solely to provide an inert root export and one `$mount()` call.

**Add the Team contribution to stable API Remotes.** Rejected because stable release packages cannot depend on private experimental packages, and doing so would make the Team namespace part of the shipped Client assembly.

## Testing

Adapter unit tests verify service-key separation, delegation, business-error mapping, and unexpected rejection propagation. Generated-artifact and plain-Node build checks verify the exported `teams` descriptors. Browser tests verify contribution mounting and disposal, and the Web composition test exercises the Host adapter through the real gateway.

## Consequences

`ctx.teams` is the only owner of Team state and exposes no browser-only operations or values. The Web profile carries one additional stateless Host service, and the UI package owns the contribution mount. Adding a browser operation changes the adapter and its generated artifacts without changing the Team domain interface.
