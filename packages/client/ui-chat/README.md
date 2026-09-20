---
description: "Browser Chat target that renders Session conversation nodes, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

Use this package to render a browser chat from recorded Session conversations, including historical images, localized actions, and restored scroll position. Work-details modes control reasoning previews and fold eligible completed-turn process rows without hiding final answers. Local transcript and steering submissions appear immediately, remain in their original surface, and disappear atomically when authoritative Session records arrive, while queued submissions stay outside Chat. The package does not assemble or modify model requests.

File-mention providers receive the viewed Session ID with the closing-turn owner, so links into inherited history can address the fork itself.

## Table of Contents

- [Reference previews](#reference-previews)
- [Hidden Chat rows](#system-prompt-row)
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

Settings → General → Open chat links in selects the destination for ordinary clicks on Chat HTTP(S) links: Built-in browser (default) opens a new right-Sidebar Browser tab, while New browser tab opens an external tab. The setting is shown only while the built-in browser is available. If the Sidebar Browser is not registered, both choices use the external browser; modified clicks retain native behavior. The `ui-chat.linkOpening` preference persists on loopback browsers and stays process-local when settings cannot persist writes. Sent file references and skills confirmed by the message’s logged invocation also open in the right Sidebar. File paths use the viewed Session; skill names resolve through its current input-trigger source. Both use the prose file-link dotted underline on hover or focus. Sessions, directories, and command labels remain non-navigating references.

<a id="system-prompt-row"></a>
## Hidden Chat rows

Chat omits system-prompt and `permission` command rows in every work-details mode. The filter changes neither recorded Session events nor Trajectory inspection. Ordinary Context injection and other command rows remain in Chat; Context injection can fold with the owning Turn's process content.

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

The completed-turn action footer starts 20px below the preceding prose or extension content.

-----

<a id="turn-process-folding"></a>
## Turn Process Folding

Each reasoning row starts collapsed, including during streaming and in reasoning-only replies. Clicking the row opens or closes its complete Markdown; incoming answer text, Tool calls, and stream completion preserve that choice. Expanded reasoning uses compact secondary typography: headings add bold weight without changing text size, line height, or color. While streaming, all modes preview the latest paragraph whose first line ends with a newline. Further text in that paragraph does not change the preview; an unfinished single line has no preview. One or more blank lines separate paragraphs. The one-line preview fades at the right edge. After settlement, Compact hides the preview, while Detailed and Expanded show the full text's first line.

Reasoning rows retain the disclosure's callback, icon, and unchanged content references. Each reasoning row selects its preview visibility from the display policy; mode changes toggle CSS display without unmounting the collapsed summary or updating its parent Assistant renderer. Full Markdown elements are created only while expanded.

Settings → General → Work details stores `ui-chat.transcriptView` as `compact` (default), `detailed`, or `expanded`. A saved legacy `normal` value reads as `detailed` without being written back; it is not offered as an option.

| Behavior | Compact | Detailed | Expanded |
|---|---|---|---|
| Settled reasoning preview | Think title only | First line | First line |
| Individual reasoning and tool bodies | Manual expansion | Manual expansion | Manual expansion |
| Eligible completed-Turn process | Folded by default | Folded by default | Folded by default |

While a Turn is open, its process rows remain in the transcript; individual reasoning and tool disclosures retain their own expansion state. At `turn/end`, its latest Step becomes the final-answer boundary only when it contains non-blank text, an image, or an unknown visible block—and no Tool-call block. If that Turn's `turn/start` is loaded, preceding Context injection, reasoning, earlier Assistant material, Tool rows, and Retry rows fold by default. Folding eligibility is per Turn: a complete Turn can fold while Load earlier remains available, and a Turn whose start is missing keeps its process content visible until that start arrives. A closed Turn with no final answer also keeps all process evidence visible.

The control reports Turn-wide durable counts for non-subagent Tool calls, reply-bearing Assistant messages before the final answer, and subagent delegation calls. Zero-valued segments are omitted; the Tool and subagent figures are mutually exclusive, and Context injection contributes no count. When all three counts are zero, the process still folds and the control reads `Thought for a while`. A full-width divider below the summary separates it from the answer or expanded process rows. User and steering messages, error, max-token, and turn-tail rows stay outside. A newly available process control preserves existing row order, with opening human input before the control and process rows.

Stable Chat Node Seats keep every renderer mounted, hidden members add no flow spacing, and a closed control sits 8px above its answer only when no independent input intervenes. Completion collapse does not depend on tail-follow position, so a reader above the tail may see the transcript reflow. An automatic collapse that would hide keyboard focus keeps the process open and leaves focus in place; a manual close focuses the process control before hiding its members. The session-scoped store records only manually expanded Turn-and-answer-Step generations; a different answer generation starts collapsed. Switching work-details modes preserves manual expansion.

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts, with browser scroll anchoring disabled on its scrollport only while following the tail. Pinned scroll deliveries without reader movement, and reader input that reaches the exact floor, update follow ownership immediately, before subsequent layout changes can invalidate their floor. Other reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures. Submitting transcript input or steering immediately restores tail following and clears an older pending reader sample. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn. Turn-rail previews paint above sticky Markdown code-block banners, while the rail frame remains inside the transcript band above the composer.

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

- **Secondary process grouping is not implemented** — Detailed and Expanded currently display the same Chat content. Expanded retains whole-Turn folding and does not automatically open individual reasoning or tool bodies.

- **Developer messages are not displayed** — presentation is intentionally deferred; encountering `developer/message` throws instead of rendering a fallback row.

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.
