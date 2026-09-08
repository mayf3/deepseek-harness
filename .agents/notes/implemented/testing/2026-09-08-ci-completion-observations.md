# Agent Note: CI tests observe completion instead of host speed

Status: implemented

English | [中文](2026-09-08-ci-completion-observations.zh.md)

## Problem

The [reference CI run](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34206953049) rejects two asynchronous operations before their enclosing test budgets expire: a webhook-created Session is absent after the test’s one-second poll, and a background PowerShell command has emitted no output before its five-second read deadline. Neither API promises those latency bounds. A successful HTTP 202 response acknowledges webhook dispatch, not Session creation or model admission.

## Decision

The [GitHub review browser test](../../../../apps/web/tests/github-ready-review.e2e.ts) awaits the deterministic adapter’s first request before asserting exact Agent and request counts. A deferred Workspace-creation barrier proves that HTTP acceptance can precede both observations; the barrier delegates to the real method and is released and restored in `finally`. The original Workspace membership, prompt content, reply, and collapsed/expanded browser expectations remain authoritative.

The [PowerShell executor tests](../../../../packages/shell/pwsh-local/tests/executor.spec.ts) await `done` before reading complete stdin/environment output. Startup and consuming-read checks hold the command at a private file barrier, so the running state and unread later output do not depend on a sleep or elapsed-time threshold. Partial-output polling inherits the lane budget. Every created Context is registered for teardown before use; subprocess disposal precedes private-directory removal. A six-second delayed command reproduces the five-second failure and passes after the completion wait on native Windows.

The enclosing test timeout remains the watchdog. Completion assertions do not acquire a second, shorter performance requirement merely because an operation crosses a process, filesystem, or event-loop boundary. This extends the [subagent teardown budget decision](2026-09-07-subagent-teardown-test-budgets.md) without replacing its disposal ownership or native-platform verification requirements. The [browser e2e decision](2026-07-24-web-gui-browser-e2e-lane.md) continues to own the assembled browser lane and recorded expectations.

The [Queue browser test](../../../../apps/web/tests/queue-actions.e2e.ts) observes the collapsed sidebar and completed frame animations after a narrow resize, then reads both card rectangles and the declared inset in one browser evaluation. Separate round trips can mix a pre-resize Queue coordinate with a post-resize composer coordinate even when their inset is correct in both frames. A controlled resize barrier reproduces that mismatch; the same control passes with the atomic observation.

The [publint runner tests](../../../../scripts/publint-all.spec.ts) await asynchronous child closure under the lane budget instead of imposing a five-second synchronous spawn deadline. They check spawn errors and termination signals independently of exit status. Teardown captures children and fixture roots before awaiting, terminates unfinished children, and joins closure before deleting roots. A delayed startup reproduces the former null-status failure; a forced outer timeout verifies that the child is gone while its root still exists.

The [Details Session-lifecycle test](../../../../apps/web/tests/details-session-lifecycle.e2e.ts) awaits the frame’s captured animation promises after closed state appears, then retains the zero-width assertion. Completed and cancelled transitions both reach that assertion; cancellation cannot make a persistent nonzero track pass. A paused real grid transition reproduces the close assertion failure and completes successfully only after release, while a persistent one-pixel track remains rejected.

### Built-client import classification

The [master Windows run](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34204779455/job/101996934534) also rejects the intentional CSS import exposed by `ui-dockkit`. The [Node import sweep](../../../../packages/experimental/webworker-runtime/tests/compile/transform-corpus-check.ts) admits that exact bundle only when Node reports `ERR_UNKNOWN_FILE_EXTENSION` for its `dockkit.module.css`. Other errors at the same entry still fail, and an entry that imports successfully reports a stale exemption. This preserves the import sweep without requiring a browser-only component library to load its stylesheet under bare Node.

## Alternatives considered

- Increase production timeouts or add test retries: neither establishes which operation completed, and both change behavior unrelated to the failing assertion.
- Replace the local deadline with a larger constant: this still overrides future lane budgets and leaves correctness dependent on host speed.
- Accept HTTP 202 or process startup as success: neither proves the expected model request or command output.
- Serialize the coverage or browser suite: the failures do not establish a shared-resource collision requiring suite-wide exclusion.

## Consequences

A controlled pause before Workspace creation reproduces the reference assertion with the original polling wait. Releasing the barrier and awaiting the request passes the same browser expectations without rewriting goldens. These controls prove the synchronization defect; they do not measure historical runner contention. Product behavior, production timing, and CI scheduling remain unchanged.
