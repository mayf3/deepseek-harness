# Agent Note: Web file and session references

Status: implemented

English | [中文](2026-07-27-web-file-and-session-references.zh.md)

## Problem

The Web composer had a reusable slash/reference trigger pipeline, but its `@` source was inert subagent-label text. Web needed Host-backed workspace-path discovery and structured cross-session snapshots without scanning the Host filesystem in the browser, binding session identity to a display label, or clearing a draft before Host-side snapshot preparation succeeded.

## Decision

Web exposes one combined `@file` and `@session` menu through `@deepseek-ai/dsh-client-ui-reference`. For each unquoted query it starts both Remote discovery calls concurrently and deterministically orders files before sessions with locale-registered labels; non-selectable file and session section headings distinguish the two contiguous candidate sections without entering the keyboard-selection index. An open quoted token searches files only. Either candidate domain may fail independently without hiding successful rows from the other.

The file capability follows the three-package seam: `@deepseek-ai/dsh-file-reference` owns `ctx.fileReferences`, the shared `@path` token grammar, candidate shape, and stable model guidance; `@deepseek-ai/dsh-file-reference-local` owns bounded per-agent Host-filesystem indexes, invalidation, and scoped prompt installation; `dsh-client-ui-reference` consumes the generated Remote namespaces and shared grammar. A file pick remains path-only prompt text and a directory pick retriggers completion below its trailing slash.

A session pick is an atomic composer reference. Its visible label is presentation, while its hidden value and clipboard form are the canonical `@[label](dsh-session:…)` mention produced by the Host. `session.prompt` parses those mentions and calls `ctx.sessionReferenceResolver.prepare()` before delivery. Delivery binds the prepared context to the exact message id through a one-shot outer `agent/pre-step` listener that inserts the frozen snapshot immediately before that message on an enter decision; ordinary discard or agent disposal releases the listener, and queue-to-steer relocation preserves the pairing. Invalid mentions, cancellation, missing capability, source-read failure, and budget failure deliver nothing.

The input machine keeps ordinary draft text and atomic references until the default sink reports Host acceptance. Serialization or Remote failure returns the same draft to editing. On success the logged prompt envelope remains the replay authority: the browser renders adjacent metadata-confirmed session references as separate reference chips and preserves that projection when following text is adjacent without whitespace, plus a compact session-source summary instead of the snapshot JSON baked into model content.

## Reference transaction

```text
type @ → parallel file/session Remote calls → pick path text or canonical session chip
       → serialize draft → Host parses and prepares all sessions → enqueue once
       ↘ any pre-enqueue failure: retain the unchanged editable draft
```

File lookup is advisory and cancellable; selection itself performs no read. Session preparation is authoritative and all-or-nothing because the source snapshot must be fixed before the target inbox accepts the message.

## Alternatives considered

**Implement file discovery and grammar inside the Web client.** Rejected because browser-side code cannot safely access the Host workspace, while duplicating grammar, ranking, bounds, and invalidation would drift from the Host provider.

**Scan files through ordinary filesystem-tool RPCs.** Rejected because recursive fuzzy discovery is editor latency work, not a model-facing exact filesystem operation, and would couple the menu to tool policy and provider round trips.

**Eagerly attach selected file contents.** Rejected because selection would spend context before relevance is known and bypass the logged, auditable `read` call/result sequence.

**Represent sessions as plain `@label` text.** Rejected because labels are neither stable nor unique and cannot identify the source snapshot. Canonical Host-produced mentions preserve opaque session identity while keeping a readable display.

**Clear the composer before the RPC settles.** Rejected because a failed preparation would lose the only editable copy of the request and visually claim acceptance that never occurred.

## Verification

Package tests pin shared file grammar and ranking, cache invalidation and lifecycle cleanup, parallel Web lookup, quoted paths, independent candidate failure, cancellation, grouped headings that do not alter option indexes, file/directory continuation, canonical session chips, adjacent-reference and adjacent-text reference projection, codec round-trip, the owning services' Remote faces, all-or-nothing prompt preparation, and draft retention across serialization and Remote failures. The keyless assembled Web snapshot renders the available reference sections, selects a file, then selects a session reference through the real client composition.

## Consequences

Web now uses the shared `@file` discovery seam and structured session-reference identity, while Host services remain the authority for filesystem and session access. The new file-reference seam adds two packages whose discovery methods are unary Remote contracts on the owning services, keeps browser bundles free of Node APIs, and permits another provider to align completion with a remote filesystem. Candidate lookup failures remain quiet menu degradation; submission failures remain explicit and recoverable. File references cost only path text plus stable conditional guidance, whereas session references retain the bounded snapshot cost and trust framing owned by `dsh-session-reference`.
