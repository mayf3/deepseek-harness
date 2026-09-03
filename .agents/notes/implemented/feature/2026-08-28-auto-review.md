# Agent Note: Per-call Auto review in the shipped Web application

Status: implemented

English | [中文](2026-08-28-auto-review.zh.md)

## Problem

The permission preset layer names sandbox and approval-policy combinations, but neither mechanism can decide whether one concrete tool call stays inside the user's semantic authorization. Full access avoids approval interruptions but executes every admitted tool with ambient host authority. A useful automatic mode therefore needs a call-time decision without pretending that an LLM judgment is filesystem confinement, without leaking reviewer analysis back to the main agent, and without letting a persisted mode degrade to unreviewed Full access when its integration is absent.

## Decision

The shipped Web application offers `Auto review` as the fourth complete current-session permission mode. Its durable identity is `permission/preset:auto`, and its execution knobs are exactly `danger-full-access` plus approval policy `never`. [`@deepseek-ai/dsh-auto-review`](../../../../packages/interaction/auto-review/README.md) owns the additional authorization behavior; [`dsh-permission-presets`](../../../../packages/interaction/permission-presets/README.md) owns the fixed Auto identity, bundle, `registerAuto(admit)` hook, canonical preset write path, and fail-closed admission on selection or restore. The shipped Web client locale dictionaries own the fixed Auto label and description. The permission service does not expose a generic preset-contribution API.

Auto is experimental because an LLM decision is probabilistic. An allowed call starts immediately with full host access and no later human confirmation. A reviewer can therefore allow an action that should have been denied or deny a valid action, and each review adds provider latency and token use.

## Supported product surface

The composer current-session picker and the `/permission` slash picker show `Auto review` with an `EXP` badge. Selecting Auto through either visible picker requires a one-time confirmation for that selection; an explicitly submitted `/permission auto` command already expresses consent and does not add another protocol step. General Settings never offers Auto as a future-session default.

The shipped Web composition is the only supported host. Headless keeps its existing Workspace Write default and approval behavior. DSH in-process children snapshot and append an Auto parent's preset identity before their first await, so the same integration reviews their calls. Their existing creation prompt and authenticated direct-parent `agent-message` entries provide medium-risk task context; no parent call id, parsed task metadata, review receipt, delegation provenance, or Session-format change is added. ACP, DSH SDK, Codex, and Claude Code children keep their own permission systems after the parent delegation tool call passes review.

## Review request and decision

The Auto plugin prepends one `tools/pre-execute` listener and attempts at most one direct reviewer request for each native call and each started PTC inner call. It denies before contacting the provider when required logged facts cannot form a complete request. It delegates the outer `run_code` transport and reviews only the inner dispatches. In the shipped worker-thread backend, program text itself can reach Node APIs with bash-equivalent host authority, so direct filesystem, process, network, or other Node effects that do not use a tool binding execute unreviewed; this is a documented coverage limit, not a confinement claim. Repeated calls are independent reviews; there is no cache, grant, batch decision, or retry layer.

The reviewer uses the provider and model from the latest logged `request/header`. Its immutable request has five sections: fixed `REVIEW_POLICY`; `ENVIRONMENT` containing only the Session `cwd`; current `PROJECT_INSTRUCTIONS`; `FILTERED_HISTORY`; and the exact `PENDING_ACTION`. The generated LLM request does not carry the main Session's `sessionId`, and project-instruction and history entries omit event `seq` coordinates. Native actions use the matching logged `tool/call` plus the latest logged tool schema. PTC actions use the matching `tool/code-dispatch-start`, which snapshots the inner tool name, description, parameters schema, and normalized arguments before policy. Missing, ambiguous, or inconsistent facts deny the call instead of consulting the live registry.

Every retained item has one fixed source role. Durable human text (`source.kind === 'user'` with its own `rpcId`) defines or replaces the current task and explicit limits. For an in-process child, the existing creation prompt and later `agent-message` entries whose `senderSessionId` matches `SessionHeader.parentSession` define or adjust the delegated task, but cannot override human limits. Current `agent-instructions` only constrain; compaction checkpoints restore lossy context without inheriting the authority of compacted text; images, attachments, and historical native or PTC calls provide facts. The request excludes assistant text, reasoning, tool results, Git state, environment variables, platform metadata, and shell dialect.

The reviewer first classifies the pending action by actual effect: local non-sensitive observation is low, bounded ordinarily recoverable local side effects are medium, and destructive, external, sensitive, security, system, or outside-workspace effects are high. Low must allow, medium may allow only when the current human/direct-parent task requires it and no applicable conflict remains, and high must deny even after an exact human request. The only accepted final JSON shapes combine `risk` and `decision` accordingly, with an optional string `reason` only on deny. If the filtered request exceeds the model context, the provider fails, or the response violates that closed protocol, the call is denied.

## Result and lifecycle

An Auto denial gives the main agent a fixed message that names the rejected tool and states that its body was not executed. The Tool result separately carries `AutoReviewDeniedError`, `AUTO_REVIEW_DENIED`, and the reviewer's optional raw string reason. Native `tool/result` and PTC `tool/code-dispatch` events preserve the same structured `error` fields for replay and both SDKs. The Web tool tree recognizes that identity before keyed Tool-view dispatch and renders the generic denial card, so built-in, skill, and external Cordis-like views cannot hide it; the collapsed state names Auto review, while the expanded OUT line trims the reason, collapses line breaks, and uses localized fallback text when no displayable reason exists. The main agent and a PTC program receive the fixed Auto-denial text through ordinary Tool failure behavior, but never receive the reviewer reason or structured Auto error identity.

Caller cancellation follows ordinary Tool settlement priority: a cancellation observed after a late allow becomes the canonical pre-dispatch cancellation, while a deny or technical failure that has already settled remains an Auto denial. A denied PTC inner call keeps the existing `ToolCallError` and program `catch` behavior, so a handled denial does not become an outer `run_code` failure. Allow produces no event, reason, or durable grant.

Publication and teardown are fail-closed. Before it publishes either registration, the integration requires the configured `read-only` preset to resolve exactly to sandbox `read-only` plus approval policy `ask`. A stored Auto session cannot publish unless the Auto registration is live and admits that Session; the service does not rewrite it to Full access. During disposal, the integration first closes new Auto selection and review admission and captures the exact Session object identities retiring from Auto before it changes any preset. The listener checks this retiring set before derived permission state, so a partial migration that already appended `permission/preset` or `sandbox/mode` cannot reopen execution. The integration switches those sessions to Read Only through the normal preset writer, aborts and awaits in-flight reviews, and only then removes the listener and Auto registration. If any Session cannot migrate, the integration still aborts and drains reviews but retains both closed registrations, so new Auto selections fail and calls from retiring sessions are denied instead of entering an unreviewed execution window.

## Verification

Unit and integration tests pin the five request sections, absence of reviewer Session identity and history coordinates, human/direct-parent/constraint/checkpoint/fact roles and precedence, native and PTC action reconstruction, one-review cardinality, body-before-review exclusion, strict `risk + decision` parsing, technical-failure denial, caller cancellation, restore failure, partial-migration teardown ordering, and the parent delegation boundary for out-of-process children. Tool and client suites pin structured error propagation and generic-denial precedence over built-in, skill, and Cordis-like keyed views. TypeScript and Python SDK fixtures pin `name`, `code`, and `reason` on native and PTC projected events. The opt-in real DeepSeek certification performs exactly 22 zero-retry reviewer calls: Flash runs P01 low allow/allow, P02–P04 medium deny/allow, and P05–P08 high deny/deny; P02 runs through the other execution path as well, while Pro and Vision each run that safe medium pair. Each case asserts risk and decision in process and proves the expected result, mutation, or absence of side effects. The redacted artifact omits risk, prompts, reasoning, tool arguments, raw output, credentials, tokens, and timing; the test validates its case/model/path, expected/actual decision, and side-effect fields against the committed JSON Schema before writing it.

## Alternatives considered

**Add `auto` to `ApprovalPolicy`.** Rejected because Auto is a complete product mode with Full access execution plus an independent semantic reviewer, not a third response strategy for the human approval service. Extending that enum would create unsupported sandbox × approval combinations and change model-visible Full access behavior.

**Use deterministic tool classes or path rules.** Rejected because authorization depends on the user's task, the exact arguments, and effects such as deletion, external sending, production mutation, or security-control changes. A static allowlist cannot represent that semantic scope, and Auto deliberately has no read-only fast path.

**Review the full transcript or live process state.** Rejected because assistant reasoning, tool results, Git state, environment values, and the mutable registry can supply irrelevant or spoofable authority and make replay disagree with execution. The logged five-section request gives each accepted fact one provenance and fails closed when reconstruction is impossible.

**Review only the outer `run_code` call.** Rejected because program text does not identify the exact inner tools, schemas, arguments, or which scheduled calls actually start. Reviewing each inner dispatch preserves ordinary PTC catch and settlement semantics for tool-bound effects; it does not review direct Node effects performed by worker-thread program text.

**Add cached grants, retries, policy configuration, audit events, or a human fallback.** Rejected for the first version because each mechanism creates durable authority, recovery, or precedence rules beyond one binary call-time decision. A repeated action is reviewed again, and provider or protocol failure denies it.

**Expose Auto in every host and default selector.** Rejected because only shipped Web composes the complete integration and user-facing denial reader. A broader surface would let another host persist the identity without the lifecycle and presentation required to operate it safely.

## Consequences

Users gain a current-session option that can approve ordinary work without a sandbox or repeated human prompts while still checking each actual call against logged authorization. The main agent's prompt, tool schemas, and Full access narration remain unchanged; a denial adds only the fixed Auto message, and native and PTC paths share one structured denial identity. The cost is one additional model request per actual call, probabilistic false allows and false denies, no protection after an incorrect allow, and a deliberately narrow shipped-Web-only support boundary. The strict logged-input rule also denies calls when required history or schema facts are unavailable, even if live process state could have guessed the action.

## Related

- [Interception extension points](2026-06-30-interception-extension-points.md) — the ordered Tool policy pipeline Auto uses.
- [Approval seam](2026-07-06-approval-seam.md) — the separate one-shot human decision path Auto does not extend.
- [Sandbox](2026-07-06-sandbox.md) — the confinement modes whose Full access knobs Auto reuses.
- [PTC mode](2026-06-15-ptc.md) — the program transport and inner-dispatch semantics Auto preserves.
