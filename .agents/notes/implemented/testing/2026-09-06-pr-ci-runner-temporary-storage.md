# Agent Note: runner-owned temporary storage for PR CI

Status: implemented

English | [中文](2026-09-06-pr-ci-runner-temporary-storage.zh.md)

## Problem

The Linux failover pool runs multiple runner instances on one VM. PR coverage and snapshot processes use the operating-system temporary directory for transformed modules and fixtures. Files outside the runner's temporary directory escape its job cleanup, including when cancellation prevents process-level disposal. Exhausting that shared directory makes unrelated PRs fail before tests execute.

## Decision

The static, coverage, and consumer jobs in [PR CI](../../../../.github/workflows/ci.yml) export `TMPDIR=runner.temp` through `GITHUB_ENV` in their first step before any setup or test process starts. Node, Vite, tsx, and temporary test consumers inherit the runner-owned location. Each runner owns its directory and GitHub Actions clears its removable contents at job start and completion; fixtures still allocate unique children and retain their own cleanup.

The three workers also set `npm_config_cache` to `runner.temp/npm-cache`. The [release workflows](../../../../.github/workflows/release.yml) apply the same cache location in their existing temporary-storage setup, including [vendor rehearsals](../../../../.github/workflows/release-vendor.yml). npm otherwise caches registry responses under the shared home directory regardless of `TMPDIR`; a temporary consumer alone does not isolate those writes. The persistent pnpm store is unchanged.

The [release rehearsal decision](../process/2026-09-06-release-rehearsal-selfhosted.md) applies the same lifetime rule to release consumers. The [failover runbook](../process/2026-07-26-ci-failover-runbook.md) continues to own runner selection and shared-host capacity. This change does not retarget jobs, reduce concurrency, retry tests, change assertions, or modify master-only CI.

## Recorded ACP completion order

The [ACP diagnostic scenario](../../../../snapshots/session/subagent-acp-diagnostic/cordis.snapshot.yml) holds its scripted background response until `job_output` owns the completion wait. Without that synchronization, a fast child can publish a legitimate job notice between the recorded parent steps. A scenario-local wrapper releases the child after the jobs service registers the completion waiter; the mock watches an exclusive marker in the private test workspace and closes the watcher after release. The fixture restores the wrapped method on disposal. The recorded Session bytes and production job-notice behavior stay unchanged.

## Alternatives considered

**Delete shared temporary files from a PR job.** Another runner may still own those files. Repository jobs must not reclaim a shared directory by pathname or age.

**Retry tests or enlarge timeouts.** Neither recovers storage or gives residual files a cleanup owner.

**Switch every job to hosted runners.** This avoids the affected VM but leaves the failover path defective and changes the operator's independent pool selection.

## Consequences

Output honoring these temporary-directory and cache settings follows the job lifetime instead of accumulating in unmanaged host storage. This does not reclaim existing shared temporary files, guarantee filesystem capacity, or clean files the runner account cannot remove. Operators still own historical residue, disk provisioning, and jobs outside this PR workflow.

Linux bwrap and Landlock workspace-write profiles grant literal `/tmp` and the workspace, not an inherited `TMPDIR` outside it; confined fixtures must place temporary writes in those granted paths. The [snapshot spill helper](../../../../packages/test-support/session-snapshot/src/harness.ts) also uses literal `/tmp/dsh-acp-snap-*` on POSIX for stable path lengths, so that output remains outside runner cleanup. This workflow change neither widens sandbox grants nor rewrites fixed-path fixtures.

The parsed-workflow cases in [ci-workflow.spec.ts](../../../../scripts/ci-workflow.spec.ts) require the assignment on all three workers and reject step-level overrides. They fail against the unmodified workflow. Independent-process smoke checks and repeated PR runs validate the actual tooling; the YAML assertions alone do not prove host capacity.
