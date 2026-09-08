# Agent Note: CI assertions wait for owned completion

Status: implemented

English | [中文](2026-09-08-ci-readiness-and-completion.zh.md)

## Problem

The [empty master PR run](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34206953049) fails while waiting one second for webhook Session creation and five seconds for PowerShell output. Neither test measures a startup latency guarantee. A [separate run](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34207864157) shows the same short-budget problem in a desktop worker readiness test and captures a feedback acknowledgement while the composer still holds the submitted command.

## Decision

The [webhook browser test](../../../../apps/web/tests/github-ready-review.e2e.ts) observes the model request caused by delivery before checking Session registration. The [feedback test](../../../../apps/web/tests/feedback-command.e2e.ts) waits for the empty composer and enabled attachment control before comparing ARIA output. Matching consecutive snapshots cannot prove that the command RPC has settled: its event stream can publish the acknowledgement first.

The [desktop transaction test](../../../../apps/desktop/tests/project-manager.spec.ts) gives the worker readiness marker the active test's execution budget. Its independent `afterEach` releases and awaits workers before deleting private roots, including when the runner abandons a timed-out test body. The poll observes runner cancellation, and teardown reports transaction failures independently from assertion failures. The [PowerShell tests](../../../../packages/shell/pwsh-local/tests/executor.spec.ts) register each helper-created Context before plugin initialization and dispose those Contexts before deleting temporary directories. The background-input case awaits process completion before checking complete output, completed status, and exit code. Consuming reads remain covered by their separate streaming tests.

The [subagent teardown decision](2026-09-07-subagent-teardown-test-budgets.md) owns lifecycle cleanup budgets. The [persistent PowerShell decision](2026-09-07-pwsh-ci-observable-completion.md) owns exact versus inferred terminal readiness; a one-shot process's completion promise has different semantics.

## Alternatives considered

**Larger independent waits.** Rejected where a completion promise already exists. A separate polling deadline continues to compete with the execution lane's budget.

**Refresh the feedback golden.** Rejected: the populated composer and disabled attachment control describe an in-flight submission. The settled expected UI remains the intended behavior.

**Serialize CI or retry these tests.** Rejected: neither establishes the missing completion condition or releases a blocked child after assertion failure.

## Consequences

Readiness and output assertions preserve their original content and ownership checks. Controlled desktop readiness, webhook preflight, command-response, and PowerShell output delays reproduce the original failures and pass with the completion waits. A stalled desktop-worker control still reports a test timeout while proving that teardown drains the child before removing its directory. The execution lane bounds test bodies and cleanup hooks separately; native Windows execution remains necessary to verify PowerShell and process cleanup there.
