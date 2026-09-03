# Agent Note: Inline Visualizer Cordis extension

Status: implemented

English | [中文](2026-08-29-inline-visualizer-cordis-extension.zh.md)

## Problem

DSH had no first-party Host contract for a model to request a temporary inline visual, progressively load construction guidance, or let a compatible Client submit an explicitly labelled follow-up from a successful HTML widget. Adding that surface globally would change every Agent preset even when no renderer or authority was present.

## Decision

`@deepseek-ai/dsh-tool-visualizer` is an independently loadable, dormant Host/model capability with two Cordis entrypoints. The root service owns Host source and complete-follow-up limits, exact-live-Agent and exact successful-`show_widget`-result authorization, the authoritative per-Agent follow-up rate limit, and insertion of authorized widget-authored follow-ups. Result authorization uses direct Session event lookup rather than a call-ID cache. Its generated Remote exposes `sendPrompt` to a separately supplied compatible Client; Client rendering limits remain independent security ceilings rather than transported Host configuration.

The package's `./model` function-plugin requires `systemPrompt` and `tools`, then recoverably injects `visualizer`; while authority exists it installs the `tool:visualizer` prompt plus `widget_guidelines` and `show_widget` only in an Agent preset standing scope. `standard` and `cordis` always mount this wrapper, so late authority appearance, withdrawal, and reappearance activate, remove, and reactivate the model surface for existing and new Agents. `minimal` and `ptc` omit it. PTC's nested code-dispatch log does not provide the ordinary `show_widget` call/result identity required by the follow-up bridge. No default application composition mounts the root authority, so the shipped default prompt and tool surfaces remain unchanged.

Each `widget_guidelines` result includes Delivery when `show_widget` is visible, then combines one shared Foundation with only the requested type modules. The Foundation owns host-native composition, responsive flow, theme use, and cross-type accessibility; the type modules own diagram structure, interaction lifecycle, chart semantics, and illustration exceptions.

Mounting the root authority exposes both raw SVG and HTML fragments; source-prefix detection selects the recorded kind without turning rendering policy into model-facing deployment vocabulary. This change supplies no presentation Client and does not activate the capability in Web, headless, or TUI. The Host exposes no mutable-state report, recovery, or model-read surface. No Visualizer session event, Agent-loop rule, or core schema is added.

## Verification

Focused tests pin the shared routing prompt, unified schemas and guidance, source and complete-follow-up UTF-8 limits, exact Agent and successful-result authorization through direct event lookup, per-Agent prompt limits, and root/model disposal. REAL Loader composition tests prove that default Web and headless profiles omit the authority, `standard` and `cordis` always mount a dormant model wrapper, `minimal` and `ptc` have no row, and late authority appearance, withdrawal, and reappearance update the inherited model surface for existing and new Agents without adding global tools or prompt sections.

## Alternatives considered

**Register the tools from the root service.** Rejected because that would make model policy deployment-global and bypass preset inheritance and child tool filtering. The always-mounted `./model` wrapper keeps authority at the Host root and model visibility in the owning preset scope.

**Enable the capability in default application compositions.** Rejected because this change does not include a presentation Client. Dormancy makes the Host/model contract reviewable and independently loadable without claiming an end-to-end user experience.

**Trust a Client-supplied call id without checking the session log.** Rejected because a presentation Client must not mint authority. The Host binds each follow-up to the exact live Agent and a successful recorded HTML `show_widget` result before it enters the inbox.

## Consequences

The capability is isolated to one package, two preset wrapper rows, generated catalogs, and TypeScript aggregates. Default applications retain their existing model surface. The root service controls whether the always-mounted wrapper exposes the model surface; a compatible Client is additionally required for the end-to-end user experience. The authority may be mounted, withdrawn, and restored without rebuilding the preset. The Client must provide rendering security and resource controls for accepted HTML. Mutable widget state is Client-local and resets when its document is recreated.
