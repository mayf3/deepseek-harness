# Agent Note: Load sessions from the pre-react-loop format

Status: implemented

English | [中文](2026-08-04-load-pre-react-loop-sessions.zh.md)

## Problem

The react-loop simplification changed durable events while retaining `SESSION_FORMAT_VERSION` 0. Stored sessions from the change's base contain `steering/message` and `turn/start.trigger`; their terminal reasons also use coarse `aborted`, separate `disposed`, and two older error payloads. Current surface and turn invariants cannot replay those records directly.

The new durable inbox is not part of this compatibility problem. The base emitted process-local inbox notifications but no `agent/inbox/*` session events, so replaying old history as pending work would resurrect already claimed or discarded prompts.

## Decision

The frozen `@deepseek-ai/dsh-session-format-v0-to-v1` edge recognizes the exact pre-react-loop shapes after v0 decoding and projects them into v1. It removes the obsolete `turn/start.trigger`, converts `steering/message` to the same identified `user/message`, maps old failure facts into the current structured error, folds `disposed` into an aborted turn with the `disposed` cause, and represents coarse aborted records with the persistence-only `{ kind: 'legacy' }` cause because their caller is unavailable.

Every persistence event-body entry point first migrates the complete detached artifact through the build-static catalog. `load`, `inspect`, adoption, HMR prefix comparison, and `readFrom` therefore receive the same validated v1 view; suffix reading happens only after immutable successor publication and current restoration.

The edge does not synthesize inbox splices. A resumed pre-react-loop agent begins with empty pending lists, matching the base runtime's inability to persist pending inbox work. Migration leaves the exact suffixless v0 generation unchanged and publishes one `session.v1.jsonl[.zstd]` successor before later events append.

## Alternatives considered

**Treat the released records as unsupported.** This strands sessions produced by the supported first-party writer even though the removed steering content and terminal facts have complete mappings.

**Replay old inbox notifications into durable splices.** Those notifications were not session events and do not provide a trustworthy pending-state snapshot. Inferring insertions without every claim and discard would re-run consumed work.

**Assign coarse aborted records to an existing caller.** Mapping them to `user`, `parent`, or `hook` would invent a caller that the old record did not name. A dedicated `legacy` cause keeps the stop classification without making a false audit claim.

**Keep a generic same-version importer in the coordinator.** This lets current Session code accumulate historical forms and gives no immutable physical generation naming or independently testable adjacent edge. The released migration lifecycle owns the conversion instead.

## Consequences

Sessions written in the refactor's base format resume through the current AgentLoop with their steering content, turn boundaries, error facts, and stop classification intact. The frozen edge and JSONL generation contract cover `load`/`inspect`/`readFrom`; an assembled JSONL Agent resume verifies that the historical transcript is visible while both new inbox lists start empty.

This exception supports the base format, not intermediate formats produced during development of the refactor. In particular, it defines no migration for earlier experimental `agent/inbox/spliced` payloads. Exact-shape recognition keeps malformed current-looking records on their rejection path instead of guessing them into validity.

## Related

- [Load sessions persisted before message identity](2026-07-28-load-pre-identity-session-messages.md) — owns deterministic identities for another released v0 normalization in the same edge.
- [Session persistence as an abstract service](../architecture/2026-06-14-session-persistence.md) — owns append-only backend storage and resume.
