# Agent Note: Bound the attachment durability proof at unopenable ancestors

Status: implemented

English | [中文](2026-10-08-attachment-durability-proof-permission-boundary.zh.md)

## Problem

`saveImageFile` proved `DSH_HOME` durable once per process by opening every ancestor directory read-only and syncing it, all the way to the filesystem root. Deployments legitimately place homes below another account's traverse-only directory (for example a runtime root owned by a service account with mode `0711`, homes owned by the unprivileged runner account beneath it). Opening that ancestor as the runner fails with `EACCES`, the error escapes before `saveImageFile`'s wrapping `try`, and every image save in such a deployment fails — in production this surfaced as every `imagegen` tool call returning `EACCES: permission denied, open '<runtime-root>'` across 14 receipts while generation itself succeeded.

## Decision

The home proof now proves exactly what the call can change and bounds what it cannot:

- **Created entries are proven required.** Before `mkdir`, the walk records the highest already-existing ancestor. Every parent recording a directory the call created — the home itself and any missing levels below that ancestor — is synced as a requirement; if one of those parents cannot be fsynced, including a parent that grants write and search without read, the save fails loudly rather than reporting a reference whose durability is unprovable.
- **Above the created range the proof is best-effort and bounded.** The call creates no entries there, so an ancestor this process cannot open (`EACCES`/`EPERM`) simply ends the proof; stopping is sound because nothing of this call lives at or above the stop, not because unreadability would imply anything about writability — POSIX grants create on write+search directories whose entries cannot be read, so unreadability alone proves nothing.
- **The object and bucket/staging walks stay strict.** Those directories and their recording chain live inside the home and are created by this call, so every sync on their path to the home boundary is required and any failure propagates.

A directory another process created but has not yet synced is still never mistaken for a safe boundary within the proven range; above the bound, the guarantee is honestly left to the account that owns those entries.

## Alternatives considered

**Relax the deployment layout** — move homes above the service-account boundary or widen the runtime root's mode. Rejected: it changes shared production infrastructure and re-runs a deployment cutover to paper over a code assumption the store can own instead.

**Stop the walk at any unopenable ancestor with no created-range distinction** (the first candidate). Rejected in review: it silently swallowed permission failures on directories whose entries the call itself had just created, and its justification — unreadability implying writability — is not a POSIX fact, since `w+x` without `r` permits creating entries that could never be proven durable.

**Wrap the walk failure into `ATTACHMENT_WRITE_FAILED`.** Rejected: masking a structural deployment mismatch as a storage error hides the one signal an operator needs; required-range failures now surface with their real cause.

## Consequences

Image and attachment saves work unmodified in cross-account home layouts. The durability guarantee is complete over every entry the save creates, and honestly bounded above the highest ancestor the process can open — where another account's deploy-time durability practice takes over. A first save into a wholly missing home under a write-only-to-this-process ancestor now fails loudly instead of claiming an unprovable reference. Package tests pin the required created-entry chain, the bounded best-effort range (traverse-only and write-only ancestors), loud propagation of non-permission I/O errors, and real publication failures.
