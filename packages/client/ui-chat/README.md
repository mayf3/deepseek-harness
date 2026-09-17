---
description: "Browser Chat target that renders Session conversation nodes, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

Use this package to render a browser chat from recorded Session conversations, including historical images, localized actions, and restored scroll position. Compact display folds completed-turn process rows while keeping the final answer and independently useful context visible; packed historical Assistant runs remain collapsed. Local transcript and steering submissions appear immediately, remain in their original surface, and disappear atomically when authoritative Session records arrive, while queued submissions stay outside Chat. The package does not assemble or modify model requests.

File-mention providers receive the viewed Session ID with the closing-turn owner, so links into inherited history can address the fork itself.

## Table of Contents

- [Reference previews](#reference-previews)
- [System prompt row](#system-prompt-row)
- [Command and failure rows](#command-and-failure-rows)
- [Turn token usage](#turn-token-usage)
- [Completed-turn footer](#completed-turn-footer)
- [Turn Process Folding](#turn-process-folding)
- [Scroll ownership](#scroll-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="reference-previews"></a>
## Reference previews

Chat supplies file and HTTP(S) navigation through one `MarkdownDelegateProvider` around its node list. Assistant Markdown file links open in the right Sidebar after the message settles, including references to unmodified files. Relative paths resolve in the viewed Session's workspace; absolute paths retain the same Session's filesystem access. `#L24` and `#L24-L30` navigate to the first specified line and reuse an existing file tab. Missing files show the preview's error state.

HTTP(S) links in Assistant Markdown open a new right-Sidebar Browser tab on ordinary clicks when that type is registered, or the system browser otherwise; modified clicks retain the native external-link behavior. Sent file references and skills confirmed by the message’s logged invocation also open in the right Sidebar. File paths use the viewed Session; skill names resolve through its current input-trigger source. Both use the prose file-link dotted underline on hover or focus. Sessions, directories, and command labels remain non-navigating references.

<a id="system-prompt-row"></a>
## System prompt row

Each nonempty appended `system/message` owns a collapsed prompt row, including a complete prompt at the start of a headerless window; the same-step header does not duplicate it. Chat also shows a collapsed `System prompt` row for a non-empty initial request, explicit message-series start, or `system/message` surface node replacement whose text differs, reading the last nonempty surviving system node in surface order at the `request/header`; a non-initial request whose preceding header is outside the loaded history window also shows one. A resume repeats the row even when its system text is unchanged, including after pagination supplies the preceding header and system node; same-series config-only or tool-only changes, tool steps, and retries create no repetition, and a `system/message` event is never rendered as a transcript message. The row appears before that request's user messages, matching the provider envelope, and expands to the exact model-visible text with its original line breaks. A request whose system node is empty or outside the loaded window creates no row until the page holding the node arrives.

<a id="command-and-failure-rows"></a>
## Command and failure rows

Generic command rows retain the ordinary command glyph in every lifecycle state; failure remains explicit through the row state and summary. A terminal Turn failure remains a separate red-dot notice; intermediate model retries do not create that notice, and an output-token limit uses the amber warning dot.

-----

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn shows an expandable usage row only when the loaded window includes `turn/start` and every started model attempt reports safe, exact usage. The row omits unavailable optional buckets. Incomplete or contradictory accounting hides the complete disclosure instead of presenting a partial total.

Settings → General → Performance & usage stores `ui-chat.performanceUsage` as `detailed` (default) or `compact`. Compact shows only available output speed and cache-hit percentage beneath the composer, without interactive statistic dialogs or per-Turn usage. Detailed exposes session statistics and per-Turn token usage. Neither mode shows elapsed time in the completed-turn footer. The preference changes presentation only; accounting and Session events remain intact.

On non-loopback browsers, the preference remains process-local because the settings scope cannot persist writes. Explicit selections update every consumer immediately; accepted Host settings reconcile the live value on loopback browsers.

<a id="completed-turn-footer"></a>
## Completed-turn footer

The completed-turn action footer sits at the bottom of its Turn, 20px below the preceding prose or extension content. Only the latest Turn ending in response content keeps its actions visible; trailing reasoning, tools, notices, or other content makes them appear on hover or keyboard focus, like historical Turns. Devices without hover keep actions visible. Feedback and copy still address the last text response.

-----

<a id="turn-process-folding"></a>
## Turn Process Folding

Each reasoning row starts collapsed, including during streaming and in reasoning-only replies. Clicking the row opens or closes its complete Markdown; incoming answer text, Tool calls, and stream completion preserve that choice. Expanded reasoning uses compact secondary typography: headings add bold weight without changing text size, line height, or color. While streaming, the collapsed summary stays on one line and follows the latest reasoning line; after settlement, the collapsed row shows only `Think`.

Settings → General exposes the persisted `Work details` preference in the `ui-chat` namespace: `Compact` (default), `Detailed`, and `Expanded`. Compact folds completed Turns; Detailed and Expanded omit the whole-Turn control. Detailed defaults step groups to collapsed; Expanded defaults them to expanded. Both allow manual step toggles. The saved `transcriptView` field accepts legacy `normal`, which the client reads as `expanded` without rewriting storage; explicit choices save only the three current values. The opening System prompt remains independently visible before the opening User. In Compact and Detailed, consecutive process rows between Assistant responses default to collapsed, including reasoning preceding response text in the same node. The live title reports the latest running tool category, otherwise analysis activity. Retry rows remain independent of secondary process groups. A following Assistant response closes the range as soon as visible reply content starts. Completed titles aggregate distinct calls by category, including repeated paths, and show the three most frequent categories without counts; ties retain first appearance order. Two categories use “and” (Chinese “并”, sharing an initial “已” only when both phrases have it); three use commas, and more than three add “etc.” (Chinese “等”). English continuation phrases start lowercase. With no tool statistics, completion uses the analysis fallback. System prompts, context injection, and permission metadata never contribute categories. Expanded ranges scroll within the smaller of 400px and half the viewport height. At `turn/end`, its latest Step becomes the final-answer boundary only when it contains non-blank text, an image, or an unknown visible block—and no Tool-call block; preceding Context injection, reasoning, earlier Assistant material, Tool rows, and Retry rows then collapse by default. The control appears at `turn/start` and stays expanded and disabled during execution. It displays `Worked for …` (Chinese `已处理…`), ticking each second with a minimum of 1s. Normal completion fixes the duration at a minimum of 1s, displays `Took …` (Chinese `用时…`), and defaults to collapsed. Cancellation displays `Stopped` (Chinese `已停止`); failure displays `Failed` (Chinese `处理失败`). Cancelled and failed Turns stay expanded with a disabled control. Missing start timestamps omit the duration. A Turn with no process rows or inline reasoning keeps the elapsed label but hides its chevron and disables disclosure. A full-width divider below the summary separates it from the answer or expanded process rows. User and steering messages, System prompt, error, max-token, and turn-tail rows stay outside, and a closed Turn with no final answer folds all process rows while keeping independent rows visible. A newly available process control is inserted without changing the relative order of existing rows: opening human input precedes the control and process rows from their first projection, while System prompt remains above that input. While older history remains available through Load earlier, closed Turns whose `turn/start` is loaded can fold independently, including Turns awakened by context injection. A Turn missing its start waits until pagination supplies it or exhausts history; unrelated unloaded Turns do not block folding. Stable Chat Node Seats preserve row placement, hidden members add no flow spacing, and a closed control sits 8px above its answer only when no independent input intervenes. Completion collapse does not depend on tail-follow position, so a reader above the tail may see the transcript reflow. An automatic collapse that would hide keyboard focus keeps the group open and leaves focus in place; a manual close focuses the process control before hiding its members. Closing a whole Turn resets its nested groups and tool details to collapsed; hidden process renderers remount while their seats stay stable. The session-scoped store records expanded completed answer generations; different answer generations start collapsed.

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts. Pinned scroll deliveries without reader movement update follow ownership immediately, before subsequent layout changes can invalidate their floor. Reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures. Submitting transcript input or steering immediately restores tail following and clears an older pending reader sample. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn. Turn-rail previews paint above sticky Markdown code-block banners, while the rail frame remains inside the transcript band above the composer.

The turn rail mounts only visible marks, overscan, and the focused mark's neighbors. Its fixed pitch and observed viewport size determine scroll offsets without reading the DOM scroll extent. Initial placement waits for the body's restored active Turn and the rail's first usable viewport size. The ref controls activate a Turn or scroll the rail independently; the transcript itself remains fully mounted.

While the pointer is outside the rail, automatic follow keeps the rail still when the active mark's center is inside the fade-free band and centers it after it leaves that band. Previews follow pointer movement or focus; marks scrolling under a stationary pointer do not select another preview.

<details>
<summary>Scroll implementation — click to expand</summary>

`useChatViewport` owns turn-aware DOM reads, clamped writes, and native events. `useChatReading` owns follow policy, sampled reader input, and semantic memory; `useChatNavigation` owns turn jumps and history-prepend preservation. `useChatScroll` coordinates their committed inputs. Explicit navigation carries its measured landing into reading policy, so it does not rediscover the known target with a hit test.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.

Non-human input claimed from the next-turn Inbox appears as an independent trigger notice above the Turn control. A first-step next-step claim also qualifies when that Turn has no next-turn claim or human input in its next-step batch. Ordinary pre-step injections remain context rows. The notice stays visible in every work-details mode, defaults to collapsed, and expands its source and original notification independently of process folding. Titles recognize schedules, jobs, goals, agent/team messages, webhooks, and Cordis runner outcomes; unknown sources or status formats retain generic attribution. User-attributed SDK and delegated inputs remain user messages because the log does not distinguish their caller.
