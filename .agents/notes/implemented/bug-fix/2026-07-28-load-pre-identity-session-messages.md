# Agent Note: Load sessions persisted before message identity

Status: implemented

English | [中文](2026-07-28-load-pre-identity-session-messages.zh.md)

## Problem

The identified immutable message change replaced four durable event payloads with complete message values. Existing v0 JSONL Sessions still held the immediately preceding forms: direct `content`/`source` on user and steering events, `content`/`provenance` on assistant events, and `callId`/`content`/`isError` on tool results. Their headers still matched `SESSION_FORMAT_VERSION`, but current-form validation rejected them before resume could construct a live `Session`.

Changing the message representation without a version bump made those logs indistinguishable at the header level from current v0 logs. The runtime needs a narrow import rule that restores data created by the supported first-party provider without weakening validation for unrelated obsolete or malformed events.

## Decision

The frozen `@deepseek-ai/dsh-session-format-v0-to-v1` edge normalizes the four exact pre-identity message payloads after v0 decoding and before v1 validation. It wraps their existing semantic fields in the current role-specific message shape and assigns `legacy-message:<session-id>:<event-seq>` as the deterministic imported `MessageId`. A legacy `tool/result` content replacement inherits the imported id of its replacement target, preserving the current content-only rewrite invariant.

Every event-body operation runs the same edge through the build-static catalog before current Session construction. `load`, `inspect`, ownerless-state adoption, HMR prefix adoption, query, export, fork, and suffix reads therefore see one normalized current generation. Current-looking wrappers with missing or invalid fields are not repaired, and unsupported event vocabulary, request headers, versions, and surface relations retain their refusal paths.

JSONL migration leaves the exact suffixless v0 artifact path, bytes, and inode unchanged and exclusively publishes `session.v1.jsonl[.zstd]` beside it. Deterministic identities make repeated restoration reproduce the same message ids, and subsequent appends target only v1.

## Alternatives considered

**Reject the released logs.** This strands real first-party sessions even though every old field maps unambiguously to the current message representation.

**Keep a same-version importer inside the coordinator.** This avoids a format edge but leaves historical payloads in current Session code and provides neither immutable source/successor naming nor independently testable publication. The released adjacent migration system owns canonical publication instead.

**Mint random ids on each load.** The messages would satisfy the type shape but lose stable identity across inspect, resume, restart, and mixed legacy/current appends.

## Consequences

Pre-identity JSONL Sessions resume with their original message content, sources, assistant provider/model fields, tool correlation, errors, metadata, and surface replacements. The returned events are otherwise indistinguishable from current imported message snapshots and remain deeply frozen.

This is one explicit released-v0 normalization, not a permissive compatibility layer. Adding another normalization requires another complete, unambiguous mapping in the frozen edge; malformed current data continues to fail rather than being guessed into validity. Edge and JSONL generation tests exercise deterministic restoration and tool-result replacement identity.

## Related

- [Create every message as an identified immutable value](../architecture/2026-07-28-identified-immutable-message-values.md) — owns the current message identity and immutability contract.
- [Session persistence as an abstract service](../architecture/2026-06-14-session-persistence.md) — owns the append-only backend and resume boundary.
