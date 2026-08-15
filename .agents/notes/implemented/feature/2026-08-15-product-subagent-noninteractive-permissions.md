# Agent Note: Claude Code subagents use Profile-selected non-interactive permissions

Status: implemented

English | [中文](2026-08-15-product-subagent-noninteractive-permissions.zh.md)

## Problem

The [Claude Code product provider](2026-08-04-claude-code-and-codex-subagent-backends.md) runs without a human interface. Native permission prompts, user dialogs, or MCP elicitation therefore cannot wait for a person, but relying on the product's ambient default can still select an interactive mode. A deployment also needs to choose broader native modes without giving the parent model or one tool call a way to raise its own authority.

A failed product run previously reached the [subagent seam](2026-06-21-subagent-capability-seam.md) only as a stop reason. Logs could retain the product error, but the foreground parent and a [one-shot background Job](2026-08-12-product-subagent-one-shot-background-tasks.md) could not distinguish a permission refusal from another failure. Reusing assistant output for that fact would misattribute infrastructure detail to the child model.

## Decision

The Claude Code Provider owns one Profile-level `permissionMode` value. It defaults to `dontAsk` and accepts only the native non-interactive modes supported by the pinned Agent SDK:

| Value | Native behavior |
| --- | --- |
| `dontAsk` | Deny operations that are not already authorized instead of prompting. |
| `acceptEdits` | Accept edits; deny any remaining permission prompt through the unattended callback. |
| `auto` | Let Claude Code's native classifier allow or deny permission requests. |
| `plan` | Use planning mode, deny execution approval, and return the completed plan as the final answer. |
| `bypassPermissions` | Set the SDK's explicit dangerous confirmation and bypass permission checks. |

The Provider fixes the resolved value for every run from that plugin instance. The subagent tool schema and `SubagentStartRequest` contain no permission field, so a model or individual delegation cannot change it. The Provider continues to omit `settingSources`: Claude Code remains the owner of user, project, and local settings, authentication, tools, and sandbox behavior outside the selected mode.

Every query disables `AskUserQuestion`. Non-bypass permission callbacks deny instead of returning the SDK's indefinitely blocking `null`; in plan mode, `ExitPlanMode` receives a fixed denial that tells the model to return the completed plan without executing it. MCP elicitation is declined; the supported refusal dialog is cancelled; undeclared dialog kinds use the SDK's no-dialog failure behavior. A native `permission_denied` message records the same operation-local fact. These paths do not create an approval session, queue, cache, or retry loop.

### Failure diagnostic

`SubagentResult` carries an optional `diagnostic` for provider-authored, non-assistant failure detail. A Provider removes tool inputs, file contents, environment values, credentials, and raw protocol payloads before producing it. The shared out-of-process result boundary limits the complete text to 4096 UTF-8 bytes and marks truncation without splitting a character.

Claude Code records only the effective mode, request category, unattended decision, and a fixed safe reason. A successful result returns only the strict final answer; local cancellation remains `aborted` without permission detail; an unpublished startup failure still rejects `start()`. When a permission fact contributes to a published run that settles as `error`, the Provider attaches the diagnostic without adding it to assistant output, structured output, or `subagent/end.lastAssistantMessage`.

The foreground consumer presents the stop-reason headline, then the optional diagnostic, then any partial assistant output. The one-shot background adapter stores the same diagnostic beside the stop reason in the failed Job detail. Providers that omit the field retain their previous behavior.

### Ownership and lifecycle

| Fact or resource | Owner | Observable behavior |
| --- | --- | --- |
| Profile permission choice | Claude Code Provider Config | Invalid, interactive, or unknown values fail during configuration. |
| Permission and sandbox semantics | Claude Code and its Agent SDK | The Provider passes one native mode and does not mirror product policy. |
| Interaction decisions and safe diagnostic | One Claude Code run | Concurrent runs keep independent mode, callback, and diagnostic state. |
| Diagnostic type and byte limit | `dsh-subagent` | Consumers receive a bounded optional field separate from assistant output. |
| Foreground and Job presentation | `dsh-tool-subagent` and the generic Job runtime | Scheduling choice does not change the underlying failure fact. |
| Process cancellation and quiescence | Product Provider and `dsh-subprocess` | Result settlement still precedes idempotent whole-tree disposal. |

## Verification

Package tests pin every allowed and rejected Config value, the exact SDK option mapping, bypass confirmation, callback terminal responses, diagnostic sanitization and UTF-8 bound, successful-result omission, concurrent-run isolation, foreground ordering, Job detail, and disposal behavior. The real Agent SDK/CLI fixture proves that the default overrides an interactive native setting, denies an out-of-workspace write with safe diagnostic detail, executes an explicit bypass write only inside suite-owned temporary storage, and leaves the full process tree quiescent. Loader composition proves a non-default mode can be published without starting either product, and the keyless ACP snapshot records the same diagnostic in a foreground tool error and one-shot `job_output` while the model-facing product tool schema contains no permission parameter.

## Alternatives considered

**Use the product's ambient permission default.** A native setting may select an interactive mode and make unattended behavior deployment-dependent. The Provider must choose a non-interactive mode explicitly for every query.

**Put permission mode in the model-facing tool or each start request.** That would let task content select authority and would duplicate a Profile deployment decision on every call.

**Copy Claude settings or map the parent Harness sandbox.** The products do not share one permission vocabulary. Mirroring their state would create a second authority and obscure the native sandbox consequences of `auto` and bypass modes.

**Forward prompts to a parent, Web client, or CLI.** The one-shot product run has no owned human-interaction lifecycle. Adding one would require durable request identity, routing, cancellation, and timeout semantics beyond this decision.

**Return raw product errors, stderr, or tool inputs.** Those values can contain commands, paths, workspace data, environment values, or credentials. A fixed safe diagnostic keeps the failure actionable without exposing the product transcript.

**Store a separate Job diagnostic.** The Job is only a scheduling adapter for the same `SubagentRun`; a second field would let foreground and background failure meanings drift.

## Consequences

Profiles can select Claude Code's native restricted, automatic, planning, edit-accepting, or bypass behavior before the Provider starts, while the safe default never asks a person. Broader modes remain explicit deployment choices and retain their native sandbox consequences.

Permission failures become visible to both foreground parents and one-shot background Jobs without turning infrastructure text into an assistant answer. That diagnostic can enter model context, Job notices, API projections, and Job UI through the ordinary consumer paths, so the Provider must sanitize and bound it before result settlement.

The change adds no product session persistence, human approval channel, dynamic permission operation, progress stream, retry policy, or rollback. Codex and other Providers remain valid without producing a diagnostic or exposing a permission-mode Config.
