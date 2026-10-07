# Agent Note: Bound the attachment durability proof at unreadable ancestors

Status: implemented

English | [中文](2026-10-08-attachment-durability-proof-permission-boundary.zh.md)

## Problem

`saveImageFile` proves `DSH_HOME` durable once per process by opening every ancestor directory read-only and syncing it, all the way to the filesystem root. Deployments legitimately place homes below another account's traverse-only directory (for example a runtime root owned by a service account with mode `0711`, homes owned by the unprivileged runner account beneath it). Opening that ancestor as the runner fails with `EACCES`, the error escapes before `saveImageFile`'s wrapping `try`, and every image save in such a deployment fails — in production this surfaced as every `imagegen` tool call returning `EACCES: permission denied, open '<runtime-root>'` across 14 receipts while generation itself succeeded.

## Decision

The ancestor walk in `ensureDurableDirectory` stops at the first ancestor it cannot open with `EACCES` or `EPERM`, treating that ancestor as the effective durable boundary. A directory the process cannot read is also one whose entries it can neither create nor remove, so the durability of anything at or above it is not this process's obligation and cannot be proven by it; syncing beyond the boundary was never reachable semantics, only a crash. Ancestors the process can open keep the full proof to the filesystem root unchanged, and non-permission sync failures still propagate loudly.

## Alternatives considered

**Relax the deployment layout** — move homes above the service-account boundary or widen the runtime root's mode. Rejected: it changes shared production infrastructure and re-runs a deployment cutover to paper over a code assumption the store can own instead.

**Skip unopenable ancestors and keep walking upward.** Rejected: the walk's purpose is a boundary the process can vouch for; once an ancestor is unopenable the proof is already bounded, and continuing would spend syscalls proving nothing the store relies on.

**Wrap the walk failure into `ATTACHMENT_WRITE_FAILED`.** Rejected: masking a structural deployment mismatch as a storage error hides the one signal an operator needs; permission errors now stop the walk before publication, so only genuine publication failures reach that wrapper.

## Consequences

Image and attachment saves work unmodified in cross-account home layouts, with the durability guarantee unchanged below the permission boundary and honestly bounded above it. A pathologically write-only ancestor (writable but unreadable, mode `0---`-style) would end the proof early despite being mutable by the process; no known filesystem or deployment uses such a mode for ancestor directories of a harness home. Package tests pin the bounded walk order, the unchanged full proof, and loud propagation of non-permission failures.
