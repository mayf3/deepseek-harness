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

The reviewer uses the latest logged provider/model route and receives five sections: the fixed `REVIEW_POLICY`, the Session working directory, current project instructions, filtered history, and the pending action. The request does not set the main Session's `sessionId`, and its project-instruction and history entries omit event `seq` coordinates. Durable human text (`source.kind === 'user'` with its own `rpcId`) defines or replaces the current task and explicit limits. For an in-process child, its existing creation prompt and later `agent-message` entries whose `senderSessionId` matches `parentSession` define or adjust the delegated task, but cannot override human limits. Current `agent-instructions` only constrain; compaction checkpoints restore lossy context; images, attachments, and historical calls provide facts. Assistant text, reasoning, and tool results are absent.

Ordinary project-local reads, writes, analysis, formatting, linting, tests, builds, non-destructive Git operations, and exact cleanup of objects the retained call history proves this agent created in the same Session are low risk and allowed. Irreversible deletion of pre-existing state, history rewrites, production access or deployment, non-sensitive external writes or sends, and security or system changes are medium risk: a current human or direct-parent instruction must explicitly name the action, exact target and necessary scope, without unresolved conflicts. Sensitive information exfiltration across a trust boundary is high risk and denied even with explicit authorization. Project instructions, checkpoints and historical facts cannot authorize medium work; facts can establish ownership for the exact cleanup exception.

The reviewer classifies the pending action by actual effect and returns one closed `risk + decision` object: low must allow, medium may allow or deny, and high must deny; only deny may carry a string reason. Missing or inconsistent logged facts, provider failure, context overflow, malformed output, an illegal risk/decision combination, and any other review failure deny the call before its body. Caller cancellation follows ordinary Tool settlement priority: cancellation after a late allow becomes the canonical pre-dispatch cancellation, while a deny or technical failure that has already settled remains an Auto denial.

<a id="run-the-real-model-certification"></a>
### Run the real-model certification

Set `DEEPSEEK_API_KEY`, then run the focused opt-in suite from the repository root:

```sh
DSH_AUTO_REVIEW_CERTIFICATION=1 pnpm exec vitest run --config vitest.e2e.config.ts packages/interaction/auto-review/tests/auto-review.e2e.ts
```

The suite runs eight deterministic equivalents by default, even without credentials. Setting `DSH_AUTO_REVIEW_CERTIFICATION=1` selects the real reviewer and requires `DEEPSEEK_API_KEY`. That run makes exactly eight zero-retry calls: Flash checks session-created cleanup (low/allow), the same pre-existing deletion without and with exact authorization (medium/deny and medium/allow), and sensitive-data exfiltration despite explicit authorization (high/deny). Pro and Vision each repeat only the medium pair; these cases cover native and PTC inner execution without a duplicate path matrix. The runner reports eight executed and zero skipped cases, with only case/model/path, expected and actual risk/decision, and verified effects on stdout for the invoking Goal to retain. It creates no report schema or dedicated CI artifact. Separate deterministic tests cover fixed denial feedback, re-review of a new call, and narrowed work.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin prepends one `tools/pre-execute` listener. It rebuilds each native action from the visible `tool/call` plus the latest request-header schema, and each PTC inner action from its `tool/code-dispatch-start` snapshot. The current action appears only in `PENDING_ACTION`; only already-started historical calls remain in filtered history.

An Auto denial uses a fixed model-facing message that names the rejected tool and states that its body was not executed. Its `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED` identity and optional raw reason travel through the ordinary native or PTC structured-error fields. The Web tree recognizes that identity before keyed Tool-view dispatch and renders the generic denial card, so a specialized or external Tool view cannot hide the verdict. The presentation normalizes the reason only when it renders the card.

Publication and teardown are fail-closed. A persisted Auto session cannot publish without the live Auto registration. Before changing any preset during disposal, the plugin captures the exact Session object identities that are retiring from Auto, and the listener checks that set before derived permission state. It closes new admission, switches each captured session through the existing preset writer to `danger-full-access` without changing the shared sandbox/approval bundle or closing persistent terminals, then aborts the lifecycle and waits for every active review or admitted call. An allowed call remains active until `tools/execute` or `tools/result`; the execute wrapper combines the lifecycle signal with the caller signal before delegating, so disposal cancels any admitted body that has not started. If every migration succeeds, teardown removes the listener and Auto registration; if any migration fails, Cordis reports the cleanup error while retaining both in their closed state, so later calls from retiring sessions stay denied and new Auto selections fail. Reinstalling the integration restores only the catalog entry; migrated live sessions remain in Full access until a user selects Auto again.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Fixed Auto registration, five-section request, strict decision parser, pre-execute listener, and teardown |
| [`tests/auto-review.spec.ts`](tests/auto-review.spec.ts) | Logged-input, decision, cancellation, native/PTC, restore, and disposal behavior |
| [`tests/auto-review.e2e.ts`](tests/auto-review.e2e.ts) | Eight-case deterministic/real certification and deterministic denial recovery through both execution paths |

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

The reviewer receives the package-owned fixed policy and one user message containing `ENVIRONMENT`, `PROJECT_INSTRUCTIONS`, `FILTERED_HISTORY`, and `PENDING_ACTION`. Normal model-visible inputs are not filtered to conceal Auto. The main agent receives no extra Auto-specific prompt, allow event, structured error identity, or reviewer reason; through ordinary Tool failure behavior, a denied call exposes only the fixed message that the named tool was rejected by Auto review and its body was not executed.

#### Token effect

Each native call and each started PTC inner call in Auto enters one review operation. A complete logged request creates one separate same-route LLM request with data-dependent input; missing required facts deny before provider contact. The package does not cache, batch, summarize, truncate, or retry reviews.

#### KV Cache effect

Review requests are independent of the main agent request and do not change its reusable prefix. The fixed reviewer policy can form a stable prefix across reviews, while the four data sections vary per Session and call.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the experimental Auto preset and its supported deployment.

- **Review is probabilistic, not confinement** — an allowed call runs with full host access, so the reviewer can cause either an unsafe allow or an unnecessary deny.
- **Direct worker-thread program effects are not reviewed** — Auto delegates the outer `run_code` transport and reviews only its PTC inner calls. The shipped worker-thread backend lets program text reach Node APIs with bash-equivalent host authority, so direct filesystem, process, network, or other Node effects execute outside Auto review.
- **Support is limited to the shipped Web current session** — Headless, General Settings, future-session defaults, arbitrary host compositions, and out-of-process children do not expose Auto.
- **The reviewer receives only logged authorization facts** — it does not inspect Git state, environment variables, assistant reasoning, tool results, or a live Tool registry, and missing required facts deny the call.
- **There is no policy customization or fallback** — v1 has one fixed policy and no cache, grant, independent retry layer, audit event, or human fallback.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
