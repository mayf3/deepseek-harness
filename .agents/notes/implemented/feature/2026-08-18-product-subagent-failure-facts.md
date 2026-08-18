# Agent Note: Product subagents expose bounded structured failure facts

Status: implemented

English | [中文](2026-08-18-product-subagent-failure-facts.zh.md)

## Problem

The [Claude Code and Codex product providers](2026-08-04-claude-code-and-codex-subagent-backends.md) receive structured product failures, but a published run historically flattened most of them to the shared `error` stop reason. Product logs retained detail that the foreground parent and a [one-shot background Job](2026-08-12-product-subagent-one-shot-background-tasks.md) could not use to distinguish a product limit, an execution failure, or an early process exit.

Copying SDK error text, app-server payloads, or stderr into the result would expose task text, paths, environment values, credentials, or product internals. Adding shared error fields would also make the provider-neutral [subagent seam](2026-06-21-subagent-capability-seam.md) own product version vocabularies that change independently.

## Decision

Each product Provider owns the mapping from its pinned official error union, current operation, and managed process outcome to one fixed safe diagnostic line. `SubagentResult` remains unchanged: consumers receive the existing bounded `diagnostic` string and do not parse its product-private fields.

### Safe diagnostic

The structured line has this fixed order:

```text
Product subagent failure (product: <product>; stage: <stage>; category: <category>; exit code: <code>; signal: <signal>)
```

The Provider omits unavailable exit fields. Exit code and signal are independent facts and are each retained when observed. A contributing permission decision from the [non-interactive permissions decision](2026-08-15-product-subagent-noninteractive-permissions.md) follows the structured line; the latest safe permission fact remains operation-local. The shared result boundary limits the complete text to 4096 UTF-8 bytes.

Successful results and local cancellation expose no failure fact. Raw product errors, stderr, tool input, paths, environment values, credentials, and protocol payloads never enter the diagnostic. Startup and cleanup rejections use the same safe line in their Error message while retaining the original failure only on the internal cause chain and in Host logging.

### Claude Code facts

Agent SDK 0.3.220 defines four error subtypes: `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, and `error_max_structured_output_retries`. The Claude Code Provider preserves each exact subtype as the category while keeping the shared stop reason `error`. An error-marked or blank success uses `invalid-success`, a missing result uses `missing-result`, a process exit before an SDK terminal result uses `process-exit`, and an unrecognized value or exception uses `unknown` without copying the value.

| Stage | Owned operation | Observable failure |
| --- | --- | --- |
| `query-start` | SDK query construction, native platform-payload startup, and unpublished rollback | `start()` rejects with fixed safe facts and any process outcome observed before rollback |
| `query-run` | Published SDK message iteration and strict terminal-result validation | The run resolves as `error` with the exact known subtype or a fixed result category |
| `process` | Managed CLI exits before the SDK supplies a terminal result | The run resolves as `error` with `process-exit` and the available exit code and signal |
| `teardown` | Query close and managed process-tree release | `dispose()` rejects independently with fixed safe facts after cleanup still reaches its final exit wait |

The Codex Provider retains its existing result mapping: `contextWindowExceeded` is `max-tokens`, other turn failures remain `error`, and permission-related paths may carry their existing safe diagnostic. Other Codex error-info members are not represented as shared categories by this decision's current implementation.

### Ownership and lifecycle

| Fact or resource | Owner | Consumer behavior |
| --- | --- | --- |
| Product error category | Pinned official SDK or app-server version | The Provider maps only the declared structured union and uses `unknown` outside it |
| Current failure stage | Product Provider operation | Derived at the failure site; never persisted or used as a recovery state |
| Exit code and signal | `dsh-subprocess` process handle | The Provider displays observed values without inferring missing ones |
| Diagnostic bytes and delivery | `dsh-subagent`, foreground tool, and Job runtime | The same bounded text is presented separately from assistant output in both scheduling modes |
| Raw product failure | Product runtime and Host log | It remains internal and never becomes model-visible result text |

## Verification

Claude Code package tests pin all four SDK subtypes, invalid success, missing result, unknown values and exceptions, all four stages, independent exit code and signal fields, permission-fact ordering, sanitization, successful-result and cancellation omission, concurrent-run isolation, and cleanup completion. The real SDK/CLI fixture produces an actual `error_max_turns` result and an actual early process exit while proving whole-tree quiescence. The keyless ACP snapshot records the same failure diagnostic in foreground error output, the background completion notice, and `job_output`.

## Alternatives considered

**Return raw SDK errors, app-server payloads, or stderr.** These values can contain commands, paths, workspace content, environment values, credentials, or upstream prose. A fixed allowlisted mapping preserves actionable facts without expanding the model-visible trust boundary.

**Add a shared product-error enum or structured result fields.** Claude Code and Codex version their error unions independently. A shared enum would duplicate those authorities and force unrelated Providers and consumers to track product releases.

**Parse generic stderr and exception messages.** Free-form text is neither stable nor safe. Only pinned structured product fields and the managed process outcome qualify as diagnostic input.

**Persist stages or add a recovery controller.** The stage is derived from the current call site only when a failure is reported. Persistence, retries, resume, and remediation need separate ownership and user contracts.

**Map product limits to new shared stop reasons.** Claude Code turn and budget limits are not token-window exhaustion, and an error category does not establish refusal semantics. Existing stop reasons remain unchanged.

## Consequences

The parent can distinguish important Claude Code product limits, invalid terminal results, unknown query failures, and early process exits without receiving raw product text. Foreground and background scheduling preserve the same fact because both consume one `SubagentResult`.

The diagnostic is display text rather than a new public protocol. Callers may present it but must not branch on its punctuation or product-private category names. A pinned product-version upgrade must update the Provider mapping and evidence when its official error union changes.

This decision adds no product session persistence, retry policy, recovery state, stderr classifier, authentication or configuration taxonomy, progress stream, or human interaction path.
