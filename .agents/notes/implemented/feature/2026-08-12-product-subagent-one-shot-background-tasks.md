# Agent Note: Product one-shot subagents use generic background Tasks

Status: implemented

English | [中文](2026-08-12-product-subagent-one-shot-background-tasks.zh.md)

## Problem

The Codex and Claude Code providers already run one self-contained task and return one final answer, while `dsh-tool-subagent` already adapts any one-shot provider to the generic background Task runtime. The shipped product-tool rows disabled that route, so an agent could only wait for the product answer even when the delegation was independent of its next action.

Exposing background execution must not add a product session, product-specific task state, another cancellation owner, or another result protocol. The same provider run must remain responsible for one native process or query and one final answer, while the existing Task registry remains responsible for ids, collection, cancellation, owner cleanup, and completion notices.

## Decision

The `standard`, `code`, and `cordis` Agent Presets configure the dormant `subagent_codex` and `subagent_claude_code` rows with `backgroundMode: one-shot`. Removing a row's `disabled` field exposes the existing optional `run_in_background` argument. Omission or `false` waits in the foreground; explicit `true` returns a parent-owned Task id after synchronous Task preflight and registration, without waiting for provider startup or completion.

The [generic one-shot background adapter](2026-07-08-background-subagent-tasks.md) owns background registration and settlement. It starts the same [`SubagentRun`](2026-06-21-subagent-capability-seam.md), uses a Task-owned cancellation signal across provider startup and execution, waits for `run.result` and `run.dispose()`, maps the terminal result into the Task, and lets `task_output`, `task_list`, `task_kill`, and the existing completion notice expose that state. The [product provider decision](2026-08-04-claude-code-and-codex-subagent-backends.md) continues to own native protocols, answer selection, local cancellation, and process-tree quiescence.

No provider configuration, service interface, event, wire field, persistence format, or product identifier is added. Foreground and background differ only in which existing consumer waits for the same one-shot run.

### Ownership and lifecycle

```text
product tool call
  -> omitted / false: tool call waits -> final answer or error -> run disposal
  -> true: Task preflight + owner cleanup
           -> starter begins provider startup under Task-owned signal
           -> Task record/id published and returned (startup remains pending)
           -> provider result + run disposal -> Task settlement + notice
                                              -> task_output reads / task_kill cancels
  -> parent disposal: Task owner cleanup cancels -> run disposal -> process exit
```

| Fact or resource | Owner | Product-tool responsibility | Observable result |
| --- | --- | --- | --- |
| Product selection and exposure | Agent Preset | Bind one fixed tool name to one fixed provider | Enabling one row exposes only that product tool |
| Foreground or background choice | `dsh-tool-subagent` | Resolve `run_in_background` under `one-shot` policy | Omission is foreground; explicit `true` returns a Task id |
| Task id, state, output, cancellation, and notice | `ctx.tasks` and `dsh-tool-tasks` | Register and present the existing one-shot run | Generic task tools collect or stop the run for the exact parent |
| Native answer and process quiescence | Product provider and `dsh-subprocess` | Produce one final result and release one process tree | Task settlement and foreground return both wait for disposal |

## Published composition

Full profiles keep both product providers on the host and keep both product-tool rows disabled in each full preset. The host task registry is shared across sessions, while each preset contributes the generic task controls to its own agent scope. A user copies a preset and removes `disabled` from either or both product rows; no product process starts during composition.

A custom composition that enables one-shot background execution must provide the complete generic Task capability: `dsh-tasks-local` as the provider and `dsh-tool-tasks` as the model-facing consumer. A product tool without that runtime can still execute in the foreground, but an explicit background request fails the existing Task preflight instead of publishing an uncollectable id.

The ACP product compositions use the same fixed product rows and generic task controls. Their keyless schema snapshots expose `description`, `prompt`, and optional `run_in_background` for each enabled product tool without invoking Codex, Claude Code, or an external model.

## Verification

The shipped Web composition boots four user-preset variants—neither product, Codex, Claude Code, and both—and checks that each enabled product tool exposes `run_in_background` alongside `task_output`, `task_list`, and `task_kill`. The two package-owned Loader compositions run with an empty `PATH`, inspect the same schemas and controls, and prove that loading the providers starts no product process. ACP keyless snapshots pin the assembled product schemas, while the existing `dsh-tool-subagent` and task suites pin foreground defaulting, Task registration, final-output collection, cancellation, completion notices, owner disposal, and provider disposal.

## Alternatives considered

**Keep the product tools foreground-only.** This preserves the smallest schema but prevents agents from scheduling independent product work even though the generic one-shot Task adapter already owns the required lifecycle.

**Make product delegations background by default.** A one-shot Task requires later collection, unlike a continuable child with its own durable conversation id and settlement delivery. Foreground remains the compatible default, and background remains an explicit scheduling choice.

**Use Codex or Claude Code native session state as the background owner.** That would create provider-specific ids, status, cancellation, and recovery semantics beside the generic Task registry. The providers remain one-shot result producers and keep native ids private.

**Add product-specific output, wait, or kill tools.** Separate controls would duplicate the generic task protocol and teach a different collection workflow for each provider. The existing `task_*` tools already cover the required operations.

**Add continuable product sessions at the same time.** Resume, follow-up, progress, and persisted product sessions require new product contracts and lifecycle ownership. This decision exposes only the already implemented one-shot background route.

## Consequences

Agents can continue useful work while Codex or Claude Code handles an independent one-shot task, then collect the final answer or cancel it through the same Task controls used by other background producers. Foreground callers retain their existing result and error behavior.

Every product delegation still starts a fresh native process or query, produces final text as its only product payload, and ends with provider disposal and whole-tree exit. A background call additionally exposes the generic Task id, status, completion notice, and collection or cancellation results. Background Tasks are process-local and parent-owned: they do not survive parent disposal, do not expose intermediate product activity, and do not make a product conversation resumable. Custom compositions that expose the background argument must also keep the generic Task provider and controls available.
