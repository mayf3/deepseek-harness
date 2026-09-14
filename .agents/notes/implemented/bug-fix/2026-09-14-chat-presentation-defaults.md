# Agent Note: Keep Chat presentation independent of Trajectory inspection

Status: implemented

English | [中文](2026-09-14-chat-presentation-defaults.zh.md)

## Problem

Trajectory inspection benefits from exposing complete recorded reasoning. Applying that default to Chat expands the live transcript during reasoning and changes its height when an answer or Tool call arrives. The Trajectory inspection change also added historical first-token recovery to Chat without a separate Chat behavior decision.

## Decision

[Chat](../../../../packages/client/ui-chat/README.md#turn-process-folding) starts each reasoning row collapsed and retains the reader's manual disclosure choice through subsequent output and settlement. Its reply timing uses observed live chunks; cold history does not recover first-token time from embedded streams. Turn-level process folding remains independently owned.

[Trajectory inspection](../feature/2026-09-09-ptc-trajectory-code-inspection.md) keeps its expanded reasoning default, recorded timing, JSON controls, and PTC code inspector. The [compact stream readers](../architecture/2026-09-06-embedded-stream-record-readers.md) remain available to Trajectory and other consumers. These decisions partially supersede the Chat presentation additions while preserving both notes' independent rationale.

## Alternatives considered

**Keep Chat's automatic expansion and historical timing recovery.** These change Chat behavior beyond the requested Trajectory inspection work. Reintroducing either requires a separate Chat product decision and its own verification.

**Revert the entire inspection change.** That would remove the requested Trajectory behavior along with the unintended Chat changes.

## Consequences

Chat reasoning requires a click to inspect in full, and reopened replies can lack first-token and decoding metrics. Component tests cover collapsed streaming and reasoning-only replies, manual disclosure across answer and Tool-call arrival, and cold-history timing. The recorded lifecycle and turn-tail browser scenarios verify the assembled Chat behavior; Trajectory tests retain its separate defaults and timing.
