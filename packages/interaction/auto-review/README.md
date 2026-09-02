---
description: "Per-tool LLM authorization review for users and maintainers operating the experimental Auto permission preset in the shipped Web application."
kind: "package-reference"
---

# @deepseek-ai/dsh-auto-review

English | [中文](README.zh.md)

## Summary

`dsh-auto-review` lets a user run the current Web session without a file sandbox while an independent LLM review decides whether each real tool call may execute. Every native call and every PTC inner call receives one review before its body starts; the outer `run_code` transport is not reviewed. An allow continues through the existing Full access execution path, while a deny or reviewer failure stops the body and preserves a structured reason for the Web tool card without exposing that reason to the main agent. The shipped Web bundle is the only supported host for this experimental preset; Headless, new-session defaults, General Settings, and out-of-process children do not enable it.

## Table of Contents

- [Use this package](#use-this-package)
- [Run the real-model certification](#run-the-real-model-certification)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Choose Auto review when a shipped Web user accepts Full access execution but wants the current session to check every actual tool action against the available authorization context. Do not treat it as a sandbox or deterministic policy: the reviewer can allow or deny incorrectly, and every accepted action runs with `danger-full-access` and approval policy `never`.

### Mounting the integration

The shipped Web bundle mounts the integration as one ordinary Cordis row after the base permission, Session, LLM, and Tool services are available:

```yaml
- id: auto-review
  name: '@deepseek-ai/dsh-auto-review'
```

The plugin calls the permission service's fixed `registerAuto(admit)` hook for its effect lifetime. The permission service owns the reserved identity and Full access knob bundle, while the shipped Web client locale dictionaries own the fixed Auto label and description. Users can select Auto for the current session through the Web picker or `/permission auto`, and it never enters `permission.defaultPreset` choices.

No runtime invariant companion is published because the root plugin's single effect owns authorization and teardown, leaving no independent observation that can diverge from that lifecycle.

### Review and failure behavior

The reviewer uses the latest logged provider/model route and receives five sections: the fixed `REVIEW_POLICY`, the Session working directory, current project instructions, filtered history, and the pending action. The request does not set the main Session's `sessionId`, and its project-instruction and history entries omit event `seq` coordinates. Only text in a current-surface message with source kind `user` and its own durable `rpcId` may authorize an action. Compaction checkpoints, current project instructions, parent-authored child prompts, other user-role messages, and historical calls are evidence only; assistant text, reasoning, and tool results are absent.

The decision protocol accepts only `{"decision":"allow"}`, `{"decision":"deny"}`, or `{"decision":"deny","reason":"..."}`. Missing or inconsistent logged facts, provider failure, context overflow, malformed output, and any other review failure deny the call before its body. Caller cancellation follows ordinary Tool settlement priority: cancellation after a late allow becomes the canonical pre-dispatch cancellation, while a deny or technical failure that has already settled remains an Auto denial.

<a id="run-the-real-model-certification"></a>
### Run the real-model certification

Set `DEEPSEEK_API_KEY`, then run the focused opt-in suite from the repository root:

```sh
DSH_AUTO_REVIEW_CERTIFICATION=1 pnpm exec vitest run --config vitest.e2e.config.ts packages/interaction/auto-review/tests/auto-review.e2e.ts
```

The suite skips unless `DSH_AUTO_REVIEW_CERTIFICATION=1`, even when credentials exist. Opting in without `DEEPSEEK_API_KEY` fails with an explicit configuration error. A successful run performs exactly 22 zero-retry reviewer calls and writes the redacted report outside the repository; set `DSH_AUTO_REVIEW_CERTIFICATION_REPORT` to choose that external path.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin prepends one `tools/pre-execute` listener. It rebuilds each native action from the visible `tool/call` plus the latest request-header schema, and each PTC inner action from its `tool/code-dispatch-start` snapshot. The current action appears only in `PENDING_ACTION`; only already-started historical calls remain in filtered history.

An Auto denial uses a fixed model-facing message that names the rejected tool and states that its body was not executed. Its `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED` identity and optional raw reason travel through the ordinary native or PTC structured-error fields. The Web tree recognizes that identity before keyed Tool-view dispatch and renders the generic denial card, so a specialized or external Tool view cannot hide the verdict. The presentation normalizes the reason only when it renders the card.

Publication and teardown are fail-closed. A persisted Auto session cannot publish without the live Auto registration. Before changing any preset during disposal, the plugin captures the exact Session object identities that are retiring from Auto. The listener checks that set before derived permission state, so a partial migration that has already appended `permission/preset` or `sandbox/mode` still cannot reopen Tool execution. The plugin closes new admission, switches the captured sessions to Read Only through the normal preset writer, and then aborts and awaits in-flight reviews. If every migration succeeds, teardown removes the listener and Auto registration; if any migration fails, Cordis reports the cleanup error while retaining both in their closed state, so later calls from retiring sessions stay denied and new Auto selections fail.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Fixed Auto registration, five-section request, strict decision parser, pre-execute listener, and teardown |
| [`tests/auto-review.spec.ts`](tests/auto-review.spec.ts) | Logged-input, decision, cancellation, native/PTC, restore, and disposal behavior |
| [`tests/auto-review.e2e.ts`](tests/auto-review.e2e.ts) | Opt-in 22-call real-model certification across eight semantic pairs, both execution paths, and all shipped models |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Permission presets](../permission-presets/README.md) — the fixed Auto registration and current-session write path.
- [Tools subsystem](../../../docs/subsystems/tools.md) — the pre-execute decision and structured native/PTC failure fields.
- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the in-process inheritance boundary.
- [Auto review decision](../../../.agents/notes/implemented/feature/2026-08-28-auto-review.md) — rationale, alternatives, and verification evidence.

-----

<a id="model-experience"></a>
## Model Experience

### Per-call authorization review

#### What the model sees

The reviewer receives the package-owned fixed policy and one user message containing `ENVIRONMENT`, `PROJECT_INSTRUCTIONS`, `FILTERED_HISTORY`, and `PENDING_ACTION`. The main agent receives no Auto-specific prompt, allow event, structured error identity, or reviewer reason; through ordinary Tool failure behavior, a denied call exposes only the fixed message that the named tool was rejected by Auto review and its body was not executed.

#### Token effect

Each native call and each started PTC inner call in Auto enters one review operation. A complete logged request creates one separate same-route LLM request with data-dependent input; missing required facts deny before provider contact. The package does not cache, batch, summarize, truncate, or retry reviews.

#### KV Cache effect

Review requests are independent of the main agent request and do not change its reusable prefix. The fixed reviewer policy can form a stable prefix across reviews, while the four data sections vary per Session and call.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the experimental Auto preset and its supported deployment.

- **Review is probabilistic, not confinement** — an allowed call runs with full host access, so the reviewer can cause either an unsafe allow or an unnecessary deny.
- **Support is limited to the shipped Web current session** — Headless, General Settings, future-session defaults, arbitrary host compositions, and out-of-process children do not expose Auto.
- **The reviewer receives only logged authorization facts** — it does not inspect Git state, environment variables, assistant reasoning, tool results, or a live Tool registry, and missing required facts deny the call.
- **There is no policy customization or fallback** — v1 has one fixed policy and no cache, grant, independent retry layer, audit event, or human fallback.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
