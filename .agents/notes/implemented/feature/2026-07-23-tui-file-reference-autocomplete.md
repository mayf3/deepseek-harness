# Agent Note: TUI file-reference autocomplete

Status: implemented

English | [中文](2026-07-23-tui-file-reference-autocomplete.zh.md)

## Problem

The TUI offered structured `@session` references but no dependable way to discover workspace paths while composing a prompt. Requiring users to remember exact paths made file-oriented requests unnecessarily awkward, while eagerly attaching every selected file would spend context before the model knew whether its contents were relevant and would hide the normal `read` observation from the tool transcript.

## Decision

The shared `@deepseek-ai/dsh-file-reference-local` provider owns a bounded, cancellable host-workspace path index rooted at each active session's working directory. TUI consumes its search and grammar implementation directly, while Web reaches the same capability through the Host API as recorded in [Web file and session references](2026-07-27-web-file-and-session-references.md). Typing `@` at a token boundary fuzzy-matches files and directories; queries containing `/` list the named directory directly, accepting a directory continues completion, and paths containing whitespace use the `@"path with spaces"` form. Configuration controls result count, index size, and excluded directory basenames. The default exclusions are `.git` and `node_modules`; traversal does not follow directory symlinks or interpret ignore files.

Selecting a file changes only the editor text. The submitted user message retains the natural `@path` spelling and carries no injected contents, hidden context, or reference object. When the model-facing `read` tool is registered, the local provider contributes a stable system-prompt section that identifies `@` paths as explicit user references, directs the model to call `read` when contents are needed, and forbids claiming inspection before that call. Tool results invalidate the reusable fuzzy index so subsequent interactions observe likely workspace mutations.

Structured session mentions keep their existing snapshot preparation. Unlike files, a referenced session has no general model-facing retrieval tool, so reducing `@session` to a path-like label would make its content unreachable.

## Alternatives considered

**Eagerly inject selected file contents.** This spends tokens before relevance is known, can capture stale content before execution reaches the reference, and bypasses the auditable `read` call/result sequence.

**Require an external file finder.** Depending on `fd`, `rg --files`, or another executable would make baseline completion vary by host installation and complicate cancellation and cross-platform behavior.

**Use the filesystem service's ordinary directory-list operation for discovery.** That seam is optimized for exact model-facing filesystem operations and may represent a remote namespace; recursive fuzzy indexing would multiply provider round trips and couple editor latency to tool policy. Host-side discovery keeps the terminal interaction local, while the documented namespace-alignment limitation remains explicit for non-local deployments.

**Add a cross-package file-search capability before another consumer exists.** Rejected for the original TUI-only implementation because it would have split the seam prematurely. Web is now a second current consumer across a process boundary, so the later [Web reference decision](2026-07-27-web-file-and-session-references.md) introduces the interface / local implementation / consumer split and preserves this note's path-only semantics.

## Consequences

Users can discover and insert paths without making selection itself expensive or model-visible beyond the path. The model preserves agency over whether to inspect a file, and any inspection remains reconstructable through the logged tool transcript. The fixed instruction slightly enlarges TUI system prompts when `read` is present, and content-requiring requests take an additional tool round trip.

Completion is deliberately bounded and advisory: very large workspaces may omit paths beyond the configured index cap, ignored files may still appear, and remote or virtual filesystem deployments must align completion with the `read` namespace or supply a different provider. Shared-package tests pin token grammar, ranking, bounds, cancellation, invalidation, and path-only submission; terminal snapshots, the Web snapshot, and the real Loader PTY smoke pin the visible completion flows.
