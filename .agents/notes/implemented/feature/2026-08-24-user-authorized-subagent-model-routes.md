# Agent Note: User-authorized subagent model routes

Status: implemented

English | [中文](2026-08-24-user-authorized-subagent-model-routes.zh.md)

## Problem

Registering an LLM adapter makes its routes reachable, but does not authorize an Agent to choose every reachable model for a child. A single enabled preference over the live adapter registry expands silently when another provider or model appears. The product needs an explicit, stable authorization decision without rendering a potentially large model directory into every parent request.

## Decision

The Host-owned `subagent-model-selection` settings section stores `allowedModels`, an array of exact `{ provider, model }` routes. An empty array disables model-facing child route selection. The Plugins settings card reads the live adapter directory through `llm.models`, lets the user stage one or more exact routes, and replaces the whole array in one revision-fenced field write. It stores no adapter-owned display names, descriptions, or reasoning-effort metadata. A stored route absent from the current directory remains visible as unavailable and removable; a provider-local catalog failure does not block other providers or erase stored authorization.

A newly composed top-level Session snapshots a non-empty route list in `subagent/model-selection-policy` before its model-selectable definitions can reach a request. Child Sessions inherit that exact list from their live parent, and resumed Sessions use the recorded event instead of current settings. Settings changes therefore affect only subsequently composed top-level Sessions.

The fixed `list_subagent_models` schema does not enumerate the policy. At call time, provider and model listings are the intersection of the Session route list and the adapter's live advertised directory. An exact provider/model lookup first requires authorization, then resolves the adapter-owned model metadata and all advertised reasoning efforts. The delegation executor independently rejects any explicit provider, model, or effort selection whose effective provider/model route is outside the Session list before `resolveCallConfig()` validates adapter availability and effort support. A call that supplies no selection field retains configured or inherited routing because the model made no route choice.

Static `enableModelSelection: true` remains an unrestricted deployment-owned mode for custom compositions. The shipped `modelSelectionSettings` path is user-authorized and default-off. The primary spawn tool uses that path; the shipped fork tool still exposes no route selection so inherited conversation prefixes remain eligible for provider-side KV Cache reuse.

## Alternatives considered

**Render the allowed routes in the delegation description.** Rejected because a large or changing list would enlarge every request and invalidate an early prompt prefix. On-demand discovery keeps the fixed schema prefix-stable and logs directory content only when requested.

**Filter only the settings UI or discovery result.** Rejected because a model can guess a route or retain one from an earlier transcript. Authorization is enforced in the executor that starts the child.

**Store `enabled` and `allowedModels` as separate fields.** Rejected because two writes admit an enabled state with no completed authorization decision. A non-empty array is both the opt-in and its exact policy; an empty user-layer array can explicitly disable a deployment base list.

**Store per-route reasoning-effort allowlists.** Rejected because the user decision concerns child models, while effort ids and compatibility belong to the exact adapter route. Every adapter-supported effort remains available after the route is authorized.

**Read current settings on every discovery or delegation call.** Rejected because a settings edit would silently change a running Session's model-visible capabilities and execution authority. The durable Session snapshot keeps resume and child inheritance deterministic.

## Consequences

- New adapter registrations and newly advertised models do not expand user authorization.
- Adapter removals or catalog failures can reduce what discovery currently lists without deleting the saved route decision; an exact authorized route remains usable when its adapter accepts it even if the advisory catalog omits it.
- The allowlist itself consumes no parent-request tokens. Only a `list_subagent_models` result enters the transcript.
- Unit coverage pins settings validation, Session sampling and inheritance, discovery intersection, executor denial, stale UI candidates, staged whole-array writes, and rejected-write draft preservation. The assembled Web scenario pins the real settings document and Plugins card flow.

## Related decisions

The route arguments, adapter preflight, discovery tool, and fork cache restriction remain owned by [model-selected subagent routes](2026-08-18-model-selected-subagent-routes.md).
