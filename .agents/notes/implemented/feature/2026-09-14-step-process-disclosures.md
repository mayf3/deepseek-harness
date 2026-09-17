# Agent Note: Process disclosures between assistant responses

Status: implemented

English | [中文](2026-09-14-step-process-disclosures.zh.md)

## Problem

Whole-turn folding only shortens completed turns. Long ongoing turns interleave readable progress responses with tool and reasoning detail, obscuring the next response.

## Decision

The [Chat renderer](../../../../packages/client/ui-chat/README.md#turn-process-folding) groups consecutive process material between assistant responses. Reasoning and response blocks within one assistant node have separate renderer seats so streaming text closes the preceding process range without hiding the response. Group disclosure state survives updates under its first member key; the existing whole-turn disclosure remains the outer visibility owner. Its title reports elapsed time between the recorded turn boundaries; absent timestamps omit the duration.

Titles summarize tool categories, not individual tool names or infrastructure records. Every distinct call contributes once, including repeated paths. Count ranks the top three categories but stays out of the title; ties retain first appearance order. Two categories use “and”, three use commas, and only more than three add “etc.” Chinese uses “并”, “，” and “等”, sharing “已” only when both of two phrases start with it. English continuation phrases start lowercase. Running groups describe the newest running tool category, otherwise analysis activity; a completed group without tools uses the analysis fallback. Retry rows remain independent of secondary process groups. Expanded content has a viewport-relative height cap and its own scroll area.

Whole-turn folding checks each Turn independently: while history is paginated, its start must be loaded. Requiring all Session history would disable folding throughout long goal and job sessions. Loading a missing start enables that Turn without waiting for unrelated older Turns.

## Alternatives considered

**Wait for turn completion.** This retains the clutter during the period when users read ongoing progress.

**Treat each assistant node as an indivisible response.** Reasoning-only steps and reasoning preceding streamed text would remain outside the process disclosure.

**Include infrastructure labels in summaries.** Prompt assembly, injected context, and permission metadata do not describe the model's work and make compact titles harder to scan.

The whole-turn control appears at the start event and remains expanded and disabled during execution, displaying `Worked for …` with a minimum of 1s. Normal completion fixes the clock, displays `Took …`, and defaults to collapsed. Cancellation and failure display `Stopped` and `Failed` respectively and remain expanded with a disabled control.

Work details provides Compact, Detailed, and Expanded defaults for the two disclosure levels. Legacy normal settings resolve to Expanded on read; new choices persist only current values.

## Consequences

The grouping changes presentation only and adds no Session events or model input. Tool names determine categories; unmatched custom tools use the generic category. Disclosure state is local to the mounted chat view. Closing the whole Turn resets nested process groups and remounts hidden process renderers so tool and detail disclosures start collapsed when reopened. Pagination that changes a group's first member may reset its expansion. Existing per-tool disclosures remain available inside the capped process area.

Non-human Turn triggers use durable Inbox claims rather than every context injection. Next-turn claims and first-step next-step claims without a competing next-turn claim or human batch input receive independent notice seats above the process control. Policy injections do not qualify. Recorded source plus recognized producer framing supplies the title; missing names use recorded identifiers and unknown status formats stay neutral. User-attributed programmatic requests cannot be distinguished reliably and keep their existing presentation. Notice expansion survives whole-Turn folding.

Turn actions are anchored after the recorded Turn end so later reasoning, Tools, and steering stay above the footer. The latest Turn keeps actions visible only when its final content is a response; other endings and historical Turns reveal actions on hover or keyboard focus. The feedback target remains the last durable text response.

Chat filters system prompts, ordinary context injections, and permission command rows before grouping, navigation, and visible-content checks. Filtering is presentation-only: durable records remain available to trajectory inspection. Waking context is classified as a separate turn-trigger notice and stays visible, because it explains why a new reply started. Metadata alone cannot create an empty process disclosure.
