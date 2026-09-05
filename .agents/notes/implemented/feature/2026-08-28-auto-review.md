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

The shipped Web composition is the only supported host. Headless keeps its existing Workspace Write default and approval behavior. DSH in-process children snapshot an Auto or Full access parent's preset identity before their first await and append it after any fork seed, so a stale same-bundle identity cannot win; the shared integration reviews calls only when the captured identity is Auto. Their existing creation prompt and authenticated direct-parent `agent-message` entries provide medium-risk task context; no parent call id, parsed task metadata, review receipt, delegation provenance, or Session-format change is added. ACP, DSH SDK, Codex, and Claude Code children keep their own permission systems after the parent delegation tool call passes review.

## Review request and decision

The Auto plugin prepends one `tools/pre-execute` listener and attempts at most one direct reviewer request for each native call and each started PTC inner call. It denies before contacting the provider when required logged facts cannot form a complete request. It delegates the outer `run_code` transport and reviews only the inner dispatches. In the shipped worker-thread backend, program text itself can reach Node APIs with bash-equivalent host authority, so direct filesystem, process, network, or other Node effects that do not use a tool binding execute unreviewed; this is a documented coverage limit, not a confinement claim. Repeated calls are independent reviews; there is no cache, grant, batch decision, or retry layer.

The reviewer uses the provider and model from the latest logged `request/header`. Its immutable request has five sections: fixed `REVIEW_POLICY`; `ENVIRONMENT` containing only the Session `cwd`; current `PROJECT_INSTRUCTIONS`; `FILTERED_HISTORY`; and the exact `PENDING_ACTION`. The generated LLM request does not carry the main Session's `sessionId`, and project-instruction and history entries omit event `seq` coordinates. Native actions use the matching logged `tool/call` plus the latest logged tool schema. PTC actions use the matching `tool/code-dispatch-start`, which snapshots the inner tool name, description, parameters schema, and normalized arguments before policy. Missing, ambiguous, or inconsistent facts deny the call instead of consulting the live registry.

Every retained item has one fixed source role. Durable human text (`source.kind === 'user'` with its own `rpcId`) defines or replaces the current task and explicit limits. For an in-process child, the existing creation prompt and later `agent-message` entries whose `senderSessionId` matches `SessionHeader.parentSession` define or adjust the delegated task, but cannot override human limits. Current `agent-instructions` only constrain; compaction checkpoints restore lossy context without inheriting the authority of compacted text; images, attachments, and historical native or PTC calls provide facts. The request excludes assistant text, reasoning, tool results, Git state, environment variables, platform metadata, and shell dialect.

The fixed policy follows allow/soft-deny/hard-deny semantics. Ordinary project-local work and exact cleanup of objects created by the agent in the same Session are low and allowed. Irreversible deletion of pre-existing state, history rewrites, production access, non-sensitive external writes and security/system changes are medium and need explicit human or direct-parent authorization of the action, exact target and necessary scope. Historical calls can prove session-created ownership, but cannot authorize medium work. Sensitive information exfiltration across a trust boundary is high and always denied. Unresolved conflicts and ambiguous or broader effects fail closed. The only accepted final JSON shapes combine `risk` and `decision` accordingly, with an optional string `reason` only on deny; provider, context or protocol failures deny the call.

## Result and lifecycle

An Auto denial gives the main agent a fixed message that names the rejected tool and states that its body was not executed. The Tool result separately carries `AutoReviewDeniedError`, `AUTO_REVIEW_DENIED`, and the reviewer's optional raw string reason. Native `tool/result` and PTC `tool/code-dispatch` events preserve the same structured `error` fields for replay and both SDKs. The Web tool tree recognizes that identity before keyed Tool-view dispatch and renders the generic denial card, so built-in, skill, and external Cordis-like views cannot hide it; the collapsed state names Auto review, while the expanded OUT line trims the reason, collapses line breaks, and uses localized fallback text when no displayable reason exists. The main agent and a PTC program receive the fixed Auto-denial text through ordinary Tool failure behavior, but never receive the reviewer reason or structured Auto error identity.

Caller cancellation follows ordinary Tool settlement priority: a cancellation observed after a late allow becomes the canonical pre-dispatch cancellation, while a deny or technical failure that has already settled remains an Auto denial. A denied PTC inner call keeps the existing `ToolCallError` and program `catch` behavior, so a handled denial does not become an outer `run_code` failure. Allow produces no event, reason, or durable grant.

Publication and teardown are fail-closed. A stored Auto session cannot publish unless the Auto registration is live and admits it; the service does not rewrite it to Full access. During disposal, the integration first closes new Auto selection and review admission, then switches live Auto sessions through the existing preset writer to `danger-full-access`. Auto and Full access share `danger-full-access` plus approval policy `never`, so the transition records only the new preset identity, leaves execution knobs and persistent terminals unchanged, and adds no terminal fence. Canonical permission state remains the authority: the single preset append commits atomically, and Session contains post-commit observer failures. The integration then aborts its lifecycle and waits for every active review or admitted call before removing the listener and Auto registration. An allowed call remains active until `tools/execute` or `tools/result`; the execute wrapper combines the lifecycle signal with the caller signal before delegating, so disposal cancels any admitted body that has not started. Cancellation and draining also run if a preset write fails; closed registrations continue to reject new Auto selections and calls from sessions still in Auto. Reinstalling the integration restores only the Auto catalog entry; migrated live sessions remain in Full access until a user explicitly selects Auto again.

## Verification

Focused unit and integration tests cover logged facts, source authority, strict output, native/PTC dispatch, cancellation and integration teardown. Shipped Web tests exercise fresh and cold-resumed children, permission catalog lifecycle and both denial states; SDK tests preserve structured errors. The [package certification](../../../../packages/interaction/auto-review/README.md#run-the-real-model-certification) limits real-provider evidence to eight zero-retry calls for cleanup, exact deletion authorization and hard denial across the three shipped models. Deterministic tests own denial recovery and the wider lifecycle cases, keeping provider calls and retained evidence small.

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
