# Agent Note: Oxlint contract cases that spawn a process carry a 90 s ceiling

Status: implemented

English | [中文](2026-09-27-oxlint-contract-spawn-case-budgets.zh.md)

## Problem

Twelve of the fourteen cases in [`scripts/oxlint-contract.spec.ts`](../../../../scripts/oxlint-contract.spec.ts) spawn a real child process: `runOxlint` starts the oxlint CLI, and `runRepositoryOxlint` boots [`scripts/run-oxlint.ts`](../../../../scripts/run-oxlint.ts) under tsx, which runs oxlint and, after `--fix`, runs it once more. The root `vitest.config.ts` sets no `testTimeout`, so a case without its own budget inherits Vitest's 5000 ms default; only the coverage lanes raise it through `DSH_COVERAGE_TEST_TIMEOUT_MS=90000`, and the `unit tests (darwin parity, macos-latest)` job in `sandbox.yml` runs `pnpm run test` plain. Nine cases carried an explicit `90_000` since the contended Windows spawn budgets (#3115) were aligned to that value; five ran on the default. Two runner classes exposed it: the self-hosted Windows pool, where process creation spikes to several seconds (#2581), and the hosted macos-latest runner of Sandbox run 36332053320, which ran the whole file 2.2× slower than the passing run 36320394290 and timed out `prints only the final diagnostics when a fix retry still fails` at 6309 ms, a case that took 1122 ms on the passing run. `Test timed out in 5000ms` names neither a contract violation nor the spawn that overran.

## Decision

Every case in the file that spawns oxlint or the repository lint entrypoint carries the same explicit per-case `90_000` ceiling. The two configuration-only cases, `keeps the complete stylistic contract in Oxlint` and `keeps repository lint workflows Oxlint-only`, spawn nothing and keep the default. The value is a completion ceiling for a hang, not a latency target: the slowest case on the slow darwin runner took 9507 ms, and the file under six-fold CPU oversubscription on a 12-core host peaked at 20767 ms, both under a quarter of the ceiling. Assertions, the absence of retries, and Vitest's global `testTimeout` are unchanged.

## Alternatives considered

**A `describe`-level `{ timeout: 90_000 }`.** Rejected: a `describe` value overrides the lane's `--testTimeout` instead of yielding to it (#2677), and the file would then carry two budget styles, per-case on the nine cases already bounded and suite-level on the rest. Per-case values keep one style and one place to read each case's ceiling.

**Raising Vitest's global `testTimeout`.** Rejected: the whole unit inventory runs on the default; widening it to absorb one file's process spawns removes the hang detection the default provides everywhere else.

**A tighter value sized to the observed 6.3 s.** Rejected: the Windows contention fires as multi-second spikes that rotated across cases under 15–30 s budgets before the 90 s alignment; a smaller number moves the flake rather than removing it.

## Consequences

A contract violation still fails through its own assertion well inside the ceiling; each case's assertions settle in 0.5–1.8 s on an idle host, so only a genuine hang waits the full 90 s. The Windows self-hosted lane, the Linux coverage lanes, and the darwin parity job read the same ceiling for this file regardless of `DSH_COVERAGE_TEST_TIMEOUT_MS`. Under 72 busy-loop processes on a 12-core host the unbounded fix-retry case reproduced `Test timed out in 5000ms` at 7084 ms before the change and passes with the ceiling after it.
