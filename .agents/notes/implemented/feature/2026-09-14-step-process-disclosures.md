# Agent Note: Process disclosures between assistant responses

Status: implemented

English | [中文](2026-09-14-step-process-disclosures.zh.md)

## Problem

Whole-turn folding only shortens completed turns. Long ongoing turns interleave readable progress responses with tool and reasoning detail, obscuring the next response.

## Decision

The [Chat renderer](../../../../packages/client/ui-chat/README.md#turn-process-folding) groups consecutive process material between assistant responses. Reasoning and response blocks within one assistant node have separate renderer seats so streaming text closes the preceding process range without hiding the response. Group disclosure state survives updates under its first member key; the existing whole-turn disclosure remains the outer visibility owner. Its title reports elapsed time between the recorded turn boundaries; absent timestamps omit the duration.

Titles summarize model work instead of infrastructure records. Known file paths are deduplicated separately for reads and edits; command and search calls count individually. The three largest categories appear in descending count order, with first occurrence breaking ties. Unknown tools contribute to a generic tool count. Running groups describe the latest running tool, falling back to thinking between calls. Expanded content has a viewport-relative height cap and its own scroll area.

Whole-turn folding checks each Turn independently: while history is paginated, its start must be loaded. Requiring all Session history would disable folding throughout long goal and job sessions. Loading a missing start enables that Turn without waiting for unrelated older Turns.

## Alternatives considered

**Wait for turn completion.** This retains the clutter during the period when users read ongoing progress.

**Treat each assistant node as an indivisible response.** Reasoning-only steps and reasoning preceding streamed text would remain outside the process disclosure.

**Include infrastructure labels in summaries.** Prompt assembly, injected context, and permission metadata do not describe the model's work and make compact titles harder to scan.

## Consequences

The grouping changes presentation only and adds no Session events or model input. Tool names determine provisional categories, so custom tools count generically and missing file paths count per call. Disclosure state is local to the mounted chat view. Pagination that changes a group's first member may reset its expansion. Existing per-tool disclosures remain available inside the capped process area.
