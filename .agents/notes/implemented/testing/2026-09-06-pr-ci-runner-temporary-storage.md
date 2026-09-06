# Agent Note: runner-owned temporary storage for PR CI

Status: implemented

English | [中文](2026-09-06-pr-ci-runner-temporary-storage.zh.md)

## Problem

The Linux failover pool runs multiple runner instances on one VM. PR coverage and snapshot processes use the operating-system temporary directory for transformed modules and fixtures. Files outside the runner's temporary directory escape its job cleanup, including when cancellation prevents process-level disposal. Exhausting that shared directory makes unrelated PRs fail before tests execute.

## Decision

The static, coverage, and consumer jobs in [PR CI](../../../../.github/workflows/ci.yml) export `TMPDIR=runner.temp` through `GITHUB_ENV` in their first step before any setup or test process starts. Node, Vite, tsx, and temporary test consumers inherit the runner-owned location. Each runner owns its directory and GitHub Actions clears its removable contents at job start and completion; fixtures still allocate unique children and retain their own cleanup.

The [release rehearsal decision](../process/2026-09-06-release-rehearsal-selfhosted.md) applies the same lifetime rule to release consumers. The [failover runbook](../process/2026-07-26-ci-failover-runbook.md) continues to own runner selection and shared-host capacity. This change does not retarget jobs, reduce concurrency, retry tests, change assertions, or modify master-only CI.

## Alternatives considered

**Delete shared temporary files from a PR job.** Another runner may still own those files. Repository jobs must not reclaim a shared directory by pathname or age.

**Retry tests or enlarge timeouts.** Neither recovers storage or gives residual files a cleanup owner.

**Switch every job to hosted runners.** This avoids the affected VM but leaves the failover path defective and changes the operator's independent pool selection.

## Consequences

Temporary output follows the job lifetime instead of accumulating in unmanaged host storage. This does not reclaim existing shared temporary files, guarantee filesystem capacity, or clean files the runner account cannot remove. Operators still own historical residue, disk provisioning, and jobs outside this PR workflow.

The parsed-workflow cases in [ci-workflow.spec.ts](../../../../scripts/ci-workflow.spec.ts) require the assignment on all three workers and reject step-level overrides. They fail against the unmodified workflow. Independent-process smoke checks and repeated PR runs validate the actual tooling; the YAML assertions alone do not prove host capacity.
