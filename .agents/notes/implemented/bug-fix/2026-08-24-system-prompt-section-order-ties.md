# Agent Note: Equal-order system-prompt sections render in activation order

Status: implemented

English | [中文](2026-08-24-system-prompt-section-order-ties.zh.md)

## Problem

`SystemPromptRegistry` sorts sections by `order` with a stable sort, so equal orders render in plugin-activation order. `tool:cordis` and `tool:workflow` both declared `order: 115`, while their activation order varies between clean platform compositions. ACP and SDK snapshot replays could therefore assemble the same sections in a different order from their committed `system-prompt.expected.md` files.

## Decision

Give the three ordered sections distinct values: `tool:cordis` stays at 115, `tool:workflow` moves to 116, and `tool:ralph` moves from 116 to 117 so it remains after workflow. Prompt text and tool schemas remain unchanged.

## Alternatives considered

**Normalize section order in the snapshot harness.** Rejected because the runtime, request header, and model prompt would remain sensitive to activation timing while only the fixture comparison hid the difference.

**Tie-break equal orders by section name in the registry.** Rejected because it would silently reorder every existing tie. Explicit orders keep each model-visible placement local to the contributing plugin.

## Consequences

The Cordis, workflow, and Ralph guidance has one platform-independent order. Prompt-section placements that require a stable relative position need distinct `order` values; stable sorting continues to preserve activation order for intentional ties.

## Testing

The keyless ACP and SDK snapshot replays pin the affected system-prompt order, and the full snapshot suite verifies the refreshed fixtures.
